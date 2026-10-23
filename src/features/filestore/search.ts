import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { escapeHtml, getBotUsername } from "../../shared/formatters";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const searchComposer = new Composer<MyContext>();
const privileged = searchComposer.filter((ctx) => ctx.isAdmin);

privileged.command(["search", "find"], async (ctx) => {
  const lang = ctx.lang;
  const rawQuery = ctx.match?.trim() || "";
  const query = rawQuery
    .replace(/\u064A/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9");
  if (!query) {
    return ctx.reply(t(lang, "search_usage"), { parse_mode: "HTML" });
  }

  if (query.length < 2) {
    return ctx.reply(t(lang, "search_query_too_short"));
  }

  let rows: { results?: { code: string; title: string }[] };
  try {
    if (query !== rawQuery) {
      rows = await ctx.env.DB.prepare(
        "SELECT code, title FROM bundles WHERE title IS NOT NULL AND (title LIKE ? OR title LIKE ?) ORDER BY created_at DESC LIMIT 10"
      ).bind(`%${query}%`, `%${rawQuery}%`).all<{ code: string; title: string }>();
    } else {
      rows = await ctx.env.DB.prepare(
        "SELECT code, title FROM bundles WHERE title IS NOT NULL AND title LIKE ? ORDER BY created_at DESC LIMIT 10"
      ).bind(`%${query}%`).all<{ code: string; title: string }>();
    }
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }

  if (!rows.results || rows.results.length === 0) {
    return ctx.reply(t(lang, "search_no_results"));
  }

  const botUsername = getBotUsername(ctx);
  let text = t(lang, "search_results_title", { query: escapeHtml(rawQuery) });
  const MAX_TITLE_LEN = 120;
  for (let idx = 0; idx < rows.results.length; idx++) {
    const r = rows.results[idx];
    const rawTitle = r.title || t(lang, "hub_search_none");
    const safeTitle = rawTitle.length > MAX_TITLE_LEN ? rawTitle.slice(0, MAX_TITLE_LEN - 3) + "..." : rawTitle;
    const entry = `${idx + 1}. 🎬 <b>${escapeHtml(safeTitle)}</b>\n` +
      `   🔗 <code>https://t.me/${botUsername}?start=${r.code}</code>\n\n`;
    if (text.length + entry.length > 4000) break;
    text += entry;
  }

  await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});