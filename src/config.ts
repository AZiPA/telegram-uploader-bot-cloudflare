import { Env } from "./core/types";
import { configuredChatId } from "./shared/formatters";
import { setCappedMap } from "./shared/crypto";

export const UI_CONFIG = {
  /** Telegram Bot API 9.4 colored inline buttons ("primary" | "success" | "danger"). Free for all bots. */
  coloredButtons: true,
  /** Telegram Premium custom emoji icons on buttons (`icon_custom_emoji_id`). Keep false unless the BotFather owner account has active Telegram Premium, otherwise Telegram returns HTTP 400 BUTTON_CUSTOM_EMOJI_INVALID. */
  customEmojiIconsEnabled: false,
} as const;

/**
 * Global project constants & defaults.
 * Forkers can easily adjust these values to customize bot behavior.
 */
export const PROJECT_CONFIG = {
  // Default Cloudflare Worker name
  DEFAULT_WORKER_NAME: "telegram-filestore-bot",

  // Default D1 Database name
  DEFAULT_DB_NAME: "filestore-db",

  // Analytics Engine dataset name
  ANALYTICS_DATASET_NAME: "filestore_analytics",
} as const;

export const DEFAULT_BOT_INFO = {
  first_name: "File Store Bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} as const;

export const QUOTA_CACHE_CONFIG = {
  enabled: true, // Active by default
  ttlMs: 5 * 60 * 1000, // 5 minutes TTL
  maxEntries: 1000, // Strict memory ceiling (< 100 KB RAM)
  alertCooldownMs: 15 * 60 * 1000, // 15 minutes between log channel alerts
} as const;

/**
 * Compile-time logging defaults.
 * `enabled: true` ships the logger. It does not open a Telegram destination.
 * Telegram logs stay off until getEffectiveLogChannel resolves a target.
 */
export const LOGGING_CONFIG = {
  enabled: true,
  auditAdminActions: true,
  alertCooldownMs: 15 * 60 * 1000,
  maxDedupeEntries: 500,
  analyticsEnabled: true,
} as const;

export const LIMITS = {
  MAX_FORCE_JOIN_CHANNELS: 8,
  FORCE_JOIN_THROTTLE_SEC: 3,
  DEFAULT_DAILY_DOWNLOADS: 10,
  DEFAULT_FILE_DAILY_LIMIT: 3,
  RATE_LIMIT_BURST: 3,
  RATE_LIMIT_WINDOW_SEC: 5,
  MAX_BUNDLE_ITEMS: 25,
  MAX_PER_SESSION_UPLOAD: 20,
  CHUNK_DELIVERY_SIZE: 10,
  // Maximum non-owner admins (Super Admins + Regular Admins)
  MAX_ADMINS: 10,
  MAX_PASSCODE_ADMIN: 5,
  MAX_PASSCODE_SUPERADMIN: 15,
  OWNER_PASSCODE_WARN_THRESHOLD: 20,
  MAX_ROTATING_ADMIN: 3,
  MAX_ROTATING_SUPERADMIN: 10,
  MAX_ROTATING_PER_CHANNEL: 10,
  OWNER_ROTATING_WARN_THRESHOLD: 20,
  POST_SYNC_COOLDOWN_SEC: 300,
  OWNER_SYNC_WARN_COOLDOWN_SEC: 60,
} as const;

export const ACTIONS = {
  FORCE_JOIN_CHECK: "fjoin:check:",
  FJ_RENEW: "fj:renew:",
  FJ_RECHECK: "fj:recheck:",
  FJ_DELETE: "fj:del:",
  FJ_STATS: "fj:stats:",
  FJ_MENU_REFRESH: "fj:menu:refresh",
  FJ_EDIT_LABEL: "fj:editlbl:",
  VOTE_LIKE: "vote:like:",
  VOTE_DISLIKE: "vote:dislike:",
  REDOWNLOAD: "redl:",
  MAKE_PROTECTED: "b:prot:",
  BUNDLE_LOCK_OWNER: "b:lock:",
  BUNDLE_EXPIRY: "b:exp:",
  BUNDLE_ONETIME: "b:1x:",
  BUNDLE_PASS_PROMPT: "b:pass:",
  BUNDLE_POST_CHANNEL: "b:post:",
  BUNDLE_ROTATE_NOW: "b:rot:",
  BUNDLE_ROTATE_INT: "b:rint:",
  DELETE_CONFIRM_ASK: "b:askdel:",
  DELETE_CONFIRM_YES: "b:yesdel:",
  DELETE_CONFIRM_NO: "b:nodel:",
  MANAGE_DEL_ITEM: "mng:del:",
  MANAGE_REFRESH: "mng:ref:",
  MANAGE_HUB: "mng:hub:",
  CHUNK_DELIVERY: "dl:p:",
  BOT_PROFILE_MENU: "bprof:menu",
  BOT_PROFILE_SET_NAME: "bprof:name",
  BOT_PROFILE_SET_DESC: "bprof:desc",
  BOT_PROFILE_SET_SHORT_DESC: "bprof:short",
  BOT_PROFILE_CANCEL: "bprof:cancel",
  ADMIN_MENU: "adm:menu",
  ADMIN_REFRESH: "adm:ref",
  ADMIN_ADD_PROMPT: "adm:add",
  ADMIN_DEL: "adm:del:",
  SETTINGS_MENU: "set:menu",
  SETTINGS_DAILY_LIMIT: "set:daily",
  SETTINGS_MAINT: "set:maint",
  SETTINGS_AUTODEL: "set:autodel",
  SETTINGS_BUNDLE_TTL: "set:bttl",
  SETTINGS_LANG: "set:lang",
  SETTINGS_PROTECT: "set:protect",
  VIP_REFRESH: "vip:ref",
  VIP_CLEAR_ASK: "vip:askclr",
  VIP_CLEAR_YES: "vip:yesclr",
  VIP_CLEAR_NO: "vip:noclr",
} as const;

let dynamicConfigCache = new Map<string, { value: string; expiresAt: number }>();

export async function getDynamicConfig(
  env: Env,
  key: string,
  fallback: string,
  throwOnUncachedError = false
): Promise<string> {
  const now = Date.now();
  const hit = dynamicConfigCache.get(key);
  if (hit && now < hit.expiresAt) {
    return hit.value;
  }
  try {
    const row = await env.DB.prepare("SELECT value FROM system_config WHERE key = ?").bind(key).first<{ value: string }>();
    const value = row ? row.value : fallback;
    setCappedMap(dynamicConfigCache, key, { value, expiresAt: now + 60_000 }, 64);
    return value;
  } catch (err) {
    if (hit) return hit.value;
    if (throwOnUncachedError) throw err;
    return fallback;
  }
}

export function invalidateDynamicConfigCache(): void {
  dynamicConfigCache.clear();
}

const LOG_DISABLED = new Set(["off", "disable", "disabled", "clear", "none"]);
const LOG_OWNER = new Set(["owner", "me"]);

function ownerChatId(env: Env): number | null {
  const id = configuredChatId(env.OWNER_ID);
  if (!id) return null;
  const n = Number(id);
  return n > 0 ? n : null;
}

/**
 * Telegram log destination.
 * Resolution, first match wins:
 *   1. LOGGING_CONFIG.enabled === false -> null (compile-time kill switch)
 *   2. system_config.log_channel_id in off/disable/clear -> null, even if LOG_CHANNEL_ID is set
 *   3. system_config.log_channel_id in owner/me -> OWNER_ID private chat
 *   4. system_config.log_channel_id numeric chat id
 *   5. non-empty unrecognized D1 value -> null (fail closed, do not leak to the secret)
 *   6. empty D1 value -> LOG_CHANNEL_ID secret, or null
 * Never falls back to OWNER_ID. Factory reset uses getFactoryResetTarget for that one exception.
 * A null result sends nothing: no Bot API call and no D1 write.
 */
export async function getEffectiveLogChannel(env: Env): Promise<number | null> {
  if (!LOGGING_CONFIG.enabled) return null;

  let customRaw = "";
  try {
    customRaw = (await getDynamicConfig(env, "log_channel_id", "", true)).trim();
  } catch {
    return null;
  }
  if (customRaw) {
    const customKey = customRaw.toLowerCase();
    if (LOG_DISABLED.has(customKey)) return null;
    if (LOG_OWNER.has(customKey)) return ownerChatId(env);
    const explicit = configuredChatId(customRaw);
    if (explicit) return Number(explicit);
    return null;
  }

  const secret = configuredChatId(env.LOG_CHANNEL_ID);
  return secret ? Number(secret) : null;
}

/** Factory-reset backup only. Every other log path must use getEffectiveLogChannel. */
export async function getFactoryResetTarget(env: Env): Promise<number | string> {
  const channel = await getEffectiveLogChannel(env);
  if (channel !== null) return channel;
  return env.OWNER_ID;
}
