import { Composer, InlineKeyboard } from "grammy";
import { MyContext, ForceChannel } from "../../core/types";
import { ACTIONS } from "../../config";
import { escapeHtml, botIdFromToken } from "../../shared/formatters";
import { ButtonFactory, sanitizeInviteLink } from "../../shared/buttons";
import { invalidateForceChannelsCache } from "./service";
import { LoggerService, isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const fjMenuComposer = new Composer<MyContext>();
const adminOnly = fjMenuComposer.filter((ctx) => ctx.isAdmin);

export async function renderAdminForceJoinMenu(ctx: MyContext): Promise<{ text: string; reply_markup: InlineKeyboard }> {
  const lang = ctx.lang;
  let rows: { results?: ForceChannel[] };
  try {
    rows = await ctx.env.DB.prepare(
      "SELECT channel_id, channel_name, button_text, invite_link, target_limit, is_active " +
      "FROM force_channels ORDER BY created_at ASC, rowid ASC"
    ).all<ForceChannel>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return { text: "", reply_markup: ButtonFactory.empty() };
    }
    throw err;
  }

  const allChannels = rows.results || [];
  if (allChannels.length === 0) {
    return {
      text: t(lang, "fj_menu_empty"),
      reply_markup: ButtonFactory.forceJoinAdminKeyboard(lang, [], ctx.isAdmin),
    };
  }

  let text = `<blockquote><b>${t(lang, "fj_menu_title")}</b></blockquote>\n\n`;

  allChannels.forEach((ch, idx) => {
    const status = ch.is_active === 1 ? t(lang, "fj_status_active") : t(lang, "fj_status_inactive");
    const cap = ch.target_limit > 0
      ? t(lang, "fj_cap_members", { count: ch.target_limit })
      : t(lang, "fj_wizard_unlimited");

    text += `<b>${idx + 1}. ${escapeHtml(ch.channel_name)}</b>\n`;
    text += `   - ${t(lang, "fj_label_status")}: <b>${status}</b>\n`;
    text += `   - ${t(lang, "fj_label_btn")}: <code>${escapeHtml(ch.button_text)}</code>\n`;
    text += `   - ${t(lang, "fj_label_limit")}: <code>${cap}</code>\n`;
    text += `   - ${t(lang, "fj_label_id")}: <code>${ch.channel_id}</code>\n\n`;
  });

  return {
    text,
    reply_markup: ButtonFactory.forceJoinAdminKeyboard(lang, allChannels, ctx.isAdmin),
  };
}

async function refreshForceJoinMenu(ctx: MyContext): Promise<void> {
  const menu = await renderAdminForceJoinMenu(ctx);
  await ctx.editMessageText(menu.text, {
    parse_mode: "HTML",
    reply_markup: menu.reply_markup,
    link_preview_options: { is_disabled: true },
  }).catch(() => {});
}

async function deactivateDeadForceChannel(ctx: MyContext, channelId: string, reason: string): Promise<void> {
  const res = await ctx.env.DB.prepare(
    "UPDATE force_channels SET is_active = 0 WHERE channel_id = ? AND is_active = 1"
  ).bind(channelId).run();
  invalidateForceChannelsCache();
  if ((res.meta?.changes ?? 0) === 0) return;
  LoggerService.alert(
    ctx.api,
    ctx.env,
    ctx.executionCtx,
    `fj_dead:${channelId}`,
    `⚠️ <b>[FORCE-JOIN]</b> Channel <code>${escapeHtml(channelId)}</code> was deactivated after an admin recheck.\n<blockquote expandable>${escapeHtml(reason.slice(0, 800))}</blockquote>`
  );
}

adminOnly.command(["fjmenu", "forcejoin", "channels"], async (ctx) => {
  const menu = await renderAdminForceJoinMenu(ctx);
  await ctx.reply(menu.text, {
    parse_mode: "HTML",
    reply_markup: menu.reply_markup,
    link_preview_options: { is_disabled: true }
  });
});

adminOnly.callbackQuery(ACTIONS.FJ_MENU_REFRESH, async (ctx) => {
  await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_menu_refreshed") }).catch(() => {});
  await refreshForceJoinMenu(ctx);
});

