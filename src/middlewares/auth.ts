import { NextFunction } from "grammy";
import { Env, MyContext, UserRole } from "../core/types";
import { setCappedMap } from "../shared/crypto";
import { getDynamicConfig } from "../config";
import { t } from "../locales";
import { logger, isD1FreeTierError, handleD1FreeTierError } from "../core/logger";

let adminCache: Map<number, "owner" | "superadmin" | "admin"> | null = null;

interface VipCacheEntry {
  expiresAt: number;
  cachedAt: number;
}
const vipPointCache = new Map<number, VipCacheEntry>();

interface BanCacheEntry {
  isBanned: boolean;
  cachedUntil: number;
}
const userBanCache = new Map<number, BanCacheEntry>();
let roleCacheExpiresAt = 0;

export async function authMiddleware(ctx: MyContext, next: NextFunction): Promise<void> {
  const defaultLang = await getDynamicConfig(ctx.env, "default_language", "en");
  ctx.lang = ctx.from?.language_code?.startsWith("fa") ? "fa" : (defaultLang === "fa" ? "fa" : "en");
  ctx.role = "user";
  ctx.isOwner = false;
  ctx.isSuperAdmin = false;
  ctx.isAdmin = false;

  const userId = ctx.from?.id;
  if (!userId) return next();

  ctx.isOwner = userId === Number(ctx.env.OWNER_ID);

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  if (!adminCache || now > roleCacheExpiresAt) {
    try {
      const res = await ctx.env.DB.prepare("SELECT user_id, role FROM admins").all<{ user_id: number; role?: string }>();
      const adminResults = res.results || [];
      const newCache = new Map<number, "owner" | "superadmin" | "admin">();
      for (const r of adminResults) {
        if (r.role === "owner") {
          newCache.set(r.user_id, "owner");
        } else if (r.role === "superadmin") {
          newCache.set(r.user_id, "superadmin");
        } else {
          newCache.set(r.user_id, "admin");
        }
      }
      adminCache = newCache;
      roleCacheExpiresAt = now + 120_000;
    } catch (err) {
      if (isD1FreeTierError(err)) {
        await handleD1FreeTierError(ctx, err);
        return;
      }
      logger.error("Failed to query admins table:", err);
      if (!adminCache) {
        adminCache = new Map();
        roleCacheExpiresAt = 0;
      }
    }
  }

  const adminRole = adminCache.get(userId);
  ctx.isSuperAdmin = ctx.isOwner || adminRole === "owner" || adminRole === "superadmin";
  ctx.isAdmin = ctx.isOwner || ctx.isSuperAdmin || adminRole === "admin";

  if (ctx.isOwner || adminRole === "owner") {
    ctx.isOwner = true;
    ctx.role = "owner";
    return next();
  }

  if (adminRole === "superadmin") {
    ctx.role = "superadmin";
  } else if (adminRole === "admin") {
    ctx.role = "admin";
  } else {
    let vipEntry = vipPointCache.get(userId);
    if (!vipEntry || now - vipEntry.cachedAt > 120_000) {
      try {
        const vipRow = await ctx.env.DB.prepare("SELECT expires_at FROM vips WHERE user_id = ?")
          .bind(userId).first<{ expires_at: number }>();
        vipEntry = {
          expiresAt: (vipRow !== null && vipRow !== undefined && typeof vipRow.expires_at === "number") ? vipRow.expires_at : -1,
          cachedAt: now,
        };
        setCappedMap(vipPointCache, userId, vipEntry, 5000);
      } catch (err) {
        if (isD1FreeTierError(err)) {
          await handleD1FreeTierError(ctx, err);
          return;
        }
        vipEntry = { expiresAt: -1, cachedAt: now };
      }
    }

    if (vipEntry.expiresAt === 0 || vipEntry.expiresAt > nowSec) {
      ctx.role = "vip";
    }
  }

  // Maintenance mode guard: blocks non-admins when enabled
  if (!ctx.isAdmin) {
    const isMaintenance = await getDynamicConfig(ctx.env, "maintenance_mode", "0");
    if (isMaintenance === "1") {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: t(ctx.lang, "maintenance_alert"), show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(t(ctx.lang, "maintenance_alert")).catch(() => {});
      }
      return;
    }
  }

  let banEntry = userBanCache.get(userId);
  if (!banEntry || now > banEntry.cachedUntil) {
    try {
      const row = await ctx.env.DB.prepare("SELECT banned_until FROM user_quotas WHERE user_id = ?")
        .bind(userId).first<{ banned_until: number }>();
      const isBanned = Boolean(row?.banned_until && row.banned_until > nowSec);
      banEntry = { isBanned, cachedUntil: now + 60_000 };
      setCappedMap(userBanCache, userId, banEntry, 5000);
    } catch (err) {
      if (isD1FreeTierError(err)) {
        await handleD1FreeTierError(ctx, err);
        return;
      }
      banEntry = { isBanned: false, cachedUntil: now + 60_000 };
    }
  }

  if (banEntry.isBanned) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: t(ctx.lang, "rate_limit_permanent"),
        show_alert: true,
      }).catch(() => {});
    }
    return;
  }

  return next();
}

export function invalidateAdminCache(): void {
  adminCache = null;
  roleCacheExpiresAt = 0;
}

export function invalidateVipCache(userId?: number): void {
  if (userId) {
    vipPointCache.delete(userId);
  } else {
    vipPointCache.clear();
  }
}

export function invalidateUserBanCache(userId: number): void {
  userBanCache.delete(userId);
}

export async function getAdminRoleById(env: Env, userId: number): Promise<UserRole> {
  if (userId === Number(env.OWNER_ID)) {
    return "owner";
  }
  const now = Date.now();
  if (!adminCache || now > roleCacheExpiresAt) {
    try {
      const res = await env.DB.prepare("SELECT user_id, role FROM admins").all<{ user_id: number; role?: string }>();
      const adminResults = res.results || [];
      const newCache = new Map<number, "owner" | "superadmin" | "admin">();
      for (const r of adminResults) {
        if (r.role === "owner") {
          newCache.set(r.user_id, "owner");
        } else if (r.role === "superadmin") {
          newCache.set(r.user_id, "superadmin");
        } else {
          newCache.set(r.user_id, "admin");
        }
      }
      adminCache = newCache;
      roleCacheExpiresAt = now + 120_000;
    } catch (err) {
      logger.error("Failed to query admins table in getAdminRoleById:", err);
      if (!adminCache) {
        adminCache = new Map();
        roleCacheExpiresAt = 0;
      }
    }
  }

  const role = adminCache.get(userId);
  if (role) return role;
  return "user";
}

export async function canManageBundle(
  ctx: MyContext,
  bundle: { created_by: number; owner_locked?: number }
): Promise<boolean> {
  if (!ctx.isAdmin || !ctx.from) return false;
  if (ctx.isOwner) return true;
  if (!bundle.owner_locked) return true;

  if (bundle.created_by === ctx.from.id) return true;

  const creatorRole = await getAdminRoleById(ctx.env, bundle.created_by);
  if (creatorRole === "owner") return false;
  if (ctx.isSuperAdmin) {
    return creatorRole !== "superadmin";
  }
  return false;
}