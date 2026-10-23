import { NextFunction } from "grammy";
import { MyContext } from "../core/types";
import { setCappedMap } from "../shared/crypto";
import { t } from "../locales";
import { LIMITS } from "../config";

const memoryBuckets = new Map<number, { count: number; resetAt: number }>();
const memoryBans = new Map<number, number>();

export function isUserMemoryBanned(userId: number): boolean {
  const expiresAt = memoryBans.get(userId);
  if (!expiresAt) return false;
  return Date.now() < expiresAt;
}

export function applyImmediateMemoryBan(userId: number, durationSec: number): void {
  setCappedMap(memoryBans, userId, Date.now() + (durationSec * 1000), 5000);
}

export function invalidateBanCache(userId: number): void {
  memoryBans.delete(userId);
  memoryBuckets.delete(userId);
}

export async function rateLimitMiddleware(ctx: MyContext, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId || ctx.isAdmin) return next();

  const now = Date.now();

  if (isUserMemoryBanned(userId)) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: t(ctx.lang, "rate_limit_permanent"),
        show_alert: true,
      }).catch(() => {});
    }
    return;
  }

  const windowMs = LIMITS.RATE_LIMIT_WINDOW_SEC * 1000;
  const bucket = memoryBuckets.get(userId) || { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 1;
    bucket.resetAt = now + windowMs;
  } else {
    bucket.count += 1;
  }
  setCappedMap(memoryBuckets, userId, bucket, 5000);

  if (bucket.count > LIMITS.RATE_LIMIT_BURST) {
    applyImmediateMemoryBan(userId, 60);

    const msg = t(ctx.lang, "rate_limit_temp", { min: 1 });
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: msg, show_alert: true }).catch(() => {});
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  return next();
}