adminOnly.callbackQuery(new RegExp(`^${ACTIONS.FJ_RECHECK}(-\\d+)$`), async (ctx) => {
  const channelId = ctx.match[1];
  const botId = botIdFromToken(ctx.env.BOT_TOKEN);
  if (!botId) return;

  try {
    const member = await ctx.api.getChatMember(channelId, botId);
    if (member.status !== "creator" && member.status !== "administrator") {
      await deactivateDeadForceChannel(ctx, channelId, "bot is not an administrator");
      await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_recheck_not_admin"), show_alert: true }).catch(() => {});
      await refreshForceJoinMenu(ctx);
      return;
    }
    if (member.status === "administrator" && !member.can_invite_users) {
      await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_recheck_no_invite"), show_alert: true }).catch(() => {});
      return;
    }

    const ch = await ctx.env.DB.prepare("SELECT invite_link, target_limit FROM force_channels WHERE channel_id = ?")
      .bind(channelId).first<{ invite_link: string; target_limit: number }>();

    if (ch?.invite_link && ch.target_limit > 0) {
      const linkInfo = await ctx.api.editChatInviteLink(channelId, ch.invite_link).catch(() => null);
      if (linkInfo?.is_revoked) {
        await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_recheck_link_expired"), show_alert: true }).catch(() => {});
        return;
      }
    }

    await ctx.env.DB.prepare("UPDATE force_channels SET is_active = 1 WHERE channel_id = ?").bind(channelId).run();
    invalidateForceChannelsCache();

    await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_channel_reactivated") }).catch(() => {});
    await refreshForceJoinMenu(ctx);
  } catch (err: unknown) {
    const message = (err as { message?: string })?.message || "unknown";
    const lower = message.toLowerCase();
    if (
      lower.includes("chat_admin_required") ||
      lower.includes("bot was kicked") ||
      lower.includes("chat not found") ||
      lower.includes("bot is not a member")
    ) {
      await deactivateDeadForceChannel(ctx, channelId, message);
      await refreshForceJoinMenu(ctx);
    }
    await ctx.answerCallbackQuery({
      text: t(ctx.lang, "fj_recheck_error", { err: message.slice(0, 120) }),
      show_alert: true,
    }).catch(() => {});
  }
});

adminOnly.command("delchannel", async (ctx) => {
  const channelId = ctx.match?.trim();
  if (!channelId) return ctx.reply(t(ctx.lang, "fj_delchannel_usage"), { parse_mode: "HTML" });

  const prev = await ctx.env.DB.prepare("SELECT invite_link FROM force_channels WHERE channel_id = ?").bind(channelId).first<{ invite_link: string }>();
  if (prev?.invite_link && ctx.executionCtx) {
    ctx.executionCtx.waitUntil(ctx.api.revokeChatInviteLink(channelId, prev.invite_link).catch(() => {}));
  }

  await ctx.env.DB.prepare("DELETE FROM force_channels WHERE channel_id = ?").bind(channelId).run();
  invalidateForceChannelsCache();
  await ctx.reply(t(ctx.lang, "fj_delchannel_success"));
});

adminOnly.callbackQuery(new RegExp(`^${ACTIONS.FJ_DELETE}(-\\d+)$`), async (ctx) => {
  await ctx.answerCallbackQuery({ text: t(ctx.lang, "fj_menu_deleted") }).catch(() => {});
  const channelId = ctx.match[1];
  const prev = await ctx.env.DB.prepare("SELECT invite_link FROM force_channels WHERE channel_id = ?").bind(channelId).first<{ invite_link: string }>();
  if (prev?.invite_link && ctx.executionCtx) {
    ctx.executionCtx.waitUntil(ctx.api.revokeChatInviteLink(channelId, prev.invite_link).catch(() => {}));
  }

  await ctx.env.DB.prepare("DELETE FROM force_channels WHERE channel_id = ?").bind(channelId).run();
  invalidateForceChannelsCache();
  await refreshForceJoinMenu(ctx);
});

