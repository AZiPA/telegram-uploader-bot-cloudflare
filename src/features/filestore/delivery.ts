import { Composer } from "grammy";
import { Bundle, BundleItem, BundleRow, Env, MyContext } from "../../core/types";
import { ACTIONS, LIMITS, QUOTA_CACHE_CONFIG, getDynamicConfig } from "../../config";
import { t } from "../../locales";
import { ButtonFactory } from "../../shared/buttons";
import { escapeHtml, parseBundleItems, configuredChatId } from "../../shared/formatters";
import { checkUserMembership } from "../force_join/service";
import { logger, isD1FreeTierError, handleD1FreeTierError, LoggerService } from "../../core/logger";
import { deleteBundleRecords } from "../bundles/deletion";
import { setCappedMap, sha256Hex } from "../../shared/crypto";

export const deliveryComposer = new Composer<MyContext>();

export const quotaExhaustedCache = new Map<number, number>();
const passcodeStrikeMap = new Map<number, { fails: number; mutedUntil: number }>();

function notifyStorageForbidden(ctx: MyContext, err: unknown): void {
  const detail = `${(err as { description?: string }).description || ""} ${(err as { message?: string }).message || ""}`.trim();
  LoggerService.alert(
    ctx.api,
    ctx.env,
    ctx.executionCtx,
    "storage_forbidden",
    `🚨 <b>[STORAGE CHANNEL]</b>\n<blockquote expandable>${escapeHtml(detail.slice(0, 800)) || "403 while copying from the storage channel"}</blockquote>`
  );
}

type DeliveryHalt = "blocked" | "forbidden" | "flood" | null;

export function isQuotaExhaustedInMemory(userId: number, env?: Env): boolean {
  if (env?.ENABLE_QUOTA_CACHE === "false" || !QUOTA_CACHE_CONFIG.enabled) {
    return false;
  }
  const expiry = quotaExhaustedCache.get(userId);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    quotaExhaustedCache.delete(userId);
    return false;
  }
  return true;
}

export function markQuotaExhaustedInMemory(userId: number, ctx: MyContext): void {
  if (ctx.env?.ENABLE_QUOTA_CACHE === "false" || !QUOTA_CACHE_CONFIG.enabled) {
    return;
  }
  const now = Date.now();
  if (quotaExhaustedCache.size >= QUOTA_CACHE_CONFIG.maxEntries && !quotaExhaustedCache.has(userId)) {
    const oldestKey = quotaExhaustedCache.keys().next().value;
    if (oldestKey !== undefined) {
      quotaExhaustedCache.delete(oldestKey);
    }

    LoggerService.alert(
      ctx.api,
      ctx.env,
      ctx.executionCtx,
      "quota_cache_capacity",
      `⚠️ <b>[QUOTA CACHE]</b>\n<blockquote expandable>In-memory quota cache reached ${QUOTA_CACHE_CONFIG.maxEntries} entries. The oldest hint was evicted.</blockquote>`,
      { cooldownMs: QUOTA_CACHE_CONFIG.alertCooldownMs }
    );
  }
  const nextUtcMidnight = new Date(now).setUTCHours(24, 0, 0, 0);
  const expiry = Math.min(now + QUOTA_CACHE_CONFIG.ttlMs, nextUtcMidnight);
  quotaExhaustedCache.set(userId, expiry);
}

function classifyDeliveryError(err: unknown): DeliveryHalt {
  const e = err as { error_code?: number; description?: string; message?: string };
  const text = `${e.description || ""} ${e.message || ""}`.toLowerCase();
  if (e.error_code === 403) {
    if (text.includes("bot was blocked by the user")) return "blocked";
    return "forbidden";
  }
  if (e.error_code === 429 || text.includes("too many requests") || text.includes("retry after") || text.includes("retry_after")) {
    return "flood";
  }
  return null;
}

