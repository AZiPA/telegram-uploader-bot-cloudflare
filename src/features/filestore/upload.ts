import { Composer } from "grammy";
import { Message } from "grammy/types";
import { BundleItem, BundleRow, MyContext } from "../../core/types";
import { generateBase62Code, setCappedMap } from "../../shared/crypto";
import { parseBundleItems, getBotUsername, escapeHtml, configuredChatId } from "../../shared/formatters";
import { LIMITS, getDynamicConfig } from "../../config";
import { logger, LoggerService, isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const uploadComposer = new Composer<MyContext>();
const privileged = uploadComposer.filter((ctx) => ctx.isAdmin);

const SESSION_TIMEOUT_SEC = 600;
const noSessionWarningCooldown = new Map<number, number>();

export function extractBundleItem(msg: Message): BundleItem | null {
  if (msg.document) {
    return {
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      type: "document",
      file_name: msg.document.file_name,
      file_size: msg.document.file_size,
      mime_type: msg.document.mime_type,
    };
  }
  if (msg.video) {
    return {
      file_id: msg.video.file_id,
      file_unique_id: msg.video.file_unique_id,
      type: "video",
      file_name: msg.video.file_name,
      file_size: msg.video.file_size,
      mime_type: msg.video.mime_type,
    };
  }
  if (msg.audio) {
    return {
      file_id: msg.audio.file_id,
      file_unique_id: msg.audio.file_unique_id,
      type: "audio",
      file_name: msg.audio.file_name,
      file_size: msg.audio.file_size,
      mime_type: msg.audio.mime_type,
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    return {
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      type: "photo",
      file_size: photo.file_size,
    };
  }
  if (msg.animation) {
    return {
      file_id: msg.animation.file_id,
      file_unique_id: msg.animation.file_unique_id,
      type: "animation",
      file_name: msg.animation.file_name,
      file_size: msg.animation.file_size,
      mime_type: msg.animation.mime_type,
    };
  }
  if (msg.voice) {
    return {
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      type: "voice",
      file_size: msg.voice.file_size,
      mime_type: msg.voice.mime_type,
    };
  }
  return null;
}

export async function cleanupAbandonedSession(ctx: MyContext, adminId: number): Promise<void> {
  await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(adminId).run();
}

async function getActiveSession(ctx: MyContext, adminId: number, nowSec: number) {
  const session = await ctx.env.DB.prepare(
    "SELECT admin_id, code, mode, items, updated_at FROM admin_sessions WHERE admin_id = ?"
  ).bind(adminId).first<{ admin_id: number; code: string; mode: string; items: string; updated_at: number }>();

  if (!session) return null;

  if (nowSec - session.updated_at > SESSION_TIMEOUT_SEC) {
    await cleanupAbandonedSession(ctx, adminId);
    return null;
  }

  return session;
}

privileged.command("upload", async (ctx) => {
  const adminId = ctx.from!.id;
  await cleanupAbandonedSession(ctx, adminId);

  const nowSec = Math.floor(Date.now() / 1000);
  const code = generateBase62Code(8);

  await ctx.env.DB.prepare(
    "INSERT INTO admin_sessions (admin_id, code, mode, items, updated_at) VALUES (?, ?, 'upload', '[]', ?) " +
    "ON CONFLICT(admin_id) DO UPDATE SET code = excluded.code, mode = excluded.mode, items = excluded.items, updated_at = excluded.updated_at"
  ).bind(adminId, code, nowSec).run();

  await ctx.reply(t(ctx.lang, "upload_single_mode"), { parse_mode: "HTML" });
});

privileged.command("batch", async (ctx) => {
  const adminId = ctx.from!.id;
  await cleanupAbandonedSession(ctx, adminId);

  const nowSec = Math.floor(Date.now() / 1000);
  const code = generateBase62Code(8);

  await ctx.env.DB.prepare(
    "INSERT INTO admin_sessions (admin_id, code, mode, items, updated_at) VALUES (?, ?, 'batch', '[]', ?) " +
    "ON CONFLICT(admin_id) DO UPDATE SET code = excluded.code, mode = excluded.mode, items = excluded.items, updated_at = excluded.updated_at"
  ).bind(adminId, code, nowSec).run();

  await ctx.reply(t(ctx.lang, "upload_batch_mode", { max: LIMITS.MAX_PER_SESSION_UPLOAD }), { parse_mode: "HTML" });
});

privileged.command("done", async (ctx) => {
  const adminId = ctx.from!.id;
  const nowSec = Math.floor(Date.now() / 1000);

  const session = await getActiveSession(ctx, adminId, nowSec);
  if (!session) {
    return ctx.reply(t(ctx.lang, "no_active_session"));
  }

  if (session.mode === "batch") {
    const items = parseBundleItems(session.items);
    const total = items.length;

    if (total === 0) {
      await cleanupAbandonedSession(ctx, adminId);
      return ctx.reply(t(ctx.lang, "no_files_recorded"));
    }

    const defaultTtlSec = parseInt(await getDynamicConfig(ctx.env, "default_bundle_ttl_seconds", "0"), 10);
    const expiresAt = defaultTtlSec > 0 ? nowSec + defaultTtlSec : 0;

    // Atomic single-write persistence to bundles with code conflict retry
    let writeSucceeded = false;
    let finalCode = session.code;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ctx.env.DB.prepare(
          "INSERT INTO bundles (code, title, items, created_by, protect_content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(finalCode, null, JSON.stringify(items), adminId, 0, nowSec, expiresAt).run();
        writeSucceeded = true;
        break;
      } catch (err: unknown) {
        lastErr = err;
        if (isD1FreeTierError(err)) {
          break;
        }
        const msg = String((err as { message?: string })?.message || err);
        if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
          finalCode = generateBase62Code(8);
          continue;
        }
        break;
      }
    }

    if (!writeSucceeded) {
      if (isD1FreeTierError(lastErr)) {
        await handleD1FreeTierError(ctx, lastErr);
        return;
      }
      logger.error(`Failed to persist batch bundle for admin ${adminId}:`, lastErr);
      await ctx.reply(t(ctx.lang, "bundle_save_error"));
      return;
    }

    await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(adminId).run();

    const botUsername = getBotUsername(ctx);
    const link = `https://t.me/${botUsername}?start=${finalCode}`;

    await ctx.reply(
      t(ctx.lang, "bundle_finalized", { total, code: finalCode, link }),
      { parse_mode: "HTML" }
    );
    return;
  }

  if (session.mode === "edit") {
    const stagedItems = parseBundleItems(session.items);
    let writeSucceeded = stagedItems.length === 0;
    let lastErr: unknown = null;

    if (stagedItems.length > 0) {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
        }
        try {
          const bundleRow = await ctx.env.DB.prepare(
            "SELECT items FROM bundles WHERE code = ?"
          ).bind(session.code).first<{ items: string }>();

          if (!bundleRow) {
            await ctx.reply(t(ctx.lang, "bundle_not_found"));
            return;
          }

          const currentItems = parseBundleItems(bundleRow.items);
          if (currentItems.length >= LIMITS.MAX_BUNDLE_ITEMS || currentItems.length + stagedItems.length > LIMITS.MAX_BUNDLE_ITEMS) {
            await ctx.reply(t(ctx.lang, "upload_batch_limit", {
              maxSession: LIMITS.MAX_PER_SESSION_UPLOAD,
              maxTotal: LIMITS.MAX_BUNDLE_ITEMS
            }));
            return;
          }

          const merged = [...currentItems, ...stagedItems];
          const res = await ctx.env.DB.prepare(
            "UPDATE bundles SET items = ? WHERE code = ? AND items = ?"
          ).bind(JSON.stringify(merged), session.code, bundleRow.items).run();

          if (res.meta?.changes && res.meta.changes > 0) {
            writeSucceeded = true;
            break;
          }
        } catch (err: unknown) {
          lastErr = err;
          if (isD1FreeTierError(err)) {
            break;
          }
        }
      }

      if (!writeSucceeded) {
        if (isD1FreeTierError(lastErr)) {
          await handleD1FreeTierError(ctx, lastErr);
          return;
        }
        logger.error(`Failed to CAS update edit bundle for code ${session.code}:`, lastErr);
        await ctx.reply(t(ctx.lang, "bundle_save_error"));
        return;
      }
    }

    await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(adminId).run();

    const bundleRow = await ctx.env.DB.prepare(
      "SELECT * FROM bundles WHERE code = ?"
    ).bind(session.code).first<BundleRow>();

    const total = bundleRow ? parseBundleItems(bundleRow.items).length : 0;
    const botUsername = getBotUsername(ctx);
    const link = `https://t.me/${botUsername}?start=${session.code}`;

    await ctx.reply(
      t(ctx.lang, "bundle_finalized", { total, code: session.code, link }),
      { parse_mode: "HTML" }
    );
    return;
  }

  return ctx.reply(t(ctx.lang, "upload_single_mode"));
});

