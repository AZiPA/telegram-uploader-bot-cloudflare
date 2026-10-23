import { Env, MyContext, requestStorage } from "./core/types";
import { createBot } from "./bot";
import { isUserMemoryBanned } from "./middlewares/rate_limit";
import { isD1FreeTierError } from "./core/logger";
import { ButtonFactory } from "./shared/buttons";
import { Bot, Api } from "grammy";
import { Update } from "grammy/types";

let cachedBot: Bot<MyContext> | null = null;

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const url = new URL(request.url);
    if (!env.WEBHOOK_PATH || url.pathname !== `/${env.WEBHOOK_PATH.replace(/^\/+/, "")}`) {
      return new Response("Not Found", { status: 404 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const update = (await request.json().catch(() => null)) as Update | null;
      if (!update || typeof update !== "object") {
        return new Response("OK", { status: 200 });
      }

      const userId = update.message?.from?.id || update.callback_query?.from?.id;
      const isOwner = userId && String(userId) === String(env.OWNER_ID);

      if (userId && !isOwner && isUserMemoryBanned(userId)) {
        return new Response("OK", { status: 200 });
      }

      if (!cachedBot) {
        cachedBot = createBot(env);
      }

      return await requestStorage.run({ env, executionCtx }, async () => {
        // botInfo injected in createBot makes isInited() true, so this does not call getMe.
        if (!cachedBot!.isInited()) {
          await cachedBot!.init();
        }
        await cachedBot!.handleUpdate(update);
        return new Response("OK", { status: 200 });
      });
    } catch (err) {
      console.error("Worker fetch processing error:", err);
      return new Response("OK", { status: 200 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const nowUtc = new Date();
    try {
      const api = new Api(env.BOT_TOKEN);
      let executedSubrequests = 0;

      const res = await env.DB.prepare(
        "SELECT id, chat_id, message_ids FROM deletion_queue WHERE delete_at <= ? ORDER BY id ASC LIMIT 25"
      ).bind(now).all<{ id: number; chat_id: number; message_ids: string }>();
      const rows = res.results || [];

      if (rows.length > 0) {
        const chatGroups = new Map<number, { rowIds: number[]; messageIds: number[] }>();

        for (const item of rows) {
          const group = chatGroups.get(item.chat_id) || { rowIds: [], messageIds: [] };
          group.rowIds.push(item.id);

          let ids: number[] = [];
          if (item.message_ids) {
            try {
              const parsed = JSON.parse(item.message_ids);
              ids = Array.isArray(parsed) ? parsed : [];
            } catch {
              ids = String(item.message_ids).split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
            }
          }

          if (!Array.isArray(ids)) {
            ids = [];
          }
          ids = ids.filter((n) => Number.isSafeInteger(n) && n > 0);

          group.messageIds.push(...ids);
          chatGroups.set(item.chat_id, group);
        }

        const successfulRowIds: number[] = [];
        let hitFloodWait = false;
        for (const [chatId, data] of chatGroups.entries()) {
          if (executedSubrequests >= 35 || hitFloodWait) break;

          let chatSuccess = true;
          for (let i = 0; i < data.messageIds.length; i += 100) {
            if (executedSubrequests >= 35) {
              chatSuccess = false;
              break;
            }
            const chunk = data.messageIds.slice(i, i + 100);
            try {
              await api.deleteMessages(chatId, chunk);
            } catch (err: any) {
              const errCode = err?.error_code;
              if (errCode === 429) {
                chatSuccess = false;
                hitFloodWait = true;
                break;
              }
              // 400 (message already deleted or not found) or 403 (bot kicked) are pruned
              if (errCode !== 400 && errCode !== 403) {
                chatSuccess = false;
              }
            }
            executedSubrequests++;
          }

          if (chatSuccess) {
            successfulRowIds.push(...data.rowIds);
          }
        }

        if (successfulRowIds.length > 0) {
          const placeholders = successfulRowIds.map(() => "?").join(",");
          await env.DB.prepare(`DELETE FROM deletion_queue WHERE id IN (${placeholders})`).bind(...successfulRowIds).run();
        }
      }

      // Every 15 minutes: auto-rotate links for channel posts whose rotate interval has elapsed
      if (nowUtc.getUTCMinutes() % 15 === 0 && executedSubrequests < 28) {
        // Purge up to 10 consumed & expired one-time bundles (abandoned multi-chunk deliveries)
        try {
          const expiredOneTimeRes = await env.DB.prepare(
            "SELECT code FROM bundles WHERE is_one_time = 1 AND consumed_by > 0 AND expires_at > 0 AND expires_at <= ? LIMIT 10"
          ).bind(now).all<{ code: string }>();
          const expiredOneTimeRows = expiredOneTimeRes.results || [];
          if (expiredOneTimeRows.length > 0) {
            const deleteStatements = expiredOneTimeRows.flatMap((r) => [
              env.DB.prepare("DELETE FROM bundle_votes WHERE code = ?").bind(r.code),
              env.DB.prepare("DELETE FROM bundles WHERE code = ?").bind(r.code),
            ]);
            await env.DB.batch(deleteStatements);
          }
        } catch (oneTimeErr) {
          if (isD1FreeTierError(oneTimeErr)) {
            console.warn("D1 free-tier error purging expired one-time bundles");
          } else {
            console.error("Purge expired one-time bundles error:", oneTimeErr);
          }
        }

        try {
          const dueRes = await env.DB.prepare(
            "SELECT code, post_channel_id, post_message_id, rotate_interval_sec FROM bundles " +
            "WHERE rotate_interval_sec > 0 AND post_channel_id IS NOT NULL AND (last_rotated_at + rotate_interval_sec) <= ? " +
            "ORDER BY last_rotated_at ASC LIMIT 5"
          ).bind(now).all<{ code: string; post_channel_id: string; post_message_id: number; rotate_interval_sec: number }>();
          const rotatingRows = dueRes.results || [];

          if (rotatingRows.length > 0) {
            const botUsername = env.BOT_USERNAME ? env.BOT_USERNAME.replace(/^@/, "") : "";
            for (const item of rotatingRows) {
              if (executedSubrequests >= 35) break;
              const newCode = crypto.randomUUID();
              const oldCode = item.code;

              try {
                await env.DB.batch([
                  env.DB.prepare(
                    "UPDATE bundles SET code = ?, protect_content = 1, last_rotated_at = ? WHERE code = ?"
                  ).bind(newCode, now, oldCode),
                  env.DB.prepare(
                    "UPDATE bundle_votes SET code = ? WHERE code = ?"
                  ).bind(newCode, oldCode),
                  env.DB.prepare(
                    "UPDATE user_downloads SET bundle_code = ? WHERE bundle_code = ? AND access_date = date('now')"
                  ).bind(newCode, oldCode)
                ]);

                const shareLink = `https://t.me/${botUsername}?start=${newCode}`;
                const kb = ButtonFactory.channelPostKeyboard("en", shareLink);

                try {
                  await api.editMessageReplyMarkup(item.post_channel_id, item.post_message_id, {
                    reply_markup: kb
                  });
                  executedSubrequests++;
                } catch (apiErr: any) {
                  executedSubrequests++;
                  const errCode = apiErr?.error_code;
                  if (errCode === 400 || errCode === 403) {
                    await env.DB.prepare(
                      "UPDATE bundles SET rotate_interval_sec = 0, post_channel_id = NULL, post_message_id = 0 WHERE code = ?"
                    ).bind(newCode).run();
                  } else if (errCode === 429) {
                    break;
                  }
                }
              } catch (dbErr) {
                if (isD1FreeTierError(dbErr)) {
                  console.warn("D1 free-tier error during auto-rotation cron");
                  break;
                }
                console.error("Auto-rotation batch error for bundle:", oldCode, dbErr);
              }
            }
          }
        } catch (cronErr) {
          if (isD1FreeTierError(cronErr)) {
            console.warn("D1 free-tier error querying rotating bundles");
          } else {
            console.error("Auto-rotation cron error:", cronErr);
          }
        }
      }

      // Sunday UTC: at most 25 aged download rows per cron tick during the first 3 hours.
      if (nowUtc.getUTCDay() === 0 && nowUtc.getUTCHours() < 3) {
        executionCtx.waitUntil(
          env.DB.prepare(
            "DELETE FROM user_downloads WHERE id IN (" +
            "SELECT id FROM user_downloads WHERE access_date < date('now', '-7 days') ORDER BY id ASC LIMIT 25" +
            ")"
          ).run().catch((err) => {
            if (isD1FreeTierError(err)) {
              console.warn("D1 free-tier limit reached during Sunday cleanup; pausing until reset.");
              return;
            }
            console.error("Weekly cleanup error:", err);
          })
        );
      }
    } catch (err) {
      console.error("Scheduled cron error:", err);
    }
  }
};