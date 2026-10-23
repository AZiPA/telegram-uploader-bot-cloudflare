import { Composer } from "grammy";
import { BundleRow, MyContext } from "../../core/types";
import { ACTIONS, LIMITS, getDynamicConfig } from "../../config";
import { ButtonFactory } from "../../shared/buttons";
import { getBotUsername, escapeHtml, parseBundleItems } from "../../shared/formatters";
import { sha256Hex } from "../../shared/crypto";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { canManageBundle } from "../../middlewares/auth";
import { showAdminBundleHub } from "./hub";
import { t } from "../../locales";

export const protectedComposer = new Composer<MyContext>();
const privileged = protectedComposer.filter((ctx) => ctx.isAdmin);

export function isUuidCode(code: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
}

export function parseDurationSec(str: string): number | null {
  const s = str.trim().toLowerCase();
  if (s === "0" || s === "off" || s === "clear" || s === "never") return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return null;
  const val = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "s") return val;
  if (unit === "m") return val * 60;
  if (unit === "h") return val * 3600;
  if (unit === "d") return val * 86400;
  return null;
}

function buildChannelPost(
  lang: string,
  bundle: { title?: string | null; protect_content?: number; expires_at?: number },
  count: number,
  shareLink: string
) {
  const title = bundle.title ? escapeHtml(bundle.title) : t(lang, "hub_title").trim();
  let flags = "";
  if (bundle.protect_content === 1) {
    flags += t(lang, "channel_flag_protected");
  }
  if (bundle.expires_at && bundle.expires_at > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const diffH = Math.max(1, Math.ceil((bundle.expires_at - nowSec) / 3600));
    flags += t(lang, "channel_flag_expires", { val: `${diffH}h` });
  }
  const text = t(lang, "channel_post_caption", { title, count: String(count), flags });
  const kb = ButtonFactory.channelPostKeyboard(lang, shareLink);
  return { text, reply_markup: kb };
}

// 1. MAKE_PROTECTED Callback Query
privileged.callbackQuery(new RegExp(`^${ACTIONS.MAKE_PROTECTED}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const currentCode = ctx.match[1];

  try {
    const bundle = await ctx.env.DB.prepare(
      "SELECT code, protect_content, created_by, owner_locked FROM bundles WHERE code = ?"
    ).bind(currentCode).first<{ code: string; protect_content: number; created_by: number; owner_locked?: number }>();

    if (!bundle) {
      await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
      return;
    }
    if (!(await canManageBundle(ctx, bundle))) {
      await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
      return;
    }

    if (bundle.protect_content === 1 && isUuidCode(currentCode)) {
      await ctx.reply(t(ctx.lang, "already_protected")).catch(() => {});
      return;
    }

    const newUuid = crypto.randomUUID();

    const batchResults = await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE bundles SET code = ?, protect_content = 1, title = NULL WHERE code = ? AND protect_content = 0").bind(newUuid, currentCode),
      ctx.env.DB.prepare("UPDATE bundle_votes SET code = ? WHERE code = ?").bind(newUuid, currentCode)
    ]);

    if ((batchResults[0]?.meta?.changes ?? 0) === 0) {
      await ctx.reply(t(ctx.lang, "already_protected")).catch(() => {});
      return;
    }

    const botUsername = getBotUsername(ctx);
    const newLink = `https://t.me/${botUsername}?start=${newUuid}`;

    const updatedKb = ButtonFactory.deliveryKeyboard(ctx.lang, newUuid, 0, 0, false, true, true);
    await ctx.editMessageReplyMarkup({ reply_markup: updatedKb }).catch(() => {});

    await ctx.reply(
      t(ctx.lang, "protected_success_msg", { uuid: newUuid, link: newLink }),
      { parse_mode: "HTML" }
    );
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});

