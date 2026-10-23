import { Composer, InputFile } from "grammy";
import { MyContext } from "../../core/types";
import { getFactoryResetTarget, getDynamicConfig, invalidateDynamicConfigCache, LIMITS } from "../../config";
import { invalidateAdminCache, invalidateVipCache } from "../../middlewares/auth";
import { invalidateForceChannelsCache } from "../force_join/service";
import { LoggerService, isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const adminMaintenanceComposer = new Composer<MyContext>();
const ownerOnly = adminMaintenanceComposer.filter((ctx) => ctx.isOwner);

const ALLOWED_CONFIG_KEYS = new Set([
  "maintenance_mode",
  "daily_download_limit",
  "file_daily_limit",
  "auto_delete_seconds",
  "default_language",
  "global_protect_content",
  "log_channel_id",
  "cfg_fj_verify_btn",
  "default_bundle_ttl_seconds",
  "publish_channel_id",
]);

interface ValidatedForceChannel {
  channel_id: string;
  channel_name: string;
  button_text: string;
  invite_link: string;
  target_limit: number;
  is_active: number;
  created_at: number;
}

ownerOnly.command(["maintenance", "maint"], async (ctx) => {
  const current = await getDynamicConfig(ctx.env, "maintenance_mode", "0");
  const nextMode = current === "1" ? "0" : "1";
  await ctx.env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('maintenance_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(nextMode).run();
  invalidateDynamicConfigCache();
  const msgKey = nextMode === "1" ? "maint_mode_enabled" : "maint_mode_disabled";
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "maintenance", ctx.from!.id, {
    mode: nextMode === "1" ? "on" : "off",
  });
  await ctx.reply(t(ctx.lang, msgKey), { parse_mode: "HTML" });
});

ownerOnly.command(["resetfactory", "factoryreset"], async (ctx) => {
  const arg = (ctx.match || "").trim().toLowerCase();
  if (arg !== "confirm") {
    return ctx.reply(t(ctx.lang, "maint_factory_confirm"), { parse_mode: "HTML" });
  }

  const targetChat = await getFactoryResetTarget(ctx.env);
  let snapshotDelivered = false;

  try {
    const [configs, forceChannels, counts] = await Promise.all([
      ctx.env.DB.prepare("SELECT key, value FROM system_config").all(),
      ctx.env.DB.prepare("SELECT * FROM force_channels").all(),
      ctx.env.DB.prepare("SELECT (SELECT COUNT(*) FROM bundles) as b, (SELECT COUNT(*) FROM admins) as a").first<{ b: number; a: number }>()
    ]);

    const backup = {
      timestamp: new Date().toISOString(),
      action: "RESET_FACTORY_WIPE",
      counts,
      configs: configs.results,
      forceChannels: forceChannels.results
    };
    const jsonBuffer = new TextEncoder().encode(JSON.stringify(backup, null, 2));

    const rawCaption = t(ctx.lang, "maint_backup_caption");
    const safeCaption = rawCaption.length > 1024 ? rawCaption.slice(0, 1020) + "..." : rawCaption;

    await ctx.api.sendDocument(
      targetChat,
      new InputFile(jsonBuffer, `factory-reset-backup-${Date.now()}.json`),
      { caption: safeCaption, parse_mode: "HTML" }
    );
    snapshotDelivered = true;
  } catch (err) {
    console.error("Factory reset backup delivery failed:", err);
  }

  if (!snapshotDelivered) {
    return ctx.reply(t(ctx.lang, "maint_backup_failed"), { parse_mode: "HTML" });
  }

  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM bundles"),
    ctx.env.DB.prepare("DELETE FROM bundle_votes"),
    ctx.env.DB.prepare("DELETE FROM admin_sessions"),
    ctx.env.DB.prepare("DELETE FROM deletion_queue"),
    ctx.env.DB.prepare("DELETE FROM user_quotas"),
    ctx.env.DB.prepare("DELETE FROM user_downloads"),
    ctx.env.DB.prepare("DELETE FROM force_channels"),
    ctx.env.DB.prepare("DELETE FROM vips")
  ]);

  invalidateAdminCache();
  invalidateVipCache();
  invalidateDynamicConfigCache();
  invalidateForceChannelsCache();

  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "factoryreset", ctx.from!.id, {
    backup: "delivered",
  });
  await ctx.reply(t(ctx.lang, "maint_factory_reset_done"), { parse_mode: "HTML" });
});

