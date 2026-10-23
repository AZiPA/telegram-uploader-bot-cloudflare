import { Composer } from "grammy";
import { Bundle, BundleRow, MyContext } from "../../core/types";
import { escapeHtml, parseBundleItems, getBotUsername, truncateText } from "../../shared/formatters";
import { LIMITS, ACTIONS } from "../../config";
import { executeDelivery } from "../filestore/delivery";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { canManageBundle } from "../../middlewares/auth";
import { ButtonFactory } from "../../shared/buttons";
import { t } from "../../locales";

export const hubComposer = new Composer<MyContext>();

export async function showAdminBundleHub(ctx: MyContext, code: string): Promise<void> {
  const lang = ctx.lang;
  let row: BundleRow | null = null;
  try {
    row = await ctx.env.DB.prepare(
      "SELECT code, title, items, created_by, protect_content, created_at, owner_locked, expires_at, is_one_time, consumed_by, passcode_hash, post_channel_id, post_message_id, rotate_interval_sec, last_rotated_at FROM bundles WHERE code = ?"
    ).bind(code).first<BundleRow>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }

  if (!row) {
    await ctx.reply(t(lang, "bundle_not_found"));
    return;
  }

  const bundle: Bundle = {
    ...row,
    items: parseBundleItems(row.items)
  };

  const total = bundle.items.length;
  const isProtected = Boolean(bundle.protect_content);
  const botUsername = getBotUsername(ctx);
  const shareLink = `https://t.me/${botUsername}?start=${bundle.code}`;

  const statusText = isProtected ? t(lang, "hub_status_protected") : t(lang, "hub_status_public");
  const searchTitle = bundle.title ? escapeHtml(bundle.title) : t(lang, "hub_search_none");

  const [dlRes, voteRes] = await Promise.all([
    ctx.env.DB.prepare("SELECT COALESCE(SUM(download_count), 0) AS c FROM user_downloads WHERE code = ?").bind(bundle.code).first<{ c: number }>(),
    ctx.env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN vote_type = 'like' THEN 1 ELSE 0 END), 0) AS likes, COALESCE(SUM(CASE WHEN vote_type = 'dislike' THEN 1 ELSE 0 END), 0) AS dislikes FROM bundle_votes WHERE code = ?").bind(bundle.code).first<{ likes: number; dislikes: number }>()
  ]);

  const downloads = dlRes?.c ?? 0;
  const likes = voteRes?.likes ?? 0;
  const dislikes = voteRes?.dislikes ?? 0;

  const nowSec = Math.floor(Date.now() / 1000);
  const ownerLockStatus = row.owner_locked ? t(lang, "status_active_red") : t(lang, "status_inactive_green");
  const expiryStatus = (row.expires_at && row.expires_at > 0)
    ? (row.expires_at <= nowSec ? t(lang, "label_disabled") : `${Math.ceil((row.expires_at - nowSec) / 3600)}h`)
    : t(lang, "label_disabled");
  const oneTimeStatus = row.is_one_time ? t(lang, "status_active_red") : t(lang, "status_inactive_green");
  const passStatus = row.passcode_hash ? t(lang, "status_enabled_shield") : t(lang, "label_disabled");

  let text = t(lang, "hub_title");
  text += t(lang, "hub_code", { code: bundle.code });
  text += t(lang, "hub_status", { status: statusText });
  text += t(lang, "hub_owner_locked", { status: ownerLockStatus });
  text += t(lang, "hub_expires_at", { time: expiryStatus });
  text += t(lang, "hub_is_one_time", { status: oneTimeStatus });
  text += t(lang, "hub_passcode", { status: passStatus });
  if (row.post_channel_id) {
    const rotStr = row.rotate_interval_sec ? `${row.rotate_interval_sec / 3600}h` : t(lang, "label_disabled");
    text += t(lang, "hub_channel_post", { channel: row.post_channel_id, interval: rotStr });
  }
  text += t(lang, "hub_search_name", { title: searchTitle });
  text += t(lang, "hub_files_count", { total, max: LIMITS.MAX_BUNDLE_ITEMS });
  text += t(lang, "hub_downloads_count", { count: downloads });
  if (!isProtected) {
    text += t(lang, "hub_feedback", { likes, dislikes });
  }
  text += t(lang, "hub_share_link", { link: shareLink });

  const kb = ButtonFactory.hubKeyboard(lang, bundle.code, {
    isProtected,
    isOwnerLocked: Boolean(row.owner_locked),
    expiryLabel: expiryStatus,
    isOneTime: Boolean(row.is_one_time),
    hasPasscode: Boolean(row.passcode_hash),
    rotateIntLabel: row.rotate_interval_sec ? `${row.rotate_interval_sec / 3600}h` : undefined,
  });

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(truncateText(text, 4096), { parse_mode: "HTML", reply_markup: kb }).catch(() => {
      return ctx.reply(truncateText(text, 4096), { parse_mode: "HTML", reply_markup: kb });
    });
  } else {
    await ctx.reply(truncateText(text, 4096), { parse_mode: "HTML", reply_markup: kb });
  }
}