// 2. Expiring Bundles (/setexpiry and BUNDLE_EXPIRY callback)
privileged.command("setexpiry", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length < 2) {
    return ctx.reply(t(ctx.lang, "setexpiry_usage"), { parse_mode: "HTML" });
  }

  const [code, durationRaw] = parts;
  const sec = parseDurationSec(durationRaw);
  if (sec === null || sec < 0) {
    return ctx.reply(t(ctx.lang, "setexpiry_usage"), { parse_mode: "HTML" });
  }

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();

  if (!bundle) return ctx.reply(t(ctx.lang, "bundle_not_found"));
  if (!(await canManageBundle(ctx, bundle))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const newExpiresAt = sec > 0 ? nowSec + sec : 0;

  await ctx.env.DB.prepare("UPDATE bundles SET expires_at = ? WHERE code = ?").bind(newExpiresAt, code).run();

  if (sec === 0) {
    await ctx.reply(t(ctx.lang, "expiry_cleared_msg", { code }), { parse_mode: "HTML" });
  } else {
    const valStr = sec >= 86400 ? `${Math.round(sec / 86400)}d` : `${Math.round(sec / 3600)}h`;
    await ctx.reply(t(ctx.lang, "expiry_updated_msg", { code, val: valStr }), { parse_mode: "HTML" });
  }
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_EXPIRY}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, expires_at, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; expires_at: number; created_by: number; owner_locked?: number }>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const presets = [0, 3600, 21600, 86400, 259200, 604800, 2592000];
  const nowSec = Math.floor(Date.now() / 1000);
  const rem = bundle.expires_at > nowSec ? bundle.expires_at - nowSec : 0;

  let curIdx = 0;
  if (rem > 0) {
    curIdx = presets.findIndex((p) => p > 0 && Math.abs(p - rem) < p * 0.4);
    if (curIdx === -1) curIdx = 1;
  }
  const nextSec = presets[(curIdx + 1) % presets.length];
  const nextExpiresAt = nextSec > 0 ? nowSec + nextSec : 0;

  await ctx.env.DB.prepare("UPDATE bundles SET expires_at = ? WHERE code = ?").bind(nextExpiresAt, code).run();
  await showAdminBundleHub(ctx, code);
});

// 3. One-Time Bundles (BUNDLE_ONETIME callback)
privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_ONETIME}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const currentCode = ctx.match[1];

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, is_one_time, protect_content, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(currentCode).first<{ code: string; is_one_time: number; protect_content: number; created_by: number; owner_locked?: number }>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const nextOneTime = bundle.is_one_time === 1 ? 0 : 1;
  const botUsername = getBotUsername(ctx);

  if (nextOneTime === 1) {
    let finalCode = currentCode;
    if (!isUuidCode(currentCode)) {
      finalCode = crypto.randomUUID();
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "UPDATE bundles SET code = ?, protect_content = 1, is_one_time = 1, title = NULL WHERE code = ?"
        ).bind(finalCode, currentCode),
        ctx.env.DB.prepare("UPDATE bundle_votes SET code = ? WHERE code = ?").bind(finalCode, currentCode),
      ]);
    } else {
      await ctx.env.DB.prepare(
        "UPDATE bundles SET protect_content = 1, is_one_time = 1 WHERE code = ?"
      ).bind(currentCode).run();
    }
    const link = `https://t.me/${botUsername}?start=${finalCode}`;
    await ctx.reply(t(ctx.lang, "onetime_enabled_msg", { link }), { parse_mode: "HTML" });
    await showAdminBundleHub(ctx, finalCode);
  } else {
    await ctx.env.DB.prepare("UPDATE bundles SET is_one_time = 0 WHERE code = ?").bind(currentCode).run();
    await ctx.reply(t(ctx.lang, "onetime_disabled_msg"));
    await showAdminBundleHub(ctx, currentCode);
  }
});

