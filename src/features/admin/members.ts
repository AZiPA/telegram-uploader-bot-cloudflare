import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { LIMITS, ACTIONS } from "../../config";
import { invalidateAdminCache, invalidateVipCache, invalidateUserBanCache } from "../../middlewares/auth";
import { invalidateBanCache } from "../../middlewares/rate_limit";
import { ButtonFactory } from "../../shared/buttons";
import { LoggerService, isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const adminMembersComposer = new Composer<MyContext>();
const superAdminOrOwner = adminMembersComposer.filter((ctx) => ctx.isSuperAdmin);

function roleRank(role?: string): number {
  switch (role) {
    case "owner": return 4;
    case "superadmin": return 3;
    case "admin": return 2;
    case "vip": return 1;
    default: return 0;
  }
}

function callerRank(ctx: MyContext): number {
  if (ctx.isOwner || ctx.role === "owner") return roleRank("owner");
  if (ctx.isSuperAdmin || ctx.role === "superadmin") return roleRank("superadmin");
  if (ctx.isAdmin || ctx.role === "admin") return roleRank("admin");
  return roleRank(ctx.role);
}

function outranks(ctx: MyContext, targetRole?: string): boolean {
  return callerRank(ctx) > roleRank(targetRole);
}

async function renderAdminsList(ctx: MyContext): Promise<void> {
  const lang = ctx.lang;
  const ownerId = Number(ctx.env.OWNER_ID);

  let rows: { results?: { user_id: number; role: string; added_by: number; created_at: number }[] };
  try {
    rows = await ctx.env.DB.prepare(
      "SELECT user_id, role, added_by, created_at FROM admins WHERE user_id != ? ORDER BY role DESC, created_at ASC"
    ).bind(ownerId).all<{ user_id: number; role: string; added_by: number; created_at: number }>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }

  const adminList = rows.results || [];
  const superAdmins = adminList.filter((a) => a.role === "superadmin");
  const regularAdmins = adminList.filter((a) => a.role === "admin");
  const regCount = regularAdmins.length;

  let text = `${t(lang, "admins_list_title")}\n\n`;
  text += `${t(lang, "admins_reg_quota_info", { count: String(regCount), max: String(LIMITS.MAX_ADMINS) })}\n\n`;
  text += `👑 <b>${t(lang, "role_owner")}:</b> <code>${ownerId}</code>\n\n`;

  if (superAdmins.length > 0) {
    text += `${t(lang, "admins_superadmin_section")}\n`;
    for (const adm of superAdmins) {
      text += `• <code>${adm.user_id}</code>\n`;
    }
    text += `\n`;
  }

  if (regularAdmins.length > 0) {
    text += `${t(lang, "admins_regular_section", { count: String(regCount), max: String(LIMITS.MAX_ADMINS) })}\n`;
    for (const adm of regularAdmins) {
      text += `• <code>${adm.user_id}</code>\n`;
    }
  }

  const canAdd = ctx.isOwner || regCount < LIMITS.MAX_ADMINS;
  const removable = adminList.filter((adm) => outranks(ctx, adm.role));
  const kb = ButtonFactory.adminsKeyboard(lang, { canAdd, removable });

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {
      return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function handleAddAdmin(ctx: MyContext, targetIdStr: string, roleInput?: string): Promise<void> {
  const lang = ctx.lang;
  if (!targetIdStr || !/^\d+$/.test(targetIdStr)) {
    await ctx.reply(t(lang, "admin_invalid_id"), { parse_mode: "HTML" });
    return;
  }

  const targetId = Number(targetIdStr);
  const ownerId = Number(ctx.env.OWNER_ID);

  if (targetId === ownerId) {
    await ctx.reply(t(lang, "admin_cannot_manage_owner"), { parse_mode: "HTML" });
    return;
  }

  let requestedRole: "admin" | "superadmin" = "admin";
  const cleanedRole = roleInput?.toLowerCase().trim();
  if (cleanedRole === "superadmin" || cleanedRole === "super_admin") {
    if (!ctx.isOwner) {
      await ctx.reply(t(lang, "superadmin_cannot_add_superadmin"), { parse_mode: "HTML" });
      return;
    }
    requestedRole = "superadmin";
  }

  const existing = await ctx.env.DB.prepare("SELECT role FROM admins WHERE user_id = ?")
    .bind(targetId).first<{ role: string }>();

  if (existing) {
    if (!outranks(ctx, existing.role)) {
      await ctx.reply(t(lang, "superadmin_cannot_remove_superadmin"), { parse_mode: "HTML" });
      return;
    }

    if (existing.role !== "admin" && requestedRole === "admin") {
      const regCountRes = await ctx.env.DB.prepare(
        "SELECT COUNT(*) as count FROM admins WHERE role = 'admin' AND user_id != ?"
      ).bind(ownerId).first<{ count: number }>();
      const currentRegCount = regCountRes?.count || 0;
      if (currentRegCount >= LIMITS.MAX_ADMINS) {
        await ctx.reply(t(lang, "admin_limit_reached", { max: String(LIMITS.MAX_ADMINS) }), { parse_mode: "HTML" });
        return;
      }
    }

    await ctx.env.DB.prepare("UPDATE admins SET role = ?, added_by = ? WHERE user_id = ?")
      .bind(requestedRole, ctx.from!.id, targetId).run();
  } else {
    if (requestedRole === "admin") {
      const regCountRes = await ctx.env.DB.prepare(
        "SELECT COUNT(*) as count FROM admins WHERE role = 'admin' AND user_id != ?"
      ).bind(ownerId).first<{ count: number }>();
      const currentRegCount = regCountRes?.count || 0;

      if (currentRegCount >= LIMITS.MAX_ADMINS) {
        await ctx.reply(t(lang, "admin_limit_reached", { max: String(LIMITS.MAX_ADMINS) }), { parse_mode: "HTML" });
        return;
      }
    }

    await ctx.env.DB.prepare(
      "INSERT INTO admins (user_id, added_by, role, created_at) VALUES (?, ?, ?, ?)"
    ).bind(targetId, ctx.from!.id, requestedRole, Math.floor(Date.now() / 1000)).run();
  }

  invalidateAdminCache();

  const roleName = requestedRole === "superadmin" ? t(lang, "role_superadmin") : t(lang, "role_admin");
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "addadmin", ctx.from!.id, {
    target: targetId,
    role: requestedRole,
  });
  await ctx.reply(t(lang, "admin_added_success", { id: String(targetId), role: roleName }), { parse_mode: "HTML" });
}

async function handleDeleteAdmin(ctx: MyContext, targetIdStr: string): Promise<boolean> {
  const lang = ctx.lang;
  if (!targetIdStr || !/^\d+$/.test(targetIdStr)) {
    await ctx.reply(t(lang, "admin_invalid_id"), { parse_mode: "HTML" });
    return false;
  }

  const targetId = Number(targetIdStr);
  const ownerId = Number(ctx.env.OWNER_ID);

  if (targetId === ownerId) {
    await ctx.reply(t(lang, "admin_cannot_manage_owner"), { parse_mode: "HTML" });
    return false;
  }

  const existing = await ctx.env.DB.prepare("SELECT role FROM admins WHERE user_id = ?")
    .bind(targetId).first<{ role: string }>();

  if (!existing) {
    await ctx.reply(t(lang, "admin_not_found", { id: String(targetId) }), { parse_mode: "HTML" });
    return false;
  }

  if (!outranks(ctx, existing.role)) {
    await ctx.reply(t(lang, "superadmin_cannot_remove_superadmin"), { parse_mode: "HTML" });
    return false;
  }

  await ctx.env.DB.prepare("DELETE FROM admins WHERE user_id = ?").bind(targetId).run();
  invalidateAdminCache();
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "deladmin", ctx.from!.id, {
    target: targetId,
    role: existing.role,
  });
  return true;
}

superAdminOrOwner.command("admins", async (ctx) => {
  await renderAdminsList(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.ADMIN_MENU, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderAdminsList(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.ADMIN_REFRESH, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderAdminsList(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.ADMIN_ADD_PROMPT, async (ctx) => {
  await ctx.answerCallbackQuery();
  const ownerId = Number(ctx.env.OWNER_ID);

  if (!ctx.isOwner) {
    const regCountRes = await ctx.env.DB.prepare(
      "SELECT COUNT(*) as count FROM admins WHERE role = 'admin' AND user_id != ?"
    ).bind(ownerId).first<{ count: number }>();
    const currentRegCount = regCountRes?.count || 0;
    if (currentRegCount >= LIMITS.MAX_ADMINS) {
      await ctx.reply(t(ctx.lang, "admin_limit_reached", { max: String(LIMITS.MAX_ADMINS) }), { parse_mode: "HTML" });
      return;
    }
  }

  await ctx.reply(t(ctx.lang, "admin_prompt_add"), {
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }
  });
});

superAdminOrOwner.command("addadmin", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (!parts[0] || !/^\d+$/.test(parts[0])) {
    await ctx.reply(t(ctx.lang, "admin_prompt_add"), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true }
    });
    return;
  }
  await handleAddAdmin(ctx, parts[0], parts[1]);
});

superAdminOrOwner.command(["deladmin", "removeadmin"], async (ctx) => {
  const targetId = ctx.match?.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply(t(ctx.lang, "deladmin_usage"), { parse_mode: "HTML" });
  }
  const ok = await handleDeleteAdmin(ctx, targetId);
  if (ok) {
    await ctx.reply(t(ctx.lang, "admin_removed_success", { id: targetId }), { parse_mode: "HTML" });
  }
});

