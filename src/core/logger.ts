import { Api } from "grammy";
import { Env, MyContext } from "./types";
import { LOGGING_CONFIG, getEffectiveLogChannel } from "../config";
import { t } from "../locales";
import { setCappedMap } from "../shared/crypto";
import { escapeHtml, truncateText } from "../shared/formatters";

const alertLastSent = new Map<string, number>();

export function isD1FreeTierError(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as { message?: string })?.message || err).toLowerCase();
  return (
    msg.includes("exceeded d1's free tier") ||
    msg.includes("daily row read limit") ||
    msg.includes("daily row write limit") ||
    msg.includes("d1_error: exceeded")
  );
}

function writeAlertPoint(env: Env, key: string): void {
  if (!LOGGING_CONFIG.analyticsEnabled || !env.FILESTORE_ANALYTICS) return;
  const index = key.slice(0, 64);
  try {
    env.FILESTORE_ANALYTICS.writeDataPoint({
      blobs: ["alert", index],
      doubles: [1],
      indexes: [index],
    });
  } catch {
    // Analytics must never fail the invocation.
  }
}

export async function handleD1FreeTierError(ctx: MyContext, _err?: unknown): Promise<void> {
  const lang = ctx.lang || "en";
  await ctx.reply(t(lang, "d1_quota_exhausted")).catch(() => {});

  if (ctx.env) writeAlertPoint(ctx.env, "d1_free_tier");

  if (!ctx.api || !ctx.env || !ctx.executionCtx) return;
  // Rules: at most one Telegram notify per isolate per hour. Other alerts use alertCooldownMs.
  LoggerService.alert(
    ctx.api,
    ctx.env,
    ctx.executionCtx,
    "d1_free_tier",
    "🚨 <b>[D1 FREE-TIER EXHAUSTED]</b>\n<blockquote expandable>Database daily read or write limits were exceeded. Operations are paused until 00:00 UTC.</blockquote>",
    { cooldownMs: 3_600_000, analytics: false }
  );
}

export interface AlertOptions {
  cooldownMs?: number;
  analytics?: boolean;
}

export class LoggerService {
  /**
   * Background Telegram log. Returns immediately.
   * No destination -> the async body returns before sendMessage (0 external subrequests, 0 D1 writes).
   */
  static log(api: Api, env: Env, executionCtx: ExecutionContext, text: string): void {
    if (!LOGGING_CONFIG.enabled) return;

    const promise = (async () => {
      const target = await getEffectiveLogChannel(env);
      if (target === null) return;
      await api.sendMessage(target, truncateText(text, 4096), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    })().catch((err) => {
      console.error("Logger background dispatch error:", err);
    });

    executionCtx.waitUntil(promise);
  }

  /** Deduped operational alert. Same key is suppressed for the cooldown inside this isolate. */
  static alert(
    api: Api,
    env: Env,
    executionCtx: ExecutionContext,
    key: string,
    text: string,
    options?: AlertOptions
  ): void {
    if (!LOGGING_CONFIG.enabled) return;

    const now = Date.now();
    const gap = options?.cooldownMs ?? LOGGING_CONFIG.alertCooldownMs;
    const last = alertLastSent.get(key) || 0;
    if (now - last < gap) return;
    // Collapse a same-tick burst. The stamp is removed if no Telegram destination exists,
    // so /setlogchannel starts delivering on the next event without waiting out the cooldown.
    setCappedMap(alertLastSent, key, now, LOGGING_CONFIG.maxDedupeEntries);

    const promise = (async () => {
      const target = await getEffectiveLogChannel(env);
      if (target === null) {
        alertLastSent.delete(key);
        return;
      }
      if (options?.analytics !== false) writeAlertPoint(env, key);
      await api.sendMessage(target, truncateText(text, 4096), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    })().catch((err) => {
      console.error("Logger background dispatch error:", err);
    });

    executionCtx.waitUntil(promise);
  }

  /** Admin and security audit. Not cooldown-deduped. Skipped when auditAdminActions is false. */
  static auditAction(
    api: Api,
    env: Env,
    executionCtx: ExecutionContext,
    action: string,
    actorId: number,
    fields: Record<string, string | number>
  ): void {
    if (!LOGGING_CONFIG.enabled || !LOGGING_CONFIG.auditAdminActions) return;
    const lines = [
      `action: <code>${escapeHtml(action)}</code>`,
      `actor: <code>${actorId}</code>`,
      ...Object.entries(fields).map(
        ([field, value]) => `${escapeHtml(field)}: <code>${escapeHtml(String(value))}</code>`
      ),
    ];
    this.log(
      api,
      env,
      executionCtx,
      `🛡 <b>[AUDIT] ${escapeHtml(action)}</b>\n<blockquote expandable>${lines.join("\n")}</blockquote>`
    );
  }
}

export const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};