// 4. Password-Protected Bundles (/setpass, BUNDLE_PASS_PROMPT callback, and ForceReply listener)
privileged.command("setpass", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length < 2) {
    return ctx.reply(t(ctx.lang, "setpass_usage"), { parse_mode: "HTML" });
  }

  const [code, pinRaw] = parts;
  const pin = pinRaw.trim();

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked, passcode_hash FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number; passcode_hash?: string | null }>();

  if (!bundle) return ctx.reply(t(ctx.lang, "bundle_not_found"));
  if (!(await canManageBundle(ctx, bundle))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  if (["off", "clear", "0"].includes(pin.toLowerCase())) {
    await ctx.env.DB.prepare("UPDATE bundles SET passcode_hash = NULL WHERE code = ?").bind(code).run();
    return ctx.reply(t(ctx.lang, "passcode_cleared", { code }), { parse_mode: "HTML" });
  }

  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(pin)) {
    return ctx.reply(t(ctx.lang, "passcode_invalid_format"), { parse_mode: "HTML" });
  }

  const passCountRow = await ctx.env.DB.prepare(
    "SELECT COUNT(*) as c FROM bundles WHERE created_by = ? AND passcode_hash IS NOT NULL"
  ).bind(ctx.from!.id).first<{ c: number }>();
  const activePassCount = passCountRow?.c ?? 0;

  if (!ctx.isOwner) {
    if (ctx.isSuperAdmin && activePassCount >= LIMITS.MAX_PASSCODE_SUPERADMIN) {
      return ctx.reply(t(ctx.lang, "passcode_quota_superadmin_exceeded", { max: String(LIMITS.MAX_PASSCODE_SUPERADMIN) }), { parse_mode: "HTML" });
    }
    if (!ctx.isSuperAdmin && activePassCount >= LIMITS.MAX_PASSCODE_ADMIN) {
      return ctx.reply(t(ctx.lang, "passcode_quota_admin_exceeded", { max: String(LIMITS.MAX_PASSCODE_ADMIN) }), { parse_mode: "HTML" });
    }
  }

  let finalCode = code;
  if (!isUuidCode(code)) {
    finalCode = crypto.randomUUID();
    const hash = await sha256Hex(`${finalCode}:${pin}`);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "UPDATE bundles SET code = ?, protect_content = 1, passcode_hash = ?, title = NULL WHERE code = ?"
      ).bind(finalCode, hash, code),
      ctx.env.DB.prepare("UPDATE bundle_votes SET code = ? WHERE code = ?").bind(finalCode, code),
    ]);
  } else {
    const hash = await sha256Hex(`${finalCode}:${pin}`);
    await ctx.env.DB.prepare(
      "UPDATE bundles SET protect_content = 1, passcode_hash = ? WHERE code = ?"
    ).bind(hash, code).run();
  }

  const botUsername = getBotUsername(ctx);
  const link = `https://t.me/${botUsername}?start=${finalCode}`;
  const pinLink = `https://t.me/${botUsername}?start=${finalCode}_${pin}`;

  let replyMsg = t(ctx.lang, "passcode_set_success", { link, pinLink });
  if (ctx.isOwner && activePassCount >= LIMITS.OWNER_PASSCODE_WARN_THRESHOLD) {
    replyMsg += t(ctx.lang, "owner_quota_advisory", { limit: String(LIMITS.OWNER_PASSCODE_WARN_THRESHOLD) });
  }

  await ctx.reply(replyMsg, { parse_mode: "HTML" });
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_PASS_PROMPT}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked, passcode_hash FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number; passcode_hash?: string | null }>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  if (bundle.passcode_hash) {
    await ctx.env.DB.prepare("UPDATE bundles SET passcode_hash = NULL WHERE code = ?").bind(code).run();
    await ctx.reply(t(ctx.lang, "passcode_cleared", { code }), { parse_mode: "HTML" });
    await showAdminBundleHub(ctx, code);
    return;
  }

  await ctx.reply(t(ctx.lang, "passcode_prompt_admin", { code }), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  });
});