superAdminOrOwner.callbackQuery(new RegExp(`^${ACTIONS.ADMIN_DEL}(\\d+)$`), async (ctx) => {
  const match = ctx.match as RegExpMatchArray;
  const targetId = match[1];
  await ctx.answerCallbackQuery();
  const ok = await handleDeleteAdmin(ctx, targetId);
  if (ok) {
    await renderAdminsList(ctx);
  }
});

superAdminOrOwner.on("message:text", async (ctx, next) => {
  const replyTo = ctx.message.reply_to_message;
  if (!replyTo || !replyTo.text) return next();

  if (replyTo.text.includes("#ADD_ADMIN#")) {
    const text = ctx.message.text.trim();
    if (["/cancel", "cancel"].includes(text.toLowerCase())) {
      await ctx.reply(t(ctx.lang, "admin_op_cancelled"));
      return;
    }
    const parts = text.split(/\s+/);
    await handleAddAdmin(ctx, parts[0], parts[1]);
    return;
  }

  return next();
});

superAdminOrOwner.command("ban", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (!parts[0] || !/^\d+$/.test(parts[0])) {
    return ctx.reply(t(ctx.lang, "ban_usage"), { parse_mode: "HTML" });
  }

  const targetId = Number(parts[0]);
  const ownerId = Number(ctx.env.OWNER_ID);

  if (targetId === ownerId) {
    return ctx.reply(t(ctx.lang, "admin_cannot_manage_owner"), { parse_mode: "HTML" });
  }

  const targetAdmin = await ctx.env.DB.prepare("SELECT role FROM admins WHERE user_id = ?")
    .bind(targetId).first<{ role: string }>();
  if (targetAdmin && !outranks(ctx, targetAdmin.role)) {
    return ctx.reply(t(ctx.lang, "superadmin_cannot_remove_superadmin"), { parse_mode: "HTML" });
  }

  let days = 30;
  if (parts[1]) {
    if (!/^\d+$/.test(parts[1])) {
      return ctx.reply(t(ctx.lang, "ban_usage"), { parse_mode: "HTML" });
    }
    days = Number(parts[1]);
    if (days < 1 || days > 3650) {
      return ctx.reply(t(ctx.lang, "ban_usage"), { parse_mode: "HTML" });
    }
  }
  const banUntilSec = Math.floor(Date.now() / 1000) + (days * 86400);

  await ctx.env.DB.prepare(
    "INSERT INTO user_quotas (user_id, downloads_today, last_download_date, last_request_at, banned_until) " +
    "VALUES (?, 0, '', 0, ?) ON CONFLICT(user_id) DO UPDATE SET banned_until = excluded.banned_until"
  ).bind(targetId, banUntilSec).run();

  invalidateBanCache(targetId);
  invalidateUserBanCache(targetId);
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "ban", ctx.from!.id, {
    target: targetId,
    days,
  });
  await ctx.reply(t(ctx.lang, "ban_applied", { id: String(targetId), days }), { parse_mode: "HTML" });
});

