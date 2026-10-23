import { Composer } from "grammy";
import { MyContext } from "../../core/types";
import { ACTIONS } from "../../config";
import { isD1FreeTierError, handleD1FreeTierError } from "../../core/logger";
import { t } from "../../locales";

export const votingComposer = new Composer<MyContext>();

votingComposer.callbackQuery(new RegExp(`^${ACTIONS.VOTE_LIKE}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await handleVote(ctx, ctx.match[1], "like");
});

votingComposer.callbackQuery(new RegExp(`^${ACTIONS.VOTE_DISLIKE}([a-zA-Z0-9_-]{8,36})$`), async (ctx) => {
  await handleVote(ctx, ctx.match[1], "dislike");
});

async function handleVote(ctx: MyContext, code: string, voteType: "like" | "dislike"): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!ctx.from) return;

  try {
    const userId = ctx.from.id;
    const lang = ctx.lang;

    const bundle = await ctx.env.DB.prepare("SELECT protect_content FROM bundles WHERE code = ?")
      .bind(code).first<{ protect_content: number }>();

    if (!bundle || bundle.protect_content === 1) {
      await ctx.reply(t(lang, "voting_disabled")).catch(() => {});
      return;
    }

    const prevVote = await ctx.env.DB.prepare("SELECT vote_type FROM bundle_votes WHERE code = ? AND user_id = ?")
      .bind(code, userId).first<{ vote_type: string }>();

    if (prevVote?.vote_type === voteType) {
      await ctx.reply(t(lang, "vote_already")).catch(() => {});
      return;
    }

    if (prevVote) {
      await ctx.env.DB.prepare(
        "UPDATE bundle_votes SET vote_type = ? WHERE code = ? AND user_id = ?"
      ).bind(voteType, code, userId).run();
    } else {
      await ctx.env.DB.prepare(
        "INSERT OR IGNORE INTO bundle_votes (code, user_id, vote_type, created_at) VALUES (?, ?, ?, ?)"
      ).bind(code, userId, voteType, Math.floor(Date.now() / 1000)).run();
    }

    const voteCounts = await ctx.env.DB.prepare(
      "SELECT " +
      "COALESCE(SUM(CASE WHEN vote_type = 'like' THEN 1 ELSE 0 END), 0) AS likes, " +
      "COALESCE(SUM(CASE WHEN vote_type = 'dislike' THEN 1 ELSE 0 END), 0) AS dislikes " +
      "FROM bundle_votes WHERE code = ?"
    ).bind(code).first<{ likes: number; dislikes: number }>();

    if (voteCounts) {
      const currentMarkup = ctx.callbackQuery?.message?.reply_markup;
      if (currentMarkup) {
        for (const row of currentMarkup.inline_keyboard) {
          for (const btn of row) {
            if ("callback_data" in btn && btn.callback_data.startsWith(ACTIONS.VOTE_LIKE)) {
              btn.text = t(lang, "btn_vote_like", { count: voteCounts.likes });
            } else if ("callback_data" in btn && btn.callback_data.startsWith(ACTIONS.VOTE_DISLIKE)) {
              btn.text = t(lang, "btn_vote_dislike", { count: voteCounts.dislikes });
            }
          }
        }
        await ctx.editMessageReplyMarkup({ reply_markup: currentMarkup }).catch(() => {});
      }
    }
  } catch (err: unknown) {
    if (isD1FreeTierError(err)) {
      await handleD1FreeTierError(ctx, err);
      return;
    }
    throw err;
  }
}