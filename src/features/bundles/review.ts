import { Composer, InlineKeyboard } from "grammy";
import { Bundle, BundleItem, BundleRow, MyContext } from "../../core/types";
import { LIMITS, ACTIONS } from "../../config";
import { t } from "../../locales";
import { cleanupAbandonedSession } from "../filestore/upload";
import { escapeHtml, parseBundleItems, truncateText } from "../../shared/formatters";
import { ButtonFactory } from "../../shared/buttons";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { canManageBundle } from "../../middlewares/auth";

export const reviewComposer = new Composer<MyContext>();
const privileged = reviewComposer.filter((ctx) => ctx.isAdmin);

function getFileTypeIcon(lang: string | undefined, type: string): string {
  switch (type) {
    case "video": return t(lang, "file_type_video");
    case "audio": return t(lang, "file_type_audio");
    case "photo": return t(lang, "file_type_photo");
    default: return t(lang, "file_type_file");
  }
}

export async function renderReviewMessage(ctx: MyContext, code: string): Promise<{ text: string; reply_markup: InlineKeyboard } | null> {
  let row: BundleRow | null = null;
  try {
    row = await ctx.env.DB.prepare(
      "SELECT code, title, items, created_by, protect_content, created_at FROM bundles WHERE code = ?"
    ).bind(code).first<BundleRow>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return null;
    }
    throw err;
  }

  if (!row) return null;

  const bundle: Bundle = {
    ...row,
    items: parseBundleItems(row.items)
  };

  const list = bundle.items;
  const lang = ctx.lang;

  let text = t(lang, "review_header", { code: bundle.code });
  text += t(lang, "review_count", { count: list.length, max: LIMITS.MAX_BUNDLE_ITEMS });

  const itemLine = (item: BundleItem, index: number): string => {
    const fileName = item.file_name ? ` (${escapeHtml(truncateText(item.file_name, 48))})` : "";
    return `${index + 1}. ${getFileTypeIcon(lang, item.type)}${fileName}`;
  };

  const lines: string[] = [];
  if (list.length < 10) {
    list.forEach((item, index) => {
      lines.push(itemLine(item, index));
    });
  } else {
    list.forEach((item, index) => {
      lines.push(`${itemLine(item, index)} ── /del_${index + 1}`);
    });
  }

  const listBody = lines.join("\n");
  if (list.length >= 5) {
    text += `<blockquote expandable>${listBody}</blockquote>\n`;
  } else if (listBody) {
    text += `${listBody}\n`;
  }
  if (list.length >= 10) {
    text += t(lang, "review_delete_hint");
  }

  const kb = ButtonFactory.reviewKeyboard(lang, bundle.code, list);

  text += t(lang, "review_add_hint");
  text += t(lang, "review_done_hint");

  return { text: truncateText(text, 4096), reply_markup: kb };
}

async function commitItemRemoval(
  ctx: MyContext,
  code: string,
  originalItems: string,
  items: BundleItem[]
): Promise<boolean> {
  try {
    if (items.length === 0) {
      const results = await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "DELETE FROM bundle_votes WHERE code = ? AND EXISTS (SELECT 1 FROM bundles WHERE code = ? AND items = ?)"
        ).bind(code, code, originalItems),
        ctx.env.DB.prepare("DELETE FROM bundles WHERE code = ? AND items = ?").bind(code, originalItems),
      ]);
      return (results[1]?.meta?.changes ?? 0) > 0;
    }

    const res = await ctx.env.DB.prepare(
      "UPDATE bundles SET items = ? WHERE code = ? AND items = ?"
    ).bind(JSON.stringify(items), code, originalItems).run();
    return (res.meta?.changes ?? 0) > 0;
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return false;
    }
    throw err;
  }
}