superAdminOrOwner.command("unban", async (ctx) => {
  const targetId = ctx.match?.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.reply(t(ctx.lang, "unban_usage"), { parse_mode: "HTML" });
  }

  const userIdNum = Number(targetId);
  await ctx.env.DB.prepare("UPDATE user_quotas SET banned_until = 0, strikes = 0 WHERE user_id = ?").bind(userIdNum).run();
  invalidateBanCache(userIdNum);
  invalidateUserBanCache(userIdNum);
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "unban", ctx.from!.id, { target: userIdNum });
  await ctx.reply(t(ctx.lang, "unban_applied", { id: targetId }), { parse_mode: "HTML" });
});

superAdminOrOwner.command("addvip", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length === 0 || !parts[0] || !/^\d+$/.test(parts[0])) {
    return ctx.reply(t(ctx.lang, "addvip_usage"), { parse_mode: "HTML" });
  }

  const targetId = Number(parts[0]);
  const days = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
  const expiresAt = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;

  await ctx.env.DB.prepare(
    "INSERT INTO vips (user_id, added_by, expires_at, created_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at"
  ).bind(targetId, ctx.from!.id, expiresAt, Math.floor(Date.now() / 1000)).run();

  invalidateVipCache();
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "addvip", ctx.from!.id, {
    target: targetId,
    days,
  });
  const term = days > 0 ? t(ctx.lang, "vip_days", { days }) : t(ctx.lang, "vip_lifetime");
  await ctx.reply(t(ctx.lang, "addvip_applied", { id: String(targetId), term }), { parse_mode: "HTML" });
});

