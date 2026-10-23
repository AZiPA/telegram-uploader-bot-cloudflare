import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { ACTIONS } from "../../config";
import { renderReviewMessage } from "./review";
import { ButtonFactory } from "../../shared/buttons";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { canManageBundle } from "../../middlewares/auth";
import { t } from "../../locales";

export const deletionComposer = new Composer<MyContext>();
const privileged = deletionComposer.filter((ctx) => ctx.isAdmin);

export async function deleteBundleRecords(ctx: MyContext, code: string): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM bundle_votes WHERE code = ?").bind(code),
    ctx.env.DB.prepare("DELETE FROM bundles WHERE code = ?").bind(code),
  ]);
}

privileged.callbackQuery(new RegExp(`^${ACTIONS.DELETE_CONFIRM_ASK}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const code = ctx.match[1];
  const bundle = await ctx.env.DB.prepare(
    "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
  ).bind(code).first<{ code: string; created_by: number; owner_locked?: number }>();

  if (!bundle || !(await canManageBundle(ctx, bundle))) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
    return;
  }

  const confirmKb = ButtonFactory.deleteConfirmKeyboard(ctx.lang, code);
  await ctx.editMessageReplyMarkup({ reply_markup: confirmKb }).catch(() => {});
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.DELETE_CONFIRM_NO}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery({ text: t(ctx.lang, "delete_cancelled") }).catch(() => {});
  const code = ctx.match[1];
  const reviewData = await renderReviewMessage(ctx, code);
  if (reviewData) {
    await ctx.editMessageReplyMarkup({ reply_markup: reviewData.reply_markup }).catch(() => {});
  }
});

privileged.callbackQuery(new RegExp(`^${ACTIONS.DELETE_CONFIRM_YES}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const targetCode = ctx.match[1];
  try {
    const bundle = await ctx.env.DB.prepare(
      "SELECT code, created_by, owner_locked FROM bundles WHERE code = ?"
    ).bind(targetCode).first<{ code: string; created_by: number; owner_locked?: number }>();
    if (!bundle) {
      await ctx.editMessageText(t(ctx.lang, "bundle_already_deleted")).catch(() => {});
      return;
    }
    if (!(await canManageBundle(ctx, bundle))) {
      await ctx.answerCallbackQuery({ text: t(ctx.lang, "bundle_access_denied"), show_alert: true });
      return;
    }

    await deleteBundleRecords(ctx, targetCode);
    await ctx.editMessageText(t(ctx.lang, "bundle_deleted_msg"), { parse_mode: "HTML" }).catch(() => {});
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});