privileged.command("review", async (ctx) => {
  const code = ctx.match?.trim();
  if (!code || !/^[a-zA-Z0-9_-]{8,36}$/.test(code)) {
    return ctx.reply(t(ctx.lang, "review_usage"), { parse_mode: "HTML" });
  }

  const row = await ctx.env.DB.prepare(
    "SELECT code, title, items, created_by, protect_content, created_at, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<BundleRow>();
  if (!row) return ctx.reply(t(ctx.lang, "bundle_not_found"));
  if (!(await canManageBundle(ctx, row))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  const reviewData = await renderReviewMessage(ctx, code);
  if (!reviewData) return ctx.reply(t(ctx.lang, "review_error"));

  const adminId = ctx.from!.id;
  await cleanupAbandonedSession(ctx, adminId);

  const nowSec = Math.floor(Date.now() / 1000);
  await ctx.env.DB.prepare(
    "INSERT INTO admin_sessions (admin_id, code, mode, items, updated_at) " +
    "VALUES (?, ?, 'edit', '[]', ?) " +
    "ON CONFLICT(admin_id) DO UPDATE SET " +
    "code = excluded.code, mode = 'edit', " +
    "updated_at = excluded.updated_at"
  ).bind(adminId, code, nowSec).run();

  await ctx.reply(reviewData.text, { parse_mode: "HTML", reply_markup: reviewData.reply_markup });
});

privileged.callbackQuery(new RegExp(`^mng:review:([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
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

  const reviewData = await renderReviewMessage(ctx, code);
  if (!reviewData) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }

  const adminId = ctx.from!.id;
  await cleanupAbandonedSession(ctx, adminId);

  const nowSec = Math.floor(Date.now() / 1000);
  await ctx.env.DB.prepare(
    "INSERT INTO admin_sessions (admin_id, code, mode, items, updated_at) " +
    "VALUES (?, ?, 'edit', '[]', ?) " +
    "ON CONFLICT(admin_id) DO UPDATE SET " +
    "code = excluded.code, mode = 'edit', " +
    "updated_at = excluded.updated_at"
  ).bind(adminId, code, nowSec).run();

  await ctx.reply(reviewData.text, { parse_mode: "HTML", reply_markup: reviewData.reply_markup });
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.MANAGE_REFRESH}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];
  const row = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();
  if (!row || !(await canManageBundle(ctx, row))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const reviewData = await renderReviewMessage(ctx, code);
  if (!reviewData) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }

  await ctx.editMessageText(reviewData.text, { parse_mode: "HTML", reply_markup: reviewData.reply_markup }).catch(() => {});
});

privileged.hears(/^\/del_(\d+)(?:@\w+)?$/, async (ctx) => {
  const itemIndex = Number(ctx.match[1]) - 1;
  const adminId = ctx.from!.id;

  const session = await ctx.env.DB.prepare(
    "SELECT code FROM admin_sessions WHERE admin_id = ? AND mode = 'edit'"
  ).bind(adminId).first<{ code: string }>();

  if (!session) {
    return ctx.reply(t(ctx.lang, "review_edit_first_hint"), { parse_mode: "HTML" });
  }

  const row = await ctx.env.DB.prepare(
    "SELECT code, items, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(session.code).first<{ code: string; items: string; created_by: number; owner_locked?: number }>();
  if (!row) {
    return ctx.reply(t(ctx.lang, "bundle_not_found"));
  }
  if (!(await canManageBundle(ctx, row))) {
    return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
  }

  const items = parseBundleItems(row.items);
  if (itemIndex < 0 || itemIndex >= items.length) {
    return ctx.reply(t(ctx.lang, "review_item_not_found"));
  }

  const removed = items.splice(itemIndex, 1);
  if (removed.length !== 1) {
    return ctx.reply(t(ctx.lang, "review_item_not_found"));
  }

  const committed = await commitItemRemoval(ctx, session.code, row.items, items);
  if (!committed) {
    return ctx.reply(t(ctx.lang, "review_item_not_found"));
  }

  await ctx.reply(t(ctx.lang, "review_item_deleted_hint"));
  const reviewData = await renderReviewMessage(ctx, session.code);
  if (reviewData) {
    await ctx.reply(reviewData.text, {
      parse_mode: "HTML",
      reply_markup: reviewData.reply_markup,
    });
  }
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.MANAGE_DEL_ITEM}(\\d+):([a-zA-Z0-9_-]{1,8}):([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const itemIndex = Number(ctx.match[1]);
  const fuidPrefix = ctx.match[2];
  const bundleCode = ctx.match[3];

  const row = await ctx.env.DB.prepare(
    "SELECT code, items, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(bundleCode).first<{ code: string; items: string; created_by: number; owner_locked?: number }>();
  if (!row) {
    await ctx.reply(t(ctx.lang, "bundle_not_found")).catch(() => {});
    return;
  }
  if (!(await canManageBundle(ctx, row))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const items = parseBundleItems(row.items);
  let targetIndex = -1;
  if (itemIndex >= 0 && itemIndex < items.length) {
    const itemFuid = (items[itemIndex]?.file_unique_id || "item").slice(0, 8);
    if (itemFuid === fuidPrefix) {
      targetIndex = itemIndex;
    }
  }
  if (targetIndex === -1) {
    targetIndex = items.findIndex((it) => (it.file_unique_id || "item").slice(0, 8) === fuidPrefix);
  }

  if (targetIndex === -1) {
    await ctx.reply(t(ctx.lang, "review_item_not_belong")).catch(() => {});
    return;
  }

  items.splice(targetIndex, 1);
  const committed = await commitItemRemoval(ctx, bundleCode, row.items, items);
  if (!committed) {
    await ctx.reply(t(ctx.lang, "review_item_not_belong")).catch(() => {});
    return;
  }

  if (items.length === 0) {
    await ctx.editMessageText(t(ctx.lang, "bundle_deleted_msg"), { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const reviewData = await renderReviewMessage(ctx, bundleCode);
  if (reviewData) {
    await ctx.editMessageText(reviewData.text, {
      parse_mode: "HTML",
      reply_markup: reviewData.reply_markup
    }).catch(() => {});
  }
});