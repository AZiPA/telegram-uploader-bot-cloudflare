import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { LIMITS, ACTIONS, getDynamicConfig } from "../../config";
import { setCappedMap } from "../../shared/crypto";
import { ButtonFactory } from "../../shared/buttons";
import { executeDelivery } from "../filestore/delivery";
import { checkUserMembership } from "./service";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const fjUserComposer = new Composer<MyContext>();

const verificationCooldowns = new Map<number, number>();

fjUserComposer.callbackQuery(new RegExp(`^${ACTIONS.FORCE_JOIN_CHECK}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  try {
    const code = ctx.match[1];
    const userId = ctx.from.id;
    const now = Date.now();
    const throttleMs = LIMITS.FORCE_JOIN_THROTTLE_SEC * 1000;
    const lastCheck = verificationCooldowns.get(userId) || 0;

    if (now - lastCheck < throttleMs) {
      const waitSec = Math.ceil((throttleMs - (now - lastCheck)) / 1000);
      await ctx.answerCallbackQuery({
        text: t(ctx.lang, "fj_wait_cooldown", { sec: waitSec }),
        show_alert: false,
      }).catch(() => {});
      return;
    }

    setCappedMap(verificationCooldowns, userId, now, 5000);

    const result = await checkUserMembership(ctx.api, ctx.env, userId);

    if (!result.ok) {
      await ctx.answerCallbackQuery({
        text: t(ctx.lang, "fj_not_joined_alert"),
        show_alert: true,
      }).catch(() => {});
      try {
        const customVerifyBtn = await getDynamicConfig(ctx.env, "cfg_fj_verify_btn", t(ctx.lang, "btn_verify_join"));
        const updatedKeyboard = ButtonFactory.forceJoinKeyboard(result.missing, ctx.lang, code, customVerifyBtn);
        await ctx.editMessageReplyMarkup({ reply_markup: updatedKeyboard }).catch(() => {});
      } catch {
        // Callback is already answered.
      }
      return;
    }

    await ctx.answerCallbackQuery({
      text: t(ctx.lang, "fj_verified_alert"),
      show_alert: false,
    }).catch(() => {});

    try { await ctx.deleteMessage(); } catch { /* already gone, or the user blocked the bot */ }

    await executeDelivery(ctx, code, true, 0);
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    console.error("Force-join verification error:", err);
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "delivery_busy"), show_alert: true }).catch(async () => {
      await ctx.reply(t(ctx.lang, "delivery_busy")).catch(() => {});
    });
  }
});