async function sendBundleItem(
  ctx: MyContext,
  chatId: number,
  item: BundleItem,
  protectContent: boolean
): Promise<number> {
  const options = { protect_content: protectContent };
  try {
    let res;
    switch (item.type) {
      case "video":
        res = await ctx.api.sendVideo(chatId, item.file_id, options);
        break;
      case "audio":
        res = await ctx.api.sendAudio(chatId, item.file_id, options);
        break;
      case "photo":
        res = await ctx.api.sendPhoto(chatId, item.file_id, options);
        break;
      case "animation":
        res = await ctx.api.sendAnimation(chatId, item.file_id, options);
        break;
      case "voice":
        res = await ctx.api.sendVoice(chatId, item.file_id, options);
        break;
      case "document":
      default:
        res = await ctx.api.sendDocument(chatId, item.file_id, options);
        break;
    }
    return res.message_id;
  } catch (err: unknown) {
    if (classifyDeliveryError(err)) throw err;

    if (item.storage_message_id && configuredChatId(ctx.env?.STORAGE_CHANNEL_ID)) {
      logger.warn(
        `[DELIVERY FALLBACK] Primary delivery failed for item ${item.file_unique_id || item.file_id}. Executing storage channel fallback via message ${item.storage_message_id}:`,
        err
      );
      try {
        const copied = await ctx.api.copyMessage(
          chatId,
          configuredChatId(ctx.env.STORAGE_CHANNEL_ID)!,
          item.storage_message_id,
          options
        );
        return copied.message_id;
      } catch (fallbackErr: unknown) {
        if (classifyDeliveryError(fallbackErr) === "forbidden") notifyStorageForbidden(ctx, fallbackErr);
        throw fallbackErr;
      }
    }
    throw err;
  }
}

function storageIdsForChunk(items: BundleItem[]): number[] | null {
  const ids: number[] = [];
  for (const item of items) {
    if (typeof item.storage_message_id !== "number") return null;
    ids.push(item.storage_message_id);
  }
  return ids.length > 0 ? ids : null;
}

async function deliverChunk(
  ctx: MyContext,
  chatId: number,
  items: BundleItem[],
  protectContent: boolean
): Promise<{ sentIds: number[]; error?: unknown }> {
  const storageId = configuredChatId(ctx.env?.STORAGE_CHANNEL_ID);
  const storageIds = storageIdsForChunk(items);

  if (storageId && storageIds && storageIds.length === items.length) {
    try {
      const copied = await ctx.api.copyMessages(chatId, storageId, storageIds, {
        protect_content: protectContent,
      });
      if (copied.length !== items.length) {
        LoggerService.alert(
          ctx.api,
          ctx.env,
          ctx.executionCtx,
          "storage_partial",
          `⚠️ <b>[STORAGE CHANNEL]</b>\n<blockquote expandable>copyMessages partial delivery: expected ${items.length}, got ${copied.length}.</blockquote>`
        );
        if (copied.length > 0) {
          return { sentIds: copied.map((row) => row.message_id) };
        }
      } else {
        return { sentIds: copied.map((row) => row.message_id) };
      }
    } catch (err: unknown) {
      const halt = classifyDeliveryError(err);
      // 403 from the storage channel must not drop the file. file_id still works.
      // A user-block or a flood stays fatal: retrying those spends the subrequest budget.
      if (halt === "forbidden") {
        notifyStorageForbidden(ctx, err);
        logger.warn("[DELIVERY] copyMessages returned 403; falling back to file_id:", err);
      } else if (halt) {
        return { sentIds: [], error: err };
      } else {
        logger.warn("[DELIVERY] copyMessages failed; falling back to per-item send:", err);
      }
    }
  }

  const sent: number[] = [];
  for (const item of items) {
    try {
      sent.push(await sendBundleItem(ctx, chatId, item, protectContent));
    } catch (err: unknown) {
      return { sentIds: sent, error: err };
    }
  }
  return { sentIds: sent };
}

async function rollbackDownload(
  ctx: MyContext,
  userId: number,
  code: string,
  todayDate: string
): Promise<void> {
  await ctx.env.DB.prepare(
    "UPDATE user_downloads SET download_count = MAX(0, download_count - 1) " +
    "WHERE user_id = ? AND code = ? AND access_date = ?"
  ).bind(userId, code, todayDate).run().catch(() => {});
}

