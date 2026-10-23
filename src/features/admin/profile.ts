import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { ACTIONS } from "../../config";
import { escapeHtml } from "../../shared/formatters";
import { ButtonFactory } from "../../shared/buttons";
import { t } from "../../locales";

export const adminProfileComposer = new Composer<MyContext>();
const superAdminOrOwner = adminProfileComposer.filter((ctx) => ctx.isSuperAdmin);

export async function showBotProfileMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.lang;
  const [nameRes, descRes, shortDescRes] = await Promise.all([
    ctx.api.getMyName().catch(() => null),
    ctx.api.getMyDescription().catch(() => null),
    ctx.api.getMyShortDescription().catch(() => null)
  ]);

  const emptyText = t(lang, "profile_empty");
  const name = nameRes?.name ? escapeHtml(nameRes.name) : emptyText;
  const desc = descRes?.description ? escapeHtml(descRes.description) : emptyText;
  const shortDesc = shortDescRes?.short_description ? escapeHtml(shortDescRes.short_description) : emptyText;

  const text =
    `${t(lang, "profile_menu_title")}\n\n` +
    `${t(lang, "profile_menu_desc")}\n\n` +
    `🏷 <b>${t(lang, "profile_current_name")}:</b> <code>${name}</code>\n` +
    `📝 <b>${t(lang, "profile_current_desc")}:</b>\n<i>${desc}</i>\n\n` +
    `ℹ️ <b>${t(lang, "profile_current_short_desc")}:</b>\n<i>${shortDesc}</i>`;

  const kb = ButtonFactory.profileKeyboard(lang);

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {
      return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

superAdminOrOwner.command("botprofile", async (ctx) => {
  await showBotProfileMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.BOT_PROFILE_MENU, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showBotProfileMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.BOT_PROFILE_SET_NAME, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(t(ctx.lang, "profile_prompt_name"), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }
  });
});

superAdminOrOwner.callbackQuery(ACTIONS.BOT_PROFILE_SET_DESC, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(t(ctx.lang, "profile_prompt_desc"), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }
  });
});

superAdminOrOwner.callbackQuery(ACTIONS.BOT_PROFILE_SET_SHORT_DESC, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(t(ctx.lang, "profile_prompt_short_desc"), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }
  });
});

superAdminOrOwner.callbackQuery(ACTIONS.BOT_PROFILE_CANCEL, async (ctx) => {
  await ctx.answerCallbackQuery({ text: t(ctx.lang, "profile_op_cancelled") });
  if (ctx.callbackQuery.message) {
    await ctx.editMessageText(`<b>${t(ctx.lang, "profile_op_cancelled")}</b>`, { parse_mode: "HTML" }).catch(() => {});
  }
});

superAdminOrOwner.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return next();

  const text = ctx.message.text.trim();
  const isCancel = ["/cancel", "cancel"].includes(text.toLowerCase());

  if (replyTo.text.includes("#PROFILE_NAME#")) {
    if (isCancel) {
      await ctx.reply(t(ctx.lang, "profile_op_cancelled"));
      return;
    }
    if (text.length === 0 || text.length > 64) {
      await ctx.reply(t(ctx.lang, "profile_name_too_long", { max: 64 }), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true }
      });
      return;
    }
    try {
      await ctx.api.setMyName(text);
      await ctx.reply(t(ctx.lang, "profile_name_updated", { name: escapeHtml(text) }), { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(t(ctx.lang, "profile_api_error", { err: escapeHtml(err?.message || "Unknown error") }), { parse_mode: "HTML" });
    }
    return;
  }

  if (replyTo.text.includes("#PROFILE_DESC#")) {
    if (isCancel) {
      await ctx.reply(t(ctx.lang, "profile_op_cancelled"));
      return;
    }
    if (text.length > 512) {
      await ctx.reply(t(ctx.lang, "profile_desc_too_long", { max: 512 }), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true }
      });
      return;
    }
    try {
      await ctx.api.setMyDescription(text);
      await ctx.reply(t(ctx.lang, "profile_desc_updated"), { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(t(ctx.lang, "profile_api_error", { err: escapeHtml(err?.message || "Unknown error") }), { parse_mode: "HTML" });
    }
    return;
  }

  if (replyTo.text.includes("#PROFILE_SHORT_DESC#")) {
    if (isCancel) {
      await ctx.reply(t(ctx.lang, "profile_op_cancelled"));
      return;
    }
    if (text.length > 120) {
      await ctx.reply(t(ctx.lang, "profile_short_desc_too_long", { max: 120 }), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true }
      });
      return;
    }
    try {
      await ctx.api.setMyShortDescription(text);
      await ctx.reply(t(ctx.lang, "profile_short_desc_updated"), { parse_mode: "HTML" });
    } catch (err: any) {
      await ctx.reply(t(ctx.lang, "profile_api_error", { err: escapeHtml(err?.message || "Unknown error") }), { parse_mode: "HTML" });
    }
    return;
  }

  return next();
});