privileged.command("cancel", async (ctx) => {
  const adminId = ctx.from!.id;
  await cleanupAbandonedSession(ctx, adminId);
  await ctx.reply(t(ctx.lang, "operation_cancelled"));
});

privileged.on([":document", ":video", ":audio", ":photo", ":voice", ":animation"], async (ctx) => {
  const msg = ctx.message!;
  const adminId = ctx.from!.id;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  const session = await getActiveSession(ctx, adminId, nowSec);

  if (!session) {
    const lastWarn = noSessionWarningCooldown.get(adminId) || 0;
    if (now - lastWarn > 3000) {
      setCappedMap(noSessionWarningCooldown, adminId, now, 1000);
      await ctx.reply(
        t(ctx.lang, "no_session_warning", { max: LIMITS.MAX_PER_SESSION_UPLOAD }),
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  const item = extractBundleItem(msg);
  if (!item) return;

  const storageId = configuredChatId(ctx.env?.STORAGE_CHANNEL_ID);
  if (storageId) {
    try {
      const forwarded = await ctx.api.copyMessage(storageId, ctx.chat.id, msg.message_id);
      item.storage_message_id = forwarded.message_id;
    } catch (err: unknown) {
      const code = (err as { error_code?: number }).error_code;
      const detail = `${(err as { description?: string }).description || ""} ${(err as { message?: string }).message || ""}`.trim();
      if (code === 403 && !detail.toLowerCase().includes("bot was blocked by the user")) {
        LoggerService.alert(
          ctx.api,
          ctx.env,
          ctx.executionCtx,
          "storage_forbidden",
          `🚨 <b>[STORAGE CHANNEL]</b>\n<blockquote expandable>${escapeHtml(detail.slice(0, 800)) || "403 while copying into the storage channel"}</blockquote>`
        );
      } else {
        console.warn("Storage channel backup copyMessage warning:", err);
      }
    }
  }

  if (session.mode === "upload") {
    const defaultTtlSec = parseInt(await getDynamicConfig(ctx.env, "default_bundle_ttl_seconds", "0"), 10);
    const expiresAt = defaultTtlSec > 0 ? nowSec + defaultTtlSec : 0;

    // Single-write atomic persistence with code collision retry
    const finalItems = [item];
    let finalCode = session.code;
    let writeSucceeded = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ctx.env.DB.prepare(
          "INSERT INTO bundles (code, title, items, created_by, protect_content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(finalCode, null, JSON.stringify(finalItems), adminId, 0, nowSec, expiresAt).run();
        writeSucceeded = true;
        break;
      } catch (err: unknown) {
        lastErr = err;
        if (isD1FreeTierError(err)) {
          break;
        }
        const msg = String((err as { message?: string })?.message || err);
        if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
          finalCode = generateBase62Code(8);
          continue;
        }
        break;
      }
    }

    if (!writeSucceeded) {
      if (isD1FreeTierError(lastErr)) {
        await handleD1FreeTierError(ctx, lastErr);
        return;
      }
      logger.error(`Failed to persist single upload bundle for admin ${adminId}:`, lastErr);
      await ctx.reply(t(ctx.lang, "bundle_save_error"));
      return;
    }

    await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(adminId).run();

    const botUsername = getBotUsername(ctx);
    const link = `https://t.me/${botUsername}?start=${finalCode}`;

    await ctx.reply(t(ctx.lang, "upload_single_success", { link }), { parse_mode: "HTML" });
    return;
  }

  if (session.mode === "batch") {
    const maxAllowed = Math.min(LIMITS.MAX_PER_SESSION_UPLOAD, LIMITS.MAX_BUNDLE_ITEMS);
    let appendSuccess = false;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
      try {
        const curSession = await ctx.env.DB.prepare(
          "SELECT items FROM admin_sessions WHERE admin_id = ?"
        ).bind(adminId).first<{ items: string }>();

        if (!curSession) break;
        const items = parseBundleItems(curSession.items);

        if (items.length >= maxAllowed) {
          const lastWarn = noSessionWarningCooldown.get(adminId) || 0;
          if (now - lastWarn > 3000) {
            setCappedMap(noSessionWarningCooldown, adminId, now, 1000);
            await ctx.reply(t(ctx.lang, "upload_batch_limit", {
              maxSession: LIMITS.MAX_PER_SESSION_UPLOAD,
              maxTotal: LIMITS.MAX_BUNDLE_ITEMS
            }));
          }
          return;
        }

        items.push(item);
        const updateRes = await ctx.env.DB.prepare(
          "UPDATE admin_sessions SET items = ?, updated_at = ? WHERE admin_id = ? AND items = ?"
        ).bind(JSON.stringify(items), nowSec, adminId, curSession.items).run();

        if (updateRes.meta?.changes && updateRes.meta.changes > 0) {
          appendSuccess = true;
          break;
        }
      } catch (err: unknown) {
        lastErr = err;
        if (isD1FreeTierError(err)) {
          break;
        }
      }
    }

    if (!appendSuccess) {
      if (isD1FreeTierError(lastErr)) {
        await handleD1FreeTierError(ctx, lastErr);
        return;
      }
      logger.warn(`Failed to CAS append item for admin ${adminId} after 8 attempts`);
      await ctx.reply(t(ctx.lang, "bundle_save_error"));
      return;
    }

    if (!msg.media_group_id) {
      await ctx.reply(t(ctx.lang, "file_added_done_hint"));
    }
    return;
  }

  if (session.mode === "edit") {
    let appendSuccess = false;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
      try {
        const bundleRow = await ctx.env.DB.prepare(
          "SELECT items FROM bundles WHERE code = ?"
        ).bind(session.code).first<{ items: string }>();

        if (!bundleRow) {
          await cleanupAbandonedSession(ctx, adminId);
          return ctx.reply(t(ctx.lang, "bundle_not_found"));
        }

        const items = parseBundleItems(bundleRow.items);
        if (items.length >= LIMITS.MAX_BUNDLE_ITEMS) {
          return ctx.reply(t(ctx.lang, "upload_batch_limit", {
            maxSession: LIMITS.MAX_PER_SESSION_UPLOAD,
            maxTotal: LIMITS.MAX_BUNDLE_ITEMS
          }));
        }

        items.push(item);
        const updateRes = await ctx.env.DB.prepare(
          "UPDATE bundles SET items = ? WHERE code = ? AND items = ?"
        ).bind(JSON.stringify(items), session.code, bundleRow.items).run();

        if (updateRes.meta?.changes && updateRes.meta.changes > 0) {
          appendSuccess = true;
          break;
        }
      } catch (err: unknown) {
        lastErr = err;
        if (isD1FreeTierError(err)) {
          break;
        }
      }
    }

    if (!appendSuccess) {
      if (isD1FreeTierError(lastErr)) {
        await handleD1FreeTierError(ctx, lastErr);
        return;
      }
      logger.warn(`Failed to CAS append edit item for code ${session.code} after 8 attempts`);
      await ctx.reply(t(ctx.lang, "bundle_save_error"));
      return;
    }

    if (!msg.media_group_id) {
      await ctx.reply(t(ctx.lang, "file_added_done_hint"));
    }
  }
});