// ForceReply Listener for #SET_BUNDLE_PASS#
privileged.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.text) return next();

  const match = /#SET_BUNDLE_PASS#([a-zA-Z0-9_-]{8,36})#/.exec(replyTo.text);
  if (!match) return next();

  const code = match[1];
  const pin = ctx.message.text.trim();
  if (["/cancel", "cancel"].includes(pin.toLowerCase())) {
    await ctx.reply(t(ctx.lang, "operation_cancelled"));
    return;
  }

  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(pin)) {
    return ctx.reply(t(ctx.lang, "passcode_invalid_format"), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
  }

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();

  if (!bundle || !(await canManageBundle(ctx, bundle))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  const passCountRow = await ctx.env.DB.prepare(
    "SELECT COUNT(*) as c FROM bundles WHERE created_by = ? AND passcode_hash IS NOT NULL"
  ).bind(ctx.from!.id).first<{ c: number }>();
  const activePassCount = passCountRow?.c ?? 0;

  if (!ctx.isOwner) {
    if (ctx.isSuperAdmin && activePassCount >= LIMITS.MAX_PASSCODE_SUPERADMIN) {
      return ctx.reply(t(ctx.lang, "passcode_quota_superadmin_exceeded", { max: String(LIMITS.MAX_PASSCODE_SUPERADMIN) }), { parse_mode: "HTML" });
    }
    if (!ctx.isSuperAdmin && activePassCount >= LIMITS.MAX_PASSCODE_ADMIN) {
      return ctx.reply(t(ctx.lang, "passcode_quota_admin_exceeded", { max: String(LIMITS.MAX_PASSCODE_ADMIN) }), { parse_mode: "HTML" });
    }
  }

  let finalCode = code;
  if (!isUuidCode(code)) {
    finalCode = crypto.randomUUID();
    const hash = await sha256Hex(`${finalCode}:${pin}`);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "UPDATE bundles SET code = ?, protect_content = 1, passcode_hash = ?, title = NULL WHERE code = ?"
      ).bind(finalCode, hash, code),
      ctx.env.DB.prepare("UPDATE bundle_votes SET code = ? WHERE code = ?").bind(finalCode, code),
    ]);
  } else {
    const hash = await sha256Hex(`${finalCode}:${pin}`);
    await ctx.env.DB.prepare(
      "UPDATE bundles SET protect_content = 1, passcode_hash = ? WHERE code = ?"
    ).bind(hash, code).run();
  }

  const botUsername = getBotUsername(ctx);
  const link = `https://t.me/${botUsername}?start=${finalCode}`;
  const pinLink = `https://t.me/${botUsername}?start=${finalCode}_${pin}`;

  let replyMsg = t(ctx.lang, "passcode_set_success", { link, pinLink });
  if (ctx.isOwner && activePassCount >= LIMITS.OWNER_PASSCODE_WARN_THRESHOLD) {
    replyMsg += t(ctx.lang, "owner_quota_advisory", { limit: String(LIMITS.OWNER_PASSCODE_WARN_THRESHOLD) });
  }

  await ctx.reply(replyMsg, { parse_mode: "HTML" });
});

// 5. Channel Post Publishing & Sync (/postbundle and BUNDLE_POST_CHANNEL callback)
privileged.command("postbundle", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length < 1 || !parts[0]) {
    return ctx.reply(t(ctx.lang, "postbundle_usage"), { parse_mode: "HTML" });
  }
  const [code, channelArg] = parts;
  await publishOrSyncBundle(ctx, code, channelArg);
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_POST_CHANNEL}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];
  await publishOrSyncBundle(ctx, code);
});

