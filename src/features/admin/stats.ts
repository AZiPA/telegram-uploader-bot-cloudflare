import { Composer } from "grammy";
import { Env, MyContext } from "../../core/types";
import { escapeHtml } from "../../shared/formatters";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const adminStatsComposer = new Composer<MyContext>();
const privileged = adminStatsComposer.filter((ctx) => ctx.isAdmin);

const STATS_TTL_MS = 5 * 60 * 1000;

interface TopRow {
  code: string;
  title: string | null;
  downloads: number;
}

interface StatsSnapshot {
  bundles: number;
  files: number;
  downloads: number;
  top: TopRow[];
}

let statsCache: { at: number; data: StatsSnapshot } | null = null;

async function loadStats(env: Env): Promise<StatsSnapshot> {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) {
    return statsCache.data;
  }

  const [bundleCount, fileCount, dlCount, top] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as c FROM bundles").first<{ c: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(json_array_length(items)), 0) as c FROM bundles").first<{ c: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(download_count), 0) as s FROM user_downloads").first<{ s: number }>(),
    env.DB.prepare(
      "SELECT ud.code AS code, b.title AS title, SUM(ud.download_count) AS downloads " +
      "FROM user_downloads ud " +
      "LEFT JOIN bundles b ON ud.code = b.code " +
      "GROUP BY ud.code " +
      "ORDER BY downloads DESC LIMIT 5"
    ).all<TopRow>(),
  ]);

  const data: StatsSnapshot = {
    bundles: bundleCount?.c ?? 0,
    files: fileCount?.c ?? 0,
    downloads: dlCount?.s ?? 0,
    top: top.results || [],
  };
  statsCache = { at: now, data };
  return data;
}

privileged.command(["stats", "status"], async (ctx) => {
  try {
    const snap = await loadStats(ctx.env);
    await ctx.reply(
      t(ctx.lang, "stats_summary", {
        bundles: snap.bundles,
        files: snap.files,
        downloads: snap.downloads,
      }),
      { parse_mode: "HTML" }
    );
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});

privileged.command(["top", "topfiles"], async (ctx) => {
  try {
    const snap = await loadStats(ctx.env);
    if (!snap.top.length) {
      return ctx.reply(t(ctx.lang, "stats_empty"));
    }

    let text = t(ctx.lang, "stats_top_title");
    snap.top.forEach((row, i) => {
      let title = row.title || t(ctx.lang, "stats_untitled", { code: row.code });
      if (title.length > 100) title = title.slice(0, 97) + "...";
      const line = t(ctx.lang, "stats_top_line", {
        rank: i + 1,
        title: escapeHtml(title),
        downloads: row.downloads,
      });
      if (text.length + line.length > 4000) return;
      text += line;
    });

    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
});