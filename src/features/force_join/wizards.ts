import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { LIMITS, invalidateDynamicConfigCache } from "../../config";
import { escapeHtml, botIdFromToken } from "../../shared/formatters";
import { ButtonFactory, sanitizeInviteLink } from "../../shared/buttons";
import { invalidateForceChannelsCache } from "./service";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const fjWizardsComposer = new Composer<MyContext>();
const adminOnly = fjWizardsComposer.filter((ctx) => ctx.isAdmin);

adminOnly.command("addchannel", async (ctx) => {
  let channelId = "";
  let limit = 0;
  let customButtonText = "";

  const replyMsg = ctx.message?.reply_to_message;
  const parts = ctx.match?.trim().split(/\s+/) || [];

  let forwardChatId: number | string | null = null;
  if (replyMsg && "forward_origin" in replyMsg && (replyMsg.forward_origin as any)?.type === "channel") {
    forwardChatId = (replyMsg.forward_origin as any).chat.id;
  } else if (replyMsg && "forward_from_chat" in (replyMsg as any) && (replyMsg as any).forward_from_chat?.type === "channel") {
    forwardChatId = (replyMsg as any).forward_from_chat.id;
  }

  let explicitInviteLink = "";
  const remainingParts: string[] = [];

  if (forwardChatId) {
    channelId = String(forwardChatId);
    for (const part of parts) {
      if (part.includes("t.me/")) {
        explicitInviteLink = part;
      } else if (/^\d+$/.test(part) && limit === 0) {
        limit = parseInt(part, 10);
      } else if (part) {
        remainingParts.push(part);
      }
    }
  } else {
    if (!parts[0]) {
      return ctx.reply(t(ctx.lang, "fj_wizard_help"), { parse_mode: "HTML" });
    }
    channelId = parts[0];
    for (const part of parts.slice(1)) {
      if (part.includes("t.me/")) {
        explicitInviteLink = part;
      } else if (/^\d+$/.test(part) && limit === 0) {
        limit = parseInt(part, 10);
      } else if (part) {
        remainingParts.push(part);
      }
    }
  }

  if (remainingParts.length > 0) {
    customButtonText = remainingParts.join(" ");
  }

  if (!/^-\d+$/.test(channelId)) {
    return ctx.reply(t(ctx.lang, "fj_wizard_invalid_id"), { parse_mode: "HTML" });
  }

  try {
    const existingRows = await ctx.env.DB.prepare("SELECT button_text FROM force_channels WHERE channel_id != ?")
      .bind(channelId).all<{ button_text: string }>();

    if ((existingRows.results?.length ?? 0) >= LIMITS.MAX_FORCE_JOIN_CHANNELS) {
      return ctx.reply(t(ctx.lang, "fj_wizard_max_limit", { max: LIMITS.MAX_FORCE_JOIN_CHANNELS }));
    }

    const botId = botIdFromToken(ctx.env.BOT_TOKEN);
    if (!botId) return ctx.reply(t(ctx.lang, "fj_invalid_bot_token"));
    let channelTitle = t(ctx.lang, "fj_default_channel_title");

    let chat: Awaited<ReturnType<typeof ctx.api.getChat>> | null = null;
    try {
      const chatMember = await ctx.api.getChatMember(channelId, botId);
      chat = await ctx.api.getChat(channelId);
      if ("title" in chat && chat.title) {
        channelTitle = chat.title;
      }

      if (chatMember.status !== "administrator" && chatMember.status !== "creator") {
        return ctx.reply(t(ctx.lang, "fj_wizard_bot_not_admin"));
      }
      if (chatMember.status === "administrator" && !chatMember.can_invite_users) {
        return ctx.reply(t(ctx.lang, "fj_wizard_bot_no_invite_perm"), { parse_mode: "HTML" });
      }
    } catch (err: any) {
      return ctx.reply(t(ctx.lang, "fj_wizard_telegram_error", { err: escapeHtml(err?.message || "Unknown") }));
    }

    const prev = await ctx.env.DB.prepare("SELECT button_text, invite_link, target_limit FROM force_channels WHERE channel_id = ?")
      .bind(channelId).first<{ button_text: string; invite_link: string; target_limit: number }>();

    if (!customButtonText) {
      const usedLabels = new Set((existingRows.results || []).map((r) => r.button_text));
      customButtonText = prev?.button_text || ButtonFactory.getFirstAvailableOrdinal(usedLabels, ctx.lang);
    }

    let inviteLink = "";
    if (explicitInviteLink) {
      inviteLink = sanitizeInviteLink(explicitInviteLink);
    } else if (limit <= 0 && prev?.invite_link && (!prev.target_limit || prev.target_limit <= 0)) {
      // Preserve existing permanent link without generating a new one
      inviteLink = sanitizeInviteLink(prev.invite_link);
    } else if (limit <= 0 && chat && "username" in chat && chat.username) {
      // Use permanent public channel link
      inviteLink = `https://t.me/${chat.username}`;
    } else {
      try {
        const params: { name: string; member_limit?: number } = {
          name: `FS_${limit > 0 ? limit : "unlim"}_${Date.now().toString().slice(-4)}`
        };
        if (limit > 0) params.member_limit = limit;

        const created = await ctx.api.createChatInviteLink(channelId, params);
        inviteLink = sanitizeInviteLink(created.invite_link);
      } catch (err: any) {
        return ctx.reply(t(ctx.lang, "fj_wizard_create_link_err", { err: escapeHtml(err?.message || "") }));
      }
    }

    await ctx.env.DB.prepare(
      "INSERT INTO force_channels (channel_id, channel_name, button_text, invite_link, target_limit, is_active, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(channel_id) DO UPDATE SET " +
      "channel_name = excluded.channel_name, button_text = excluded.button_text, invite_link = excluded.invite_link, " +
      "target_limit = excluded.target_limit, is_active = 1"
    ).bind(channelId, channelTitle, customButtonText, inviteLink, limit, Math.floor(Date.now() / 1000)).run();

    invalidateForceChannelsCache();

    const limitLabel = limit > 0 ? `${limit}` : t(ctx.lang, "fj_wizard_unlimited");
    await ctx.reply(
      t(ctx.lang, "fj_wizard_success", {
        title: escapeHtml(channelTitle),
        btn: escapeHtml(customButtonText),
        limit: limitLabel,
        link: escapeHtml(inviteLink),
      }),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});

adminOnly.command("setverifybtn", async (ctx) => {
  const newText = ctx.match?.trim();
  if (!newText) return ctx.reply(t(ctx.lang, "fj_wizard_setverify_usage"), { parse_mode: "HTML" });

  try {
    await ctx.env.DB.prepare(
      "INSERT INTO system_config (key, value) VALUES ('cfg_fj_verify_btn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(newText).run();

    invalidateDynamicConfigCache();
    await ctx.reply(t(ctx.lang, "fj_wizard_setverify_success", { text: escapeHtml(newText) }), { parse_mode: "HTML" });
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});