export async function executeDelivery(
  ctx: MyContext,
  code: string,
  skipMembershipCheck = false,
  offset = 0,
  providedPin?: string
): Promise<boolean> {
  const userId = ctx.from!.id;
  const lang = ctx.lang || "en";

  if (offset < 0 || offset % LIMITS.CHUNK_DELIVERY_SIZE !== 0) {
    await ctx.reply(t(lang, "file_not_found"));
    return false;
  }

  if (ctx.chat?.type !== "private") {
    await ctx.reply(t(lang, "private_only"));
    return false;
  }

  if (offset === 0 && !ctx.isOwner && isQuotaExhaustedInMemory(userId, ctx.env)) {
    await ctx.reply(t(lang, "limit_daily"));
    return false;
  }

  let row: BundleRow | null = null;
  try {
    row = await ctx.env.DB.prepare(
      "SELECT code, title, items, created_by, protect_content, created_at, owner_locked, expires_at, is_one_time, consumed_by, passcode_hash, post_channel_id, post_message_id, rotate_interval_sec, last_rotated_at FROM bundles WHERE code = ?"
    ).bind(code).first<BundleRow>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return false;
    }
    throw err;
  }

  if (!row) {
    await ctx.reply(t(lang, "file_not_found"));
    return false;
  }

  const bundle: Bundle = {
    ...row,
    items: parseBundleItems(row.items)
  };

  const allItems = bundle.items;
  const totalFiles = allItems.length;

  if (totalFiles === 0) {
    if (row.items.trim() === "[]") {
      await deleteBundleRecords(ctx, code);
    } else {
      logger.error(`[DELIVERY] Malformed/corrupt items JSON detected for bundle ${code}; skipping deletion to prevent data loss.`);
    }
    await ctx.reply(t(lang, "file_not_found"));
    return false;
  }

  const todayDate = new Date().toISOString().slice(0, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1. Expiry Check (0 writes)
  if (row.expires_at && row.expires_at > 0 && nowSec >= row.expires_at) {
    await ctx.reply(t(lang, "bundle_expired"));
    return false;
  }

  const isAdminTest = Boolean(ctx.isAdmin && skipMembershipCheck && offset === 0 && !providedPin);

  // 2. Passcode Check (0 writes)
  if (row.passcode_hash && !isAdminTest) {
    const strikeEntry = passcodeStrikeMap.get(userId);
    if (strikeEntry && Date.now() < strikeEntry.mutedUntil) {
      const waitMin = Math.max(1, Math.ceil((strikeEntry.mutedUntil - Date.now()) / 60000));
      await ctx.reply(t(lang, "passcode_locked_out", { min: waitMin }));
      return false;
    }

    if (!providedPin) {
      await ctx.reply(t(lang, "passcode_prompt", { code: bundle.code }), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      });
      return false;
    }

    const computedHash = await sha256Hex(`${bundle.code}:${providedPin}`);
    if (computedHash !== row.passcode_hash) {
      const fails = (strikeEntry?.fails || 0) + 1;
      if (fails >= 5) {
        setCappedMap(passcodeStrikeMap, userId, { fails, mutedUntil: Date.now() + 30 * 60_000 }, 2000);
        LoggerService.alert(
          ctx.api,
          ctx.env,
          ctx.executionCtx,
          `pass_brute_${userId}`,
          `🚨 <b>[PASSCODE BRUTE-FORCE]</b>\n<blockquote expandable>User <code>${userId}</code> reached 5 failed passcode attempts on bundle <code>${bundle.code}</code>. Locked out for 30 minutes.</blockquote>`
        );
        await ctx.reply(t(lang, "passcode_locked_out", { min: 30 }));
      } else {
        setCappedMap(passcodeStrikeMap, userId, { fails, mutedUntil: 0 }, 2000);
        await ctx.reply(t(lang, "passcode_wrong"));
      }
      return false;
    }

    passcodeStrikeMap.delete(userId);
  }

  // 3. One-Time Claim Check
  if (row.is_one_time === 1 && !isAdminTest && offset === 0) {
    const claimRes = await ctx.env.DB.prepare(
      "UPDATE bundles SET consumed_by = ?, expires_at = CASE WHEN expires_at > 0 AND expires_at < ? THEN expires_at ELSE ? END WHERE code = ? AND (consumed_by = 0 OR consumed_by = ?)"
    ).bind(userId, nowSec + 900, nowSec + 900, bundle.code, userId).run();

    if (claimRes.meta?.changes === 0) {
      await ctx.reply(t(lang, "bundle_already_used"));
      return false;
    }
  }

  let downloadRecorded = false;

  if (offset > 0 && !ctx.isOwner) {
    if (!skipMembershipCheck && !ctx.isAdmin) {
      const membership = await checkUserMembership(ctx.api, ctx.env, userId);
      if (!membership.ok) {
        const customVerifyBtn = await getDynamicConfig(ctx.env, "cfg_fj_verify_btn", t(lang, "btn_verify_join"));
        await ctx.reply(
          `<blockquote>${t(lang, "force_join_title")}</blockquote>\n\n${t(lang, "force_join_desc")}`,
          {
            parse_mode: "HTML",
            reply_markup: ButtonFactory.forceJoinKeyboard(membership.missing, lang, code, customVerifyBtn)
          }
        );
        return false;
      }
    }

    let dlRecord: { download_count: number } | null = null;
    try {
      dlRecord = await ctx.env.DB.prepare(
        "SELECT download_count FROM user_downloads WHERE user_id = ? AND code = ? AND access_date = ?"
      ).bind(userId, code, todayDate).first<{ download_count: number }>();
    } catch (err: unknown) {
      if (isD1FreeTierError(err)) {
        await handleD1FreeTierError(ctx, err);
        return false;
      }
      throw err;
    }

    if ((!dlRecord || dlRecord.download_count <= 0) && !ctx.isAdmin) {
      return executeDelivery(ctx, code, false, 0);
    }
  }

  if (offset === 0) {
    if (!skipMembershipCheck && !ctx.isAdmin) {
      const membership = await checkUserMembership(ctx.api, ctx.env, userId);
      if (!membership.ok) {
        const customVerifyBtn = await getDynamicConfig(ctx.env, "cfg_fj_verify_btn", t(lang, "btn_verify_join"));
        await ctx.reply(
          `<blockquote>${t(lang, "force_join_title")}</blockquote>\n\n${t(lang, "force_join_desc")}`,
          {
            parse_mode: "HTML",
            reply_markup: ButtonFactory.forceJoinKeyboard(membership.missing, lang, code, customVerifyBtn)
          }
        );
        return false;
      }
    }

    if (!ctx.isOwner) {
      let maxDaily = parseInt(await getDynamicConfig(ctx.env, "daily_download_limit", String(LIMITS.DEFAULT_DAILY_DOWNLOADS)), 10);
      let maxLinkDl = parseInt(await getDynamicConfig(ctx.env, "file_daily_limit", String(LIMITS.DEFAULT_FILE_DAILY_LIMIT)), 10);

      if (ctx.role === "vip") {
        maxDaily = maxDaily * 5;
        maxLinkDl = maxLinkDl * 3;
      } else if (ctx.isAdmin) {
        maxDaily = 150;
        maxLinkDl = 20;
      }

      let quotaSnapshot: { daily_count: number; link_count: number } | null = null;
      try {
        quotaSnapshot = await ctx.env.DB.prepare(
          "SELECT " +
          "COALESCE((SELECT SUM(download_count) FROM user_downloads WHERE user_id = ? AND access_date = ?), 0) AS daily_count, " +
          "COALESCE((SELECT download_count FROM user_downloads WHERE user_id = ? AND code = ? AND access_date = ?), 0) AS link_count"
        ).bind(userId, todayDate, userId, code, todayDate).first<{ daily_count: number; link_count: number }>();
      } catch (err: unknown) {
        if (isD1FreeTierError(err)) {
          await handleD1FreeTierError(ctx, err);
          return false;
        }
        throw err;
      }

      if ((quotaSnapshot?.daily_count ?? 0) >= maxDaily) {
        markQuotaExhaustedInMemory(userId, ctx);
        await ctx.reply(t(lang, "limit_daily"));
        return false;
      }

      if ((quotaSnapshot?.link_count ?? 0) >= maxLinkDl) {
        await ctx.reply(t(lang, "limit_link"));
        return false;
      }

      try {
        const insertRes = await ctx.env.DB.prepare(
          `INSERT INTO user_downloads (user_id, code, access_date, download_count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(user_id, code, access_date)
           DO UPDATE SET download_count = download_count + 1
           WHERE download_count < ?`
        ).bind(userId, code, todayDate, maxLinkDl).run();

        if (insertRes.meta?.changes === 0) {
          await ctx.reply(t(lang, "limit_link"));
          return false;
        }
        downloadRecorded = true;
      } catch (err: unknown) {
        const message = String((err as { message?: string })?.message || err).toLowerCase();
        if (message.includes("daily_download_limit")) {
          markQuotaExhaustedInMemory(userId, ctx);
          await ctx.reply(t(lang, "limit_daily"));
          return false;
        }
        if (isD1FreeTierError(err)) {
          await handleD1FreeTierError(ctx, err);
          return false;
        }
        throw err;
      }
    }
  }

  const currentChunk = allItems.slice(offset, offset + LIMITS.CHUNK_DELIVERY_SIZE);

  if (currentChunk.length === 0) {
    await ctx.reply(t(lang, "file_not_found"));
    return false;
  }

  const globalProtect = await getDynamicConfig(ctx.env, "global_protect_content", "0");
  const isProtected = globalProtect === "1" || Boolean(bundle.protect_content);

  const { sentIds, error: deliveryErr } = await deliverChunk(ctx, ctx.chat!.id, currentChunk, isProtected);

  if (deliveryErr) {
    const decision = classifyDeliveryError(deliveryErr);
    const errMsg = `${(deliveryErr as { description?: string; message?: string })?.description || ""} ${(deliveryErr as { message?: string })?.message || ""}`.toLowerCase();
    const errCode = (deliveryErr as { error_code?: number })?.error_code;

    if (sentIds.length > 0) {
      ctx.executionCtx.waitUntil(
        (async () => {
          const autoDeleteSec = parseInt(await getDynamicConfig(ctx.env, "auto_delete_seconds", "0"), 10);
          if (autoDeleteSec > 0) {
            const deleteAt = nowSec + autoDeleteSec;
            await ctx.env.DB.prepare(
              "INSERT INTO deletion_queue (chat_id, message_ids, delete_at) VALUES (?, ?, ?)"
            ).bind(ctx.chat!.id, JSON.stringify(sentIds), deleteAt).run().catch((err) => {
              logger.error("Failed to insert into deletion_queue:", err);
            });
          }
        })().catch((err) => {
          logger.error("Delivery post-processing error:", err);
        })
      );
    } else if (downloadRecorded && decision !== "blocked") {
      await rollbackDownload(ctx, userId, code, todayDate);
    }

    if (sentIds.length === 0 && decision !== "blocked" && row.is_one_time === 1 && !isAdminTest && offset === 0) {
      await ctx.env.DB.prepare(
        "UPDATE bundles SET consumed_by = 0, expires_at = ? WHERE code = ? AND consumed_by = ?"
      ).bind(row.expires_at || 0, bundle.code, userId).run().catch(() => {});
    }

    if (decision === "blocked" || decision === "forbidden") {
      return false;
    }

    if (decision === "flood") {
      await ctx.reply(t(lang, "delivery_busy")).catch(() => {});
      return false;
    }

    if (errCode === 400 && (errMsg.includes("file not found") || errMsg.includes("chat not found"))) {
      await ctx.reply(t(lang, "file_not_found")).catch(() => {});
      return false;
    }

    await ctx.reply(t(lang, "delivery_busy")).catch(() => {});
    return false;
  }

  ctx.executionCtx.waitUntil(
    (async () => {
      if (offset === 0) {
        if (ctx.env.FILESTORE_ANALYTICS) {
          ctx.env.FILESTORE_ANALYTICS.writeDataPoint({
            blobs: [code, bundle.title || "untitled", ctx.role],
            doubles: [1],
            indexes: [String(userId)]
          });
        }
      }
      const autoDeleteSec = parseInt(await getDynamicConfig(ctx.env, "auto_delete_seconds", "0"), 10);
      if (autoDeleteSec > 0 && sentIds.length > 0) {
        const deleteAt = nowSec + autoDeleteSec;
        await ctx.env.DB.prepare(
          "INSERT INTO deletion_queue (chat_id, message_ids, delete_at) VALUES (?, ?, ?)"
        ).bind(ctx.chat!.id, JSON.stringify(sentIds), deleteAt).run().catch((err) => {
          logger.error("Failed to insert into deletion_queue:", err);
        });
      }
    })().catch((err) => {
      logger.error("Delivery post-processing error:", err);
    })
  );

  const nextOffset = offset + LIMITS.CHUNK_DELIVERY_SIZE;
  const hasMore = nextOffset < totalFiles;
  const isOneTimeFinal = Boolean(row.is_one_time === 1 && !isAdminTest && !hasMore);

  if (isOneTimeFinal && sentIds.length > 0) {
    await deleteBundleRecords(ctx, bundle.code);
  }

  const isAdmin = ctx.isAdmin;
  const enableVoting = !isProtected && !hasMore && !isOneTimeFinal;

  let voteLikes = 0;
  let voteDislikes = 0;
  if (enableVoting) {
    const voteCounts = await ctx.env.DB.prepare(
      "SELECT " +
      "COALESCE(SUM(CASE WHEN vote_type = 'like' THEN 1 ELSE 0 END), 0) AS likes, " +
      "COALESCE(SUM(CASE WHEN vote_type = 'dislike' THEN 1 ELSE 0 END), 0) AS dislikes " +
      "FROM bundle_votes WHERE code = ?"
    ).bind(code).first<{ likes: number; dislikes: number }>();
    voteLikes = voteCounts?.likes || 0;
    voteDislikes = voteCounts?.dislikes || 0;
  }

  const remaining = totalFiles - nextOffset;
  const nextCount = Math.min(LIMITS.CHUNK_DELIVERY_SIZE, remaining);
  const kb = ButtonFactory.deliveryKeyboard(
    lang,
    code,
    voteLikes,
    voteDislikes,
    enableVoting,
    isAdmin,
    isProtected,
    hasMore ? { count: nextCount, offset: nextOffset } : null,
    isOneTimeFinal
  );

  const currentPartNum = Math.floor(offset / LIMITS.CHUNK_DELIVERY_SIZE) + 1;
  const totalParts = Math.ceil(totalFiles / LIMITS.CHUNK_DELIVERY_SIZE);
  const partText = totalParts > 1 ? t(lang, "delivery_part_info", { part: currentPartNum, total: totalParts }) : "";
  const titleText = bundle.title ? `\n🏷 <b>${escapeHtml(bundle.title)}</b>` : "";

  await ctx.reply(
    `<blockquote>${t(lang, "delivered_title")}</blockquote>${titleText}${partText}\n${t(lang, "delivery_files_count", { count: currentChunk.length })}`,
    { parse_mode: "HTML", reply_markup: kb, protect_content: isProtected }
  );

  return true;
}