async function renderVipsList(ctx: MyContext): Promise<void> {
  const lang = ctx.lang;
  const nowSec = Math.floor(Date.now() / 1000);

  let rows: { results?: { user_id: number; expires_at: number; created_at: number }[] };
  try {
    rows = await ctx.env.DB.prepare(
      "SELECT user_id, expires_at, created_at FROM vips WHERE expires_at = 0 OR expires_at > ? ORDER BY created_at DESC LIMIT 50"
    ).bind(nowSec).all<{ user_id: number; expires_at: number; created_at: number }>();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }

  const list = rows.results || [];
  let text = `${t(lang, "vips_list_title", { count: String(list.length) })}\n\n`;

  if (list.length === 0) {
    text += t(lang, "vips_empty");
  } else {
    let itemsText = "";
    for (const vip of list) {
      let term: string;
      if (vip.expires_at === 0) {
        term = t(lang, "vip_lifetime");
      } else {
        const remainingDays = Math.max(1, Math.ceil((vip.expires_at - nowSec) / 86400));
        term = t(lang, "vip_days", { days: remainingDays });
      }
      itemsText += `${t(lang, "vips_item_line", { id: String(vip.user_id), term })}\n`;
    }

    if (list.length >= 5) {
      text += `<blockquote expandable>${itemsText.trimEnd()}</blockquote>`;
    } else {
      text += itemsText.trimEnd();
    }
  }

  const kb = ButtonFactory.vipsKeyboard(lang, list.length > 0);

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {
      return ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function handleClearVips(ctx: MyContext, isCallback: boolean = false): Promise<void> {
  const lang = ctx.lang;
  let res: { meta?: { changes?: number } };
  try {
    res = await ctx.env.DB.prepare("DELETE FROM vips").run();
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
  invalidateVipCache();
  const removed = res.meta?.changes ?? 0;
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "clearvips", ctx.from!.id, { removed });

  const msg = t(lang, "vips_cleared_all", { count: String(removed) });
  if (isCallback && ctx.callbackQuery?.message) {
    await ctx.editMessageText(msg, { parse_mode: "HTML" }).catch(() => ctx.reply(msg, { parse_mode: "HTML" }));
  } else {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}

superAdminOrOwner.command("vips", async (ctx) => {
  await renderVipsList(ctx);
});

superAdminOrOwner.command(["delvip", "removevip"], async (ctx) => {
  const arg = ctx.match?.trim();
  if (!arg) {
    return ctx.reply(t(ctx.lang, "delvip_usage"), { parse_mode: "HTML" });
  }

  if (arg.toLowerCase() === "all") {
    await handleClearVips(ctx, false);
    return;
  }

  if (!/^\d+$/.test(arg)) {
    return ctx.reply(t(ctx.lang, "delvip_usage"), { parse_mode: "HTML" });
  }

  const targetId = Number(arg);
  const res = await ctx.env.DB.prepare("DELETE FROM vips WHERE user_id = ?").bind(targetId).run();
  if ((res.meta?.changes ?? 0) === 0) {
    return ctx.reply(t(ctx.lang, "vip_not_found", { id: String(targetId) }), { parse_mode: "HTML" });
  }

  invalidateVipCache(targetId);
  LoggerService.auditAction(ctx.api, ctx.env, ctx.executionCtx, "delvip", ctx.from!.id, { target: targetId });
  await ctx.reply(t(ctx.lang, "delvip_applied", { id: String(targetId) }), { parse_mode: "HTML" });
});

superAdminOrOwner.command("clearvips", async (ctx) => {
  await handleClearVips(ctx, false);
});

superAdminOrOwner.callbackQuery(ACTIONS.VIP_REFRESH, async (ctx) => {
  if (!ctx.isSuperAdmin) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "superadmin_only_command"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  await renderVipsList(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.VIP_CLEAR_ASK, async (ctx) => {
  if (!ctx.isSuperAdmin) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "superadmin_only_command"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  const kb = ButtonFactory.vipsClearConfirmKeyboard(ctx.lang);
  await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
});

superAdminOrOwner.callbackQuery(ACTIONS.VIP_CLEAR_NO, async (ctx) => {
  if (!ctx.isSuperAdmin) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "superadmin_only_command"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  await renderVipsList(ctx);
});

superAdminOrOwner.callbackQuery(ACTIONS.VIP_CLEAR_YES, async (ctx) => {
  if (!ctx.isSuperAdmin) {
    await ctx.answerCallbackQuery({ text: t(ctx.lang, "superadmin_only_command"), show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  await handleClearVips(ctx, true);
});