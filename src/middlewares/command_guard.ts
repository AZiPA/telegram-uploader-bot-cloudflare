import { NextFunction } from "grammy";
import { MyContext } from "../core/types";
import { t } from "../locales";

export const USER_COMMANDS = new Set([
  "start", "help"
]);

export const ADMIN_COMMANDS = new Set([
  ...USER_COMMANDS,
  "cancel",
  "upload", "batch", "done", "edit", "manage", "review", "setname",
  "search", "find", "stats", "status", "top", "topfiles",
  "channels", "fjmenu", "forcejoin", "setchannelbtn",
  "addchannel", "delchannel", "setverifybtn",
  "setexpiry", "setpass", "postbundle", "rotatelink"
]);

export const SUPER_ADMIN_COMMANDS = new Set([
  ...ADMIN_COMMANDS,
  "botprofile", "settings", "botconfig",
  "admins", "addadmin", "deladmin", "removeadmin",
  "setdailylimit", "setpubchannel",
  "ban", "unban", "addvip",
  "vips", "delvip", "removevip", "clearvips"
]);

export const OWNER_ONLY_COMMANDS = new Set([
  "resetfactory", "factoryreset",
  "restore",
  "maintenance", "maint",
  "setautodel", "setfilelimit",
  "setbundlettl",
  "setlogchannel",
]);

export async function commandGuardMiddleware(ctx: MyContext, next: NextFunction): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text || !text.startsWith("/")) return next();

  if (ctx.isOwner) return next();

  const command = text.slice(1).split(/[\s@]/)[0].toLowerCase();

  // Super Admin checks
  if (ctx.isSuperAdmin) {
    if (OWNER_ONLY_COMMANDS.has(command)) {
      await ctx.reply(t(ctx.lang, "owner_only_command"));
      return;
    }
    if (SUPER_ADMIN_COMMANDS.has(command) || command.startsWith("del_")) {
      return next();
    }
    return;
  }

  // Regular Admin checks
  if (ctx.isAdmin) {
    if (OWNER_ONLY_COMMANDS.has(command)) {
      await ctx.reply(t(ctx.lang, "owner_only_command"));
      return;
    }
    if (SUPER_ADMIN_COMMANDS.has(command)) {
      await ctx.reply(t(ctx.lang, "superadmin_only_command"));
      return;
    }
    if (ADMIN_COMMANDS.has(command) || command.startsWith("del_")) {
      return next();
    }
    return;
  }

  // Regular Users: allow only public commands, silently drop the rest
  if (USER_COMMANDS.has(command)) return next();
}