hubComposer.callbackQuery(new RegExp(`^mng:testdl:([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  if (!ctx.isAdmin) {
    await ctx.answerCallbackQuery();
    return;
  }
  const code = ctx.match[1];
  const row = await ctx.env.DB.prepare(
    "SELECT created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ created_by: number; owner_locked?: number }>();
  if (!row || !(await canManageBundle(ctx, row))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: t(ctx.lang, "hub_preparing_files") });
  await executeDelivery(ctx, code, true, 0);
});

hubComposer.callbackQuery(new RegExp(`^${ACTIONS.BUNDLE_LOCK_OWNER}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  if (!ctx.isAdmin || !ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }
  const code = ctx.match[1];
  const row = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();

  if (!row) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_not_found"), show_alert: true });
    return;
  }

  // Only the bundle creator or a higher-ranking admin can toggle it
  if (row.created_by !== ctx.from.id && !(await canManageBundle(ctx, row))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const nextLocked = row.owner_locked === 1 ? 0 : 1;
  const newCreatedBy = (ctx.isOwner && nextLocked === 1 && row.created_by !== ctx.from.id)
    ? Number(ctx.env.OWNER_ID)
    : row.created_by;

  await ctx.env.DB.prepare(
    "UPDATE bundles SET owner_locked = ?, created_by = ? WHERE code = ?"
  ).bind(nextLocked, newCreatedBy, code).run();

  await ctx.answerCallbackQuery({
    text: t(ctx.lang, nextLocked === 1 ? "bundle_locked_success" : "bundle_unlocked_success"),
    show_alert: true,
  });

  await showAdminBundleHub(ctx, code);
});

hubComposer.command(["edit", "manage"], async (ctx) => {
  if (!ctx.isAdmin) return;
  const code = ctx.match?.trim();
  if (!code || !/^[a-zA-Z0-9_-]{8,36}$/.test(code)) {
    return ctx.reply(t(ctx.lang, "review_usage"), { parse_mode: "HTML" });
  }

  const row = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();
  if (!row) return ctx.reply(t(ctx.lang, "bundle_not_found"));
  if (!(await canManageBundle(ctx, row))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  await showAdminBundleHub(ctx, code);
});

hubComposer.callbackQuery(new RegExp(`^${ACTIONS.MANAGE_HUB}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!ctx.isAdmin || !ctx.from) return;

  const code = ctx.match[1];
  const row = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();

  if (!row) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }

  if (!(await canManageBundle(ctx, row))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const adminId = ctx.from.id;
  await ctx.env.DB.prepare(
    "DELETE FROM admin_sessions WHERE admin_id = ? AND mode = 'edit'"
  ).bind(adminId).run().catch(() => {});

  await showAdminBundleHub(ctx, code);
});