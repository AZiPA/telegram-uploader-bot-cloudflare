import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { getDynamicConfig, invalidateDynamicConfigCache, LIMITS, ACTIONS } from "../../config";
import { configuredChatId, escapeHtml } from "../../shared/formatters";
import { ButtonFactory } from "../../shared/buttons";
import { LoggerService } from "../../core/logger";
import { parseDurationSec } from "../bundles/protected";
import { t } from "../../locales";

export const adminSettingsComposer = new Composer<MyContext>();
const superAdminOrOwner = adminSettingsComposer.filter((ctx) => ctx.isSuperAdmin);
const ownerOnly = adminSettingsComposer.filter((ctx) => ctx.isOwner);

function describeLogTarget(lang: string, configured: string, secret: unknown): string {
  const raw = configured.trim();
  const key = raw.toLowerCase();
  if (key === "off" || key === "disable" || key === "disabled" || key === "clear" || key === "none") {
    return t(lang, "settings_log_off");
  }
  if (key === "owner" || key === "me") return t(lang, "settings_log_owner");
  if (/^-\d+$/.test(raw)) return raw;
  if (!raw) {
    return configuredChatId(secret) || t(lang, "settings_log_unset");
  }
  return t(lang, "settings_log_off");
}

export async function renderSettingsMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.lang;
  const [dailyLimit, linkLimit, autoDel, maintMode, defaultLang, protectContent, logChannel, pubChannel, bundleTtl] = await Promise.all([
    getDynamicConfig(ctx.env, "daily_download_limit", String(LIMITS.DEFAULT_DAILY_DOWNLOADS)),
    getDynamicConfig(ctx.env, "file_daily_limit", String(LIMITS.DEFAULT_FILE_DAILY_LIMIT)),
    getDynamicConfig(ctx.env, "auto_delete_seconds", "0"),
    getDynamicConfig(ctx.env, "maintenance_mode", "0"),
    getDynamicConfig(ctx.env, "default_language", "en"),
    getDynamicConfig(ctx.env, "global_protect_content", "0"),
    getDynamicConfig(ctx.env, "log_channel_id", ""),
    getDynamicConfig(ctx.env, "publish_channel_id", ""),
    getDynamicConfig(ctx.env, "default_bundle_ttl_seconds", "0")
  ]);

  const isMaintActive = maintMode === "1";
  const isProtectActive = protectContent === "1";

  const autoDelDisplay = autoDel === "0" ? t(lang, "label_disabled") : `${escapeHtml(autoDel)}s`;
  const maintStatus = isMaintActive ? t(lang, "status_active_red") : t(lang, "status_inactive_green");
  const protectStatus = isProtectActive ? t(lang, "status_enabled_shield") : t(lang, "label_disabled");
  const logStatus = describeLogTarget(lang, logChannel, ctx.env.LOG_CHANNEL_ID);
  const pubChannelDisplay = pubChannel ? escapeHtml(pubChannel) : t(lang, "settings_log_unset");

  const ttlVal = parseInt(bundleTtl, 10) || 0;
  const bundleTtlDisplay =
    ttlVal === 0
      ? t(lang, "label_disabled")
      : ttlVal >= 86400
      ? `${Math.round(ttlVal / 86400)}d`
      : ttlVal >= 3600
      ? `${Math.round(ttlVal / 3600)}h`
      : `${ttlVal}s`;

  const safeDaily = escapeHtml(dailyLimit);
  const safeLink = escapeHtml(linkLimit);
  const safeLang = escapeHtml(defaultLang.toUpperCase());

  let text =
    `${t(lang, "settings_title")}\n\n` +
    `📥 <b>${t(lang, "settings_daily_limit")}:</b> <code>${safeDaily}</code> (/setdailylimit)\n` +
    `📢 <b>${t(lang, "settings_pub_channel")}:</b> <code>${pubChannelDisplay}</code> (/setpubchannel)\n` +
    `🤖 <b>${t(lang, "settings_bot_profile")}:</b> ${t(lang, "settings_configured")} (/botprofile)\n`;

  if (ctx.isOwner) {
    text +=
      `\n👑 <b>${t(lang, "settings_owner_controls")}:</b>\n` +
      `   - ${t(lang, "settings_autodel_delay")}: <code>${autoDelDisplay}</code> (/setautodel)\n` +
      `   - ${t(lang, "settings_bundle_ttl")}: <code>${bundleTtlDisplay}</code> (/setbundlettl)\n` +
      `   - ${t(lang, "settings_file_limit")}: <code>${safeLink}</code> (/setfilelimit)\n` +
      `   - ${t(lang, "settings_maint_mode")}: <code>${maintStatus}</code>\n` +
      `   - ${t(lang, "settings_default_lang")}: <code>${safeLang}</code>\n` +
      `   - ${t(lang, "settings_protect_content")}: <code>${protectStatus}</code>\n` +
      `   - ${t(lang, "settings_log_channel")}: <code>${escapeHtml(logStatus)}</code> (/setlogchannel)\n`;
  }

  const autoDelVal = autoDel === "0" ? t(lang, "label_disabled") : `${autoDel}s`;
  const langVal = defaultLang === "fa" ? t(lang, "label_lang_fa") : t(lang, "label_lang_en");
  const kb = ButtonFactory.settingsKeyboard(lang, {
    isOwner: ctx.isOwner,
    isMaintActive,
    autoDelLabel: autoDelVal,
    bundleTtlLabel: bundleTtlDisplay,
    langLabel: langVal,
    isProtectActive,
  });

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {
      return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

// 1. Settings Menu Entrypoints
superAdminOrOwner.command(["botconfig", "settings"], async (ctx) => {
  await renderSettingsMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_MENU, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSettingsMenu(ctx);
});

// 2. Daily Download Quota & Publish Channel (Super Admin & Owner)
superAdminOrOwner.command("setdailylimit", async (ctx) => {
  const val = ctx.match?.trim();
  if (!val || !/^\d+$/.test(val)) return ctx.reply(t(ctx.lang, "usage_setdailylimit"), { parse_mode: "HTML" });
  await ctx.env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('daily_download_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(val).run();
  invalidateDynamicConfigCache();
  await ctx.reply(t(ctx.lang, "daily_limit_updated", { val }), { parse_mode: "HTML" });
});

superAdminOrOwner.command("setpubchannel", async (ctx) => {
  const raw = ctx.match?.trim() || "";
  if (!raw) {
    return ctx.reply(t(ctx.lang, "usage_setpubchannel"), { parse_mode: "HTML" });
  }

  const key = raw.toLowerCase();
  let stored = "";
  if (key === "off" || key === "clear" || key === "disable") {
    stored = "";
  } else if (/^-\d{5,20}$/.test(raw)) {
    stored = raw;
  } else {
    return ctx.reply(t(ctx.lang, "usage_setpubchannel"), { parse_mode: "HTML" });
  }

  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('publish_channel_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(stored).run();
  invalidateDynamicConfigCache();

  if (!stored) {
    await ctx.reply(t(ctx.lang, "pubchannel_cleared_msg"), { parse_mode: "HTML" });
  } else {
    await ctx.reply(t(ctx.lang, "pubchannel_updated_msg", { target: escapeHtml(stored) }), { parse_mode: "HTML" });
  }
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_DAILY_LIMIT, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(t(ctx.lang, "prompt_set_daily_limit"), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }
  });
});

// 3. OWNER ONLY Commands
ownerOnly.command("setfilelimit", async (ctx) => {
  const val = ctx.match?.trim();
  if (!val || !/^\d+$/.test(val)) return ctx.reply(t(ctx.lang, "usage_setfilelimit"), { parse_mode: "HTML" });
  await ctx.env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('file_daily_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(val).run();
  invalidateDynamicConfigCache();
  await ctx.reply(t(ctx.lang, "file_limit_updated", { val }), { parse_mode: "HTML" });
});

ownerOnly.command("setautodel", async (ctx) => {
  const raw = ctx.match?.trim();
  if (!raw || !/^\d+$/.test(raw)) return ctx.reply(t(ctx.lang, "usage_setautodel"), { parse_mode: "HTML" });
  const val = Number(raw);
  if (val !== 0 && (val < 10 || val > 172800)) {
    return ctx.reply(t(ctx.lang, "usage_setautodel"), { parse_mode: "HTML" });
  }
  await ctx.env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('auto_delete_seconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(val)).run();
  invalidateDynamicConfigCache();
  await ctx.reply(t(ctx.lang, "autodel_timer_updated", { val: String(val) }), { parse_mode: "HTML" });
});

ownerOnly.command("setbundlettl", async (ctx) => {
  const raw = ctx.match?.trim();
  if (!raw) return ctx.reply(t(ctx.lang, "usage_setbundlettl"), { parse_mode: "HTML" });
  const sec = parseDurationSec(raw);
  if (sec === null || sec < 0) {
    return ctx.reply(t(ctx.lang, "usage_setbundlettl"), { parse_mode: "HTML" });
  }
  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('default_bundle_ttl_seconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(sec)).run();
  invalidateDynamicConfigCache();
  const valStr =
    sec === 0
      ? t(ctx.lang, "label_disabled")
      : sec >= 86400
      ? `${Math.round(sec / 86400)}d`
      : sec >= 3600
      ? `${Math.round(sec / 3600)}h`
      : `${sec}s`;
  await ctx.reply(t(ctx.lang, "bundle_ttl_updated_msg", { val: valStr }), { parse_mode: "HTML" });
});

ownerOnly.command("setlogchannel", async (ctx) => {
  const raw = ctx.match?.trim() || "";
  const key = raw.toLowerCase();
  if (!raw) {
    return ctx.reply(t(ctx.lang, "setlogchannel_usage"), { parse_mode: "HTML" });
  }

  let stored: string;
  let replyKey: "setlogchannel_off" | "setlogchannel_owner" | "setlogchannel_channel";
  if (key === "off" || key === "disable" || key === "disabled" || key === "clear" || key === "none") {
    stored = "off";
    replyKey = "setlogchannel_off";
  } else if (key === "owner" || key === "me") {
    stored = "owner";
    replyKey = "setlogchannel_owner";
  } else if (/^-\d{5,20}$/.test(raw)) {
    stored = raw;
    replyKey = "setlogchannel_channel";
  } else {
    return ctx.reply(t(ctx.lang, "setlogchannel_usage"), { parse_mode: "HTML" });
  }

  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('log_channel_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(stored).run();
  invalidateDynamicConfigCache();
  await ctx.reply(t(ctx.lang, replyKey, { target: escapeHtml(stored) }), { parse_mode: "HTML" });
});

// 4. OWNER ONLY Callbacks with Strict Guards
superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_MAINT, async (ctx) => {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "owner_only_alert"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const current = await getDynamicConfig(ctx.env, "maintenance_mode", "0");
  const nextMode = current === "1" ? "0" : "1";
  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('maintenance_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(nextMode).run();
  invalidateDynamicConfigCache();
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "maintenance", ctx.from!.id, {
    mode: nextMode === "1" ? "on" : "off",
    via: "settings",
  });
  await renderSettingsMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_AUTODEL, async (ctx) => {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "owner_only_alert"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const currentStr = await getDynamicConfig(ctx.env, "auto_delete_seconds", "0");
  const currentVal = parseInt(currentStr, 10) || 0;
  const presets = [0, 60, 300, 600, 1800, 3600];
  const currentIdx = presets.indexOf(currentVal);
  const nextVal = currentIdx >= 0 ? presets[(currentIdx + 1) % presets.length] : 0;

  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('auto_delete_seconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(nextVal)).run();
  invalidateDynamicConfigCache();

  await renderSettingsMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_BUNDLE_TTL, async (ctx) => {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "owner_only_alert"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const currentStr = await getDynamicConfig(ctx.env, "default_bundle_ttl_seconds", "0");
  const currentVal = parseInt(currentStr, 10) || 0;
  const presets = [0, 3600, 21600, 86400, 604800, 2592000];
  const currentIdx = presets.indexOf(currentVal);
  const nextVal = currentIdx >= 0 ? presets[(currentIdx + 1) % presets.length] : 0;

  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('default_bundle_ttl_seconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(String(nextVal)).run();
  invalidateDynamicConfigCache();

  await renderSettingsMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_LANG, async (ctx) => {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "owner_only_alert"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const current = await getDynamicConfig(ctx.env, "default_language", "en");
  const nextLang = current === "fa" ? "en" : "fa";
  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('default_language', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(nextLang).run();
  invalidateDynamicConfigCache();

  await renderSettingsMenu(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.SETTINGS_PROTECT, async (ctx) => {
  if (!ctx.isOwner) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "owner_only_alert"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const current = await getDynamicConfig(ctx.env, "global_protect_content", "0");
  const nextProtect = current === "1" ? "0" : "1";
  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('global_protect_content', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(nextProtect).run();
  invalidateDynamicConfigCache();

  await renderSettingsMenu(ctx);
});

// 5. ForceReply Message Handler for Settings Prompts
superAdminOrOwner.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return next();

  if (replyTo.text.includes("#SET_DAILY_LIMIT#")) {
    const text = ctx.message.text.trim();
    if (["/cancel", "cancel"].includes(text.toLowerCase())) {
      await ctx.reply(t(ctx.lang, "operation_cancelled"));
      return;
    }
    if (!/^\d+$/.test(text)) {
      await ctx.reply(t(ctx.lang, "invalid_number_format"), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true }
      });
      return;
    }
    await ctx.env.DB.prepare(
      "INSERT INTO system_config (key, value) VALUES ('daily_download_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(text).run();
    invalidateDynamicConfigCache();
    await ctx.reply(t(ctx.lang, "daily_limit_updated", { val: text }), { parse_mode: "HTML" });
    return;
  }

  return next();
});