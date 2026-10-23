import { Bot } from "grammy";
import { Env, MyContext, requestStorage } from "./core/types";
import { DEFAULT_BOT_INFO } from "./config";
import { t } from "./locales";
import { authMiddleware, canManageBundle } from "./middlewares/auth";
import { commandGuardMiddleware } from "./middlewares/command_guard";
import { rateLimitMiddleware } from "./middlewares/rate_limit";
import { botIdFromToken, escapeHtml } from "./shared/formatters";
import { LoggerService, isD1FreeTierError, handleD1FreeTierError } from "./core/logger";

import { fjUserComposer } from "./features/force_join/handlers";
import { fjMenuComposer } from "./features/force_join/menu";
import { fjWizardsComposer } from "./features/force_join/wizards";
import { deliveryComposer, executeDelivery } from "./features/filestore/delivery";
import { uploadComposer } from "./features/filestore/upload";
import { votingComposer } from "./features/filestore/voting";
import { searchComposer } from "./features/filestore/search";
import { managementComposer, showAdminBundleHub } from "./features/bundles";
import { protectedComposer } from "./features/bundles/protected";
import { adminMembersComposer } from "./features/admin/members";
import { adminSettingsComposer } from "./features/admin/settings";
import { adminStatsComposer } from "./features/admin/stats";
import { adminMaintenanceComposer } from "./features/admin/maintenance";
import { adminProfileComposer } from "./features/admin/profile";

export function createBot(tokenOrEnv: string | Env, maybeEnv?: Env) {
  const env = typeof tokenOrEnv === "string" ? maybeEnv : tokenOrEnv;
  const token = typeof tokenOrEnv === "string" ? tokenOrEnv : tokenOrEnv.BOT_TOKEN;

  let bot: Bot<MyContext>;
  const botId = botIdFromToken(env?.BOT_TOKEN || token);
  const botUsername = env?.BOT_USERNAME ? env.BOT_USERNAME.replace(/^@/, "").trim() : undefined;

  if (botId && botUsername) {
    bot = new Bot<MyContext>(token, {
      botInfo: {
        ...DEFAULT_BOT_INFO,
        id: botId,
        is_bot: true,
        first_name: env?.BOT_FIRST_NAME || DEFAULT_BOT_INFO.first_name,
        username: botUsername,
      },
    });
  } else {
    bot = new Bot<MyContext>(token);
  }

  bot.catch(async (err) => {
    console.error("Grammy caught error in handler:", err.error);
    const ctx = err.ctx;
    if (isD1FreeTierError(err.error)) {
      if (ctx) {
        await handleD1FreeTierError(ctx, err.error);
      }
      return;
    }
    const errObj = err.error as any;
    const desc = String(errObj?.description || errObj?.message || "").toLowerCase();
    if (errObj?.error_code === 403 && desc.includes("bot was blocked by the user")) {
      return;
    }
    const activeEnv = ctx?.env || env;
    const executionCtx = ctx?.executionCtx;
    if (!ctx?.api || !activeEnv || !executionCtx) return;
    const raw = err.error instanceof Error ? (err.error.message || err.error.name) : String(err.error ?? "unknown");
    const detail = escapeHtml(raw.slice(0, 1500));
    LoggerService.alert(
      ctx.api,
      activeEnv,
      executionCtx,
      "unhandled",
      `🚨 <b>[UNHANDLED]</b>\n<blockquote expandable>${detail}</blockquote>`
    );
  });

  bot.use(async (ctx, next) => {
    const store = requestStorage.getStore();
    if (store) {
      ctx.env = store.env;
      ctx.executionCtx = store.executionCtx;
    }
    return next();
  });

  bot.use(authMiddleware);
  bot.use(commandGuardMiddleware);
  bot.use(rateLimitMiddleware);

  bot.command("start", async (ctx) => {
    const rawPayload = ctx.match?.trim() || "";
    if (!rawPayload) {
      return ctx.reply(t(ctx.lang, "start_desc"));
    }
    const pinMatch = /^([a-zA-Z0-9_-]{8,36})_([a-zA-Z0-9]{1,32})$/.exec(rawPayload);
    const code = pinMatch ? pinMatch[1] : rawPayload;
    const providedPin = pinMatch ? pinMatch[2] : undefined;

    if (!/^[a-zA-Z0-9_-]{8,36}$/.test(code)) {
      return ctx.reply(t(ctx.lang, "start_desc"));
    }

    if (ctx.isAdmin && !providedPin) {
      const row = await ctx.env.DB.prepare(
        "SELECT created_by, owner_locked FROM bundles WHERE code = ?"
      ).bind(code).first<{ created_by: number; owner_locked?: number }>();

      if (row && (await canManageBundle(ctx, row))) {
        return showAdminBundleHub(ctx, code);
      }
    }

    return executeDelivery(ctx, code, false, 0, providedPin);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(t(ctx.lang, "help_desc"), { parse_mode: "HTML" });
  });

  bot.use(fjUserComposer);
  bot.use(fjMenuComposer);
  bot.use(fjWizardsComposer);
  bot.use(deliveryComposer);
  bot.use(uploadComposer);
  bot.use(managementComposer);
  bot.use(protectedComposer);
  bot.use(votingComposer);
  bot.use(searchComposer);
  bot.use(adminMembersComposer);
  bot.use(adminSettingsComposer);
  bot.use(adminProfileComposer);
  bot.use(adminStatsComposer);
  bot.use(adminMaintenanceComposer);

  bot.on("callback_query", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  return bot;
}