deliveryComposer.callbackQuery(new RegExp(`^${ACTIONS.CHUNK_DELIVERY}([a-zA-Z0-9_-]{8,36}):(\\d+)$`), async (ctx) => {
  const code = ctx.match[1];
  const nextOffset = Number(ctx.match[2]);
  const originalMarkup = ctx.callbackQuery.message?.reply_markup;

  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: ButtonFactory.empty() }).catch(() => {});

  try {
    const success = await executeDelivery(ctx, code, true, nextOffset);
    if (!success && originalMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: originalMarkup }).catch(() => {});
    }
  } catch (err) {
    if (originalMarkup) {
      await ctx.editMessageReplyMarkup({ reply_markup: originalMarkup }).catch(() => {});
    }
  }
});

deliveryComposer.callbackQuery(new RegExp(`^${ACTIONS.REDOWNLOAD}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await executeDelivery(ctx, ctx.match[1], false, 0);
});

deliveryComposer.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.text) return next();

  const match = /#UNLOCK_BUNDLE#([a-zA-Z0-9_-]{8,36})#/.exec(replyTo.text);
  if (!match) return next();

  const code = match[1];
  const pin = ctx.message.text.trim();
  if (["/cancel", "cancel"].includes(pin.toLowerCase())) {
    await ctx.reply(t(ctx.lang, "operation_cancelled"));
    return;
  }

  await executeDelivery(ctx, code, false, 0, pin);
});