import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { escapeHtml } from "../../shared/formatters";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { canManageBundle } from "../../middlewares/auth";
import { t } from "../../locales";

export const setnameComposer = new Composer<MyContext>();
const privileged = setnameComposer.filter((ctx) => ctx.isAdmin);

privileged.command("setname", async (ctx) => {
  const parts = ctx.match?.trim().split(/\s+/) || [];
  if (parts.length < 2) {
    return ctx.reply(t(ctx.lang, "setname_usage"), { parse_mode: "HTML" });
  }

  const [code, ...nameParts] = parts;
  const newTitle = nameParts.join(" ").trim();

  try {
    const bundle = await ctx.env.DB.prepare(
      "SELECT protect_content, created_by, owner_locked FROM bundles WHERE code = ?"
    ).bind(code).first<{ protect_content: number; created_by: number; owner_locked?: number }>();

    if (!bundle) return ctx.reply(t(ctx.lang, "bundle_not_found"));

    if (!(await canManageBundle(ctx, bundle))) {
      return ctx.reply(t(ctx.lang, "bundle_access_denied"), { parse_mode: "HTML" });
    }

    if (bundle.protect_content === 1) {
      return ctx.reply(t(ctx.lang, "setname_protected_err"));
    }

    if (newTitle.toLowerCase() === "clear") {
      await ctx.env.DB.prepare("UPDATE bundles SET title = NULL WHERE code = ?").bind(code).run();
      return ctx.reply(t(ctx.lang, "setname_cleared"));
    }

    const safeTitle = newTitle.slice(0, 120);
    await ctx.env.DB.prepare("UPDATE bundles SET title = ? WHERE code = ?").bind(safeTitle, code).run();
    await ctx.reply(t(ctx.lang, "setname_updated", { title: escapeHtml(safeTitle) }), { parse_mode: "HTML" });
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});