adminOnly.callbackQuery(new RegExp(`^${ACTIONS.FJ_STATS}(-\\d+)$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const channelId = ctx.match[1];
  const ch = await ctx.env.DB.prepare("SELECT * FROM force_channels WHERE channel_id = ?").bind(channelId).first<ForceChannel>();
  if (!ch) return;

  let limit = ch.target_limit > 0
    ? t(ctx.lang, "fj_cap_members", { count: ch.target_limit })
    : t(ctx.lang, "fj_wizard_unlimited");
  let status = ch.is_active === 1 ? t(ctx.lang, "fj_audit_status_active") : t(ctx.lang, "fj_audit_status_inactive");

  if (ch.target_limit > 0) {
    try {
      const linkInfo = await ctx.api.editChatInviteLink(channelId, ch.invite_link);
      if (linkInfo.member_limit) limit = t(ctx.lang, "fj_cap_members", { count: linkInfo.member_limit });
      if (linkInfo.is_revoked) status = t(ctx.lang, "fj_audit_status_revoked");
    } catch {
      // Keep the stored snapshot when Telegram does not return link info.
    }
  }

  await ctx.reply(
    t(ctx.lang, "fj_audit_body", {
      name: escapeHtml(ch.channel_name),
      limit: escapeHtml(limit),
      status: escapeHtml(status),
      link: escapeHtml(ch.invite_link),
    }),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
});

adminOnly.callbackQuery(new RegExp(`^${ACTIONS.FJ_RENEW}(-\\d+)$`), async (ctx) => {
  await ctx.answerCallbackQuery();
  const channelId = ctx.match[1];
  await ctx.reply(
    t(ctx.lang, "fj_renew_prompt", { id: channelId }),
    { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
  );
});

adminOnly.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text || !replyTo.text.includes("#RENEW_")) return next();

  const match = replyTo.text.match(/#RENEW_(-\d+)/);
  if (!match) return next();

  const channelId = match[1];
  const inputVal = ctx.message.text.trim();

  if (["/cancel", "cancel"].includes(inputVal.toLowerCase())) {
    await ctx.reply(t(ctx.lang, "fj_renew_cancelled"));
    return;
  }

  if (!/^\d+$/.test(inputVal)) {
    await ctx.reply(t(ctx.lang, "fj_renew_invalid", { id: channelId }), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }

  const newLimit = parseInt(inputVal, 10);
  if (newLimit > 99999) {
    await ctx.reply(t(ctx.lang, "fj_renew_max", { id: channelId }), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }

  try {
    const params: { name: string; member_limit?: number } = {
      name: `Renew_${newLimit > 0 ? newLimit : "unlim"}_${Date.now().toString().slice(-4)}`
    };
    if (newLimit > 0) params.member_limit = newLimit;

    const newInvite = await ctx.api.createChatInviteLink(channelId, params);
    const sanitizedLink = sanitizeInviteLink(newInvite.invite_link);

    const prev = await ctx.env.DB.prepare("SELECT invite_link FROM force_channels WHERE channel_id = ?")
      .bind(channelId).first<{ invite_link: string }>();

    await ctx.env.DB.prepare("UPDATE force_channels SET invite_link = ?, target_limit = ?, is_active = 1 WHERE channel_id = ?")
      .bind(sanitizedLink, newLimit, channelId).run();

    invalidateForceChannelsCache();

    if (prev?.invite_link && prev.invite_link !== sanitizedLink) {
      ctx.api.revokeChatInviteLink(channelId, prev.invite_link).catch(() => {});
    }

    const limitLabel = newLimit > 0
      ? t(ctx.lang, "fj_cap_members", { count: newLimit })
      : t(ctx.lang, "fj_wizard_unlimited");
    await ctx.reply(
      t(ctx.lang, "fj_renew_success", { limit: limitLabel, link: escapeHtml(sanitizedLink) }),
      { parse_mode: "HTML" }
    );
  } catch (err: unknown) {
    const message = (err as { message?: string })?.message || "";
    await ctx.reply(t(ctx.lang, "fj_create_link_error", { err: escapeHtml(message) }), { parse_mode: "HTML" });
  }
});

adminOnly.callbackQuery(new RegExp(`^${ACTIONS.FJ_EDIT_LABEL}(-\\d+)$`), async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const channelId = ctx.match[1];
  const ch = await ctx.env.DB.prepare("SELECT channel_name, button_text FROM force_channels WHERE channel_id = ?").bind(channelId).first<ForceChannel>();
  if (!ch) return;

  await ctx.reply(
    t(ctx.lang, "fj_label_prompt", {
      name: escapeHtml(ch.channel_name),
      current: escapeHtml(ch.button_text),
      id: channelId,
    }),
    { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } }
  );
});

adminOnly.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text || !replyTo.text.includes("#SETLABEL_")) return next();

  const match = replyTo.text.match(/#SETLABEL_(-\d+)/);
  if (!match) return next();

  const channelId = match[1];
  const newName = ctx.message.text.trim();

  if (["/cancel", "cancel"].includes(newName.toLowerCase())) {
    await ctx.reply(t(ctx.lang, "fj_label_cancelled"));
    return;
  }
  if (newName.length < 2 || newName.length > 40) {
    await ctx.reply(t(ctx.lang, "fj_label_length", { id: channelId }), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
    return;
  }

  await ctx.env.DB.prepare("UPDATE force_channels SET button_text = ? WHERE channel_id = ?").bind(newName, channelId).run();
  invalidateForceChannelsCache();
  await ctx.reply(t(ctx.lang, "fj_label_updated", { name: escapeHtml(newName) }), { parse_mode: "HTML" });
});

adminOnly.command("setchannelbtn", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length < 2) return ctx.reply(t(ctx.lang, "fj_setchannelbtn_usage"), { parse_mode: "HTML" });

  const [channelId, ...textParts] = parts;
  const newName = textParts.join(" ").trim();

  if (newName.length < 2 || newName.length > 40) return ctx.reply(t(ctx.lang, "fj_setchannelbtn_length"));

  const res = await ctx.env.DB.prepare("UPDATE force_channels SET button_text = ? WHERE channel_id = ?").bind(newName, channelId).run();
  if (res.meta.changes === 0) return ctx.reply(t(ctx.lang, "fj_channel_id_not_found"));

  invalidateForceChannelsCache();
  await ctx.reply(t(ctx.lang, "fj_label_updated", { name: escapeHtml(newName) }), { parse_mode: "HTML" });
});