async function publishOrSyncBundle(ctx: MyContext, code: string, channelArg?: string): Promise<void> {
  const bundle = await ctx.env.DB.prepare(
    "SELECT code, title, items, created_by, protect_content, expires_at, post_channel_id, post_message_id, last_rotated_at, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<BundleRow>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found"));
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
    return;
  }

  const configuredPubChannel = await getDynamicConfig(ctx.env, "publish_channel_id", "");
  const targetChannel = channelArg || bundle.post_channel_id || configuredPubChannel;
  if (!targetChannel || !/^-\d+$/.test(targetChannel)) {
    await ctx.reply(t(ctx.lang, "pubchannel_not_set"), { parse_mode: "HTML" });
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - (bundle.last_rotated_at || 0);

  if (!ctx.isOwner && bundle.last_rotated_at && bundle.last_rotated_at > 0 && diff < LIMITS.POST_SYNC_COOLDOWN_SEC) {
    const rem = LIMITS.POST_SYNC_COOLDOWN_SEC - diff;
    await ctx.reply(t(ctx.lang, "cooldown_active", { sec: rem }));
    return;
  }

  const botUsername = getBotUsername(ctx);
  const shareLink = `https://t.me/${botUsername}?start=${bundle.code}`;
  const items = parseBundleItems(bundle.items);
  const postData = buildChannelPost(ctx.lang, bundle, items.length, shareLink);

  let messageId = bundle.post_message_id || 0;
  let editSuccess = false;

  if (bundle.post_channel_id === targetChannel && messageId > 0) {
    try {
      await ctx.api.editMessageText(targetChannel, messageId, postData.text, {
        parse_mode: "HTML",
        reply_markup: postData.reply_markup,
      });
      editSuccess = true;
    } catch {
      editSuccess = false;
    }
  }

  if (!editSuccess) {
    try {
      const sent = await ctx.api.sendMessage(targetChannel, postData.text, {
        parse_mode: "HTML",
        reply_markup: postData.reply_markup,
      });
      messageId = sent.message_id;
    } catch (err: unknown) {
      const e = err as { message?: string };
      await ctx.reply(`❌ Telegram error: ${escapeHtml(e?.message || "Send failed")}`, { parse_mode: "HTML" });
      return;
    }
  }

  await ctx.env.DB.prepare(
    "UPDATE bundles SET post_channel_id = ?, post_message_id = ?, last_rotated_at = ? WHERE code = ?"
  ).bind(targetChannel, messageId, nowSec, code).run();

  let successMsg = t(ctx.lang, "postbundle_success", { target: targetChannel });
  if (ctx.isOwner && bundle.last_rotated_at && bundle.last_rotated_at > 0 && diff < LIMITS.OWNER_SYNC_WARN_COOLDOWN_SEC) {
    successMsg += t(ctx.lang, "owner_cooldown_advisory");
  }

  await ctx.reply(successMsg, { parse_mode: "HTML" });
  await showAdminBundleHub(ctx, code);
}

// 6. Manual Link Rotation (/rotatelink and BUNDLE_ROTATE_NOW callback)
privileged.command("rotatelink", async (ctx) => {
  const code = ctx.match?.trim();
  if (!code || !/^[a-zA-Z0-9_-]{8,36}$/.test(code)) {
    return ctx.reply(t(ctx.lang, "rotatelink_usage"), { parse_mode: "HTML" });
  }
  await rotateBundleLink(ctx, code);
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_ROTATE_NOW}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];
  await rotateBundleLink(ctx, code);
});

async function rotateBundleLink(ctx: MyContext, currentCode: string): Promise<void> {
  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked, passcode_hash, post_channel_id, post_message_id, last_rotated_at FROM bundles WHERE code = ?"
  ).bind(currentCode).first<BundleRow>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found"));
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - (bundle.last_rotated_at || 0);

  if (!ctx.isOwner && bundle.last_rotated_at && bundle.last_rotated_at > 0 && diff < LIMITS.POST_SYNC_COOLDOWN_SEC) {
    const rem = LIMITS.POST_SYNC_COOLDOWN_SEC - diff;
    await ctx.reply(t(ctx.lang, "cooldown_active", { sec: rem }));
    return;
  }

  const newUuid = crypto.randomUUID();
  const todayDate = new Date().toISOString().slice(0, 10);

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE bundles SET code = ?, protect_content = 1, passcode_hash = NULL, last_rotated_at = ? WHERE code = ?"
    ).bind(newUuid, nowSec, currentCode),
    ctx.env.DB.prepare("UPDATE bundle_votes SET code = ? WHERE code = ?").bind(newUuid, currentCode),
    ctx.env.DB.prepare("UPDATE user_downloads SET code = ? WHERE code = ? AND access_date = ?").bind(newUuid, currentCode, todayDate),
  ]);

  const botUsername = getBotUsername(ctx);
  const newShareLink = `https://t.me/${botUsername}?start=${newUuid}`;

  if (bundle.post_channel_id && bundle.post_message_id) {
    await ctx.api.editMessageReplyMarkup(bundle.post_channel_id, bundle.post_message_id, {
      reply_markup: ButtonFactory.channelPostKeyboard(ctx.lang, newShareLink),
    }).catch(() => {});
  }

  let replyMsg = t(ctx.lang, "rotatelink_success", { link: newShareLink });
  if (bundle.passcode_hash) {
    replyMsg += t(ctx.lang, "rotatelink_pin_reset");
  }
  if (ctx.isOwner && bundle.last_rotated_at && bundle.last_rotated_at > 0 && diff < LIMITS.OWNER_SYNC_WARN_COOLDOWN_SEC) {
    replyMsg += t(ctx.lang, "owner_cooldown_advisory");
  }

  await ctx.reply(replyMsg, { parse_mode: "HTML" });
  await showAdminBundleHub(ctx, newUuid);
}