ownerOnly.command("restore", async (ctx) => {
  const doc = ctx.message?.reply_to_message?.document;
  if (!doc) {
    return ctx.reply(t(ctx.lang, "restore_usage"), { parse_mode: "HTML" });
  }

  const isJsonFile =
    Boolean(doc.file_name?.toLowerCase().endsWith(".json")) ||
    doc.mime_type === "application/json";

  if (!doc.file_size || doc.file_size > 262_144 || !isJsonFile) {
    return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
  }

  let payload: Record<string, unknown>;
  try {
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
    }
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.env.BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) {
      return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
    }
    const text = await res.text();
    payload = JSON.parse(text);
  } catch (err) {
    console.error("Backup restore fetch/parse error:", (err as Error)?.message || err);
    return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
  }

  if (!payload || typeof payload !== "object") {
    return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
  }

  const validConfigs = new Map<string, string>();
  const parseConfigInput = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const item of input) {
        if (item && typeof item === "object") {
          const key = String((item as { key?: unknown }).key || "").trim();
          const val = (item as { value?: unknown }).value;
          if (ALLOWED_CONFIG_KEYS.has(key) && (typeof val === "string" || typeof val === "number")) {
            validConfigs.set(key, String(val));
          }
        }
      }
    } else if (input && typeof input === "object") {
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        const trimmedKey = key.trim();
        if (ALLOWED_CONFIG_KEYS.has(trimmedKey) && (typeof val === "string" || typeof val === "number")) {
          validConfigs.set(trimmedKey, String(val));
        }
      }
    }
  };

  if (payload.configs) parseConfigInput(payload.configs);
  if (payload.system_config) parseConfigInput(payload.system_config);

  const validChannels: ValidatedForceChannel[] = [];
  const parseChannelInput = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const raw of input) {
        if (validChannels.length >= LIMITS.MAX_FORCE_JOIN_CHANNELS) break;
        if (!raw || typeof raw !== "object") continue;
        const ch = raw as Record<string, unknown>;

        const channelId = String(ch.channel_id ?? "").trim();
        if (!/^-\d+$/.test(channelId)) continue;
        if (validChannels.some((existing) => existing.channel_id === channelId)) continue;

        const rawName = String(ch.channel_name ?? "").trim();
        const channelName = rawName || channelId;

        const buttonText = String(ch.button_text ?? ch.button_label ?? "").trim();

        const inviteLink = String(ch.invite_link ?? "").trim();
        if (!/^(https?:\/\/|tg:\/\/)/i.test(inviteLink)) continue;

        const rawLimit = Number(ch.target_limit ?? ch.member_limit ?? 0);
        const targetLimit = Number.isInteger(rawLimit) && rawLimit >= 0 ? rawLimit : 0;

        const isActive = ch.is_active === 0 || ch.is_active === "0" || ch.is_active === false ? 0 : 1;

        const rawCreatedAt = Number(ch.created_at ?? 0);
        const createdAt =
          Number.isInteger(rawCreatedAt) && rawCreatedAt > 0
            ? rawCreatedAt
            : Math.floor(Date.now() / 1000);

        validChannels.push({
          channel_id: channelId,
          channel_name: channelName,
          button_text: buttonText,
          invite_link: inviteLink,
          target_limit: targetLimit,
          is_active: isActive,
          created_at: createdAt,
        });
      }
    }
  };

  if (payload.forceChannels) parseChannelInput(payload.forceChannels);
  if (payload.force_channels) parseChannelInput(payload.force_channels);

  if (validConfigs.size === 0 && validChannels.length === 0) {
    return ctx.reply(t(ctx.lang, "restore_invalid_file"), { parse_mode: "HTML" });
  }

  const statements = [];

  for (const [key, value] of validConfigs.entries()) {
    statements.push(
      ctx.env.DB.prepare(
        "INSERT INTO system_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(key, value)
    );
  }

  for (const ch of validChannels) {
    statements.push(
      ctx.env.DB.prepare(
        "INSERT INTO force_channels (channel_id, channel_name, button_text, invite_link, target_limit, is_active, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(channel_id) DO UPDATE SET channel_name = excluded.channel_name, button_text = excluded.button_text, " +
        "invite_link = excluded.invite_link, target_limit = excluded.target_limit, is_active = excluded.is_active"
      ).bind(ch.channel_id, ch.channel_name, ch.button_text, ch.invite_link, ch.target_limit, ch.is_active, ch.created_at)
    );
  }

  try {
    await ctx.env.DB.batch(statements);
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }

  invalidateDynamicConfigCache();
  invalidateForceChannelsCache();

  const configCount = validConfigs.size;
  const channelCount = validChannels.length;

  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "restore", ctx.from!.id, {
    configs: configCount,
    channels: channelCount,
  });

  await ctx.reply(t(ctx.lang, "restore_success", { configs: configCount, channels: channelCount }), {
    parse_mode: "HTML",
  });
});