// 7. Scheduled Auto-Rotation Interval Cycle (BUNDLE_ROTATE_INT callback)
privileged.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_ROTATE_INT}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];

  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked, post_channel_id, post_message_id, rotate_interval_sec FROM bundles WHERE code = ?"
  ).bind(code).first<BundleRow>();

  if (!bundle) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }
  if (!(await canManageBundle(ctx, bundle))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  if (!bundle.post_channel_id || !bundle.post_message_id) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "rotate_requires_channel_post"), show_alert: true });
    return;
  }

  const presets = [0, 21600, 43200, 86400, 172800];
  const curIdx = presets.indexOf(bundle.rotate_interval_sec || 0);
  const nextInterval = presets[curIdx >= 0 ? (curIdx + 1) % presets.length : 1];

  if (nextInterval > 0) {
    const [adminRotRow, chanRotRow] = await Promise.all([
      ctx.env.DB.prepare("SELECT COUNT(*) as c FROM bundles WHERE created_by = ? AND rotate_interval_sec > 0").bind(ctx.from!.id).first<{ c: number }>(),
      ctx.env.DB.prepare("SELECT COUNT(*) as c FROM bundles WHERE post_channel_id = ? AND rotate_interval_sec > 0").bind(bundle.post_channel_id).first<{ c: number }>(),
    ]);
    const adminRot = adminRotRow?.c ?? 0;
    const chanRot = chanRotRow?.c ?? 0;

    if (!ctx.isOwner) {
      if (chanRot >= LIMITS.MAX_ROTATING_PER_CHANNEL) {
        await ctx.answerCallbackQuery({ text: t(ctx.lang, "rotate_quota_channel_exceeded", { max: String(LIMITS.MAX_ROTATING_PER_CHANNEL) }), show_alert: true });
        return;
      }
      if (ctx.isSuperAdmin && adminRot >= LIMITS.MAX_ROTATING_SUPERADMIN) {
        await ctx.answerCallbackQuery({ text: t(ctx.lang, "rotate_quota_admin_exceeded", { max: String(LIMITS.MAX_ROTATING_SUPERADMIN) }), show_alert: true });
        return;
      }
      if (!ctx.isSuperAdmin && adminRot >= LIMITS.MAX_ROTATING_ADMIN) {
        await ctx.answerCallbackQuery({ text: t(ctx.lang, "rotate_quota_admin_exceeded", { max: String(LIMITS.MAX_ROTATING_ADMIN) }), show_alert: true });
        return;
      }
    }
  }

  await ctx.env.DB.prepare("UPDATE bundles SET rotate_interval_sec = ? WHERE code = ?").bind(nextInterval, code).run();

  const valStr = nextInterval > 0 ? `${nextInterval / 3600}h` : t(ctx.lang, "label_disabled");
  await ctx.answerCallbackQuery({
    text: t(ctx.lang, "rotate_interval_updated", { val: valStr }),
    show_alert: true,
  });

  await showAdminBundleHub(ctx, code);
});