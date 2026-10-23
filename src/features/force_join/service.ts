import { Api } from "grammy";
import { Env, ForceChannel } from "../../core/types";
import { LIMITS } from "../../config";

let cachedChannels: ForceChannel[] | null = null;
let cacheExpiresAt = 0;

const MEMBERSHIP_CONCURRENCY = 6;

export async function getActiveForceChannels(env: Env): Promise<ForceChannel[]> {
  const now = Date.now();
  if (cachedChannels !== null && now < cacheExpiresAt) {
    return cachedChannels;
  }

  try {
    const rows = await env.DB.prepare(
      "SELECT channel_id, channel_name, button_text, invite_link, target_limit, is_active " +
      "FROM force_channels WHERE is_active = 1 ORDER BY created_at ASC, rowid ASC LIMIT ?"
    ).bind(LIMITS.MAX_FORCE_JOIN_CHANNELS).all<ForceChannel>();

    cachedChannels = rows.results || [];
    cacheExpiresAt = now + 120_000;
    return cachedChannels;
  } catch {
    return [];
  }
}

export function invalidateForceChannelsCache(): void {
  cachedChannels = null;
  cacheExpiresAt = 0;
}

/**
 * Deactivate a dead sponsor channel with a single conditional D1 write.
 * Never sends owner or log-channel alerts from a user request.
 */
export async function handleChannelDeactivation(
  _api: Api,
  env: Env,
  channel: ForceChannel,
  isLimitReached: boolean,
  _reason: string
): Promise<void> {
  if (isLimitReached && (!channel.target_limit || channel.target_limit <= 0)) {
    return;
  }

  try {
    void _api;
    void _reason;
    const res = await env.DB.prepare(
      "UPDATE force_channels SET is_active = 0 WHERE channel_id = ? AND invite_link = ? AND is_active = 1"
    ).bind(channel.channel_id, channel.invite_link).run();

    invalidateForceChannelsCache();
    if (res.meta.changes === 0) return;
  } catch (err) {
    console.error("Channel deactivation error:", err);
  }
}

type MembershipStatus = "ok" | "missing" | "flood";

function describeError(err: unknown): { code?: number; text: string } {
  const e = err as { error_code?: number; description?: string; message?: string; name?: string };
  const text = `${e.name || ""} ${e.description || ""} ${e.message || ""}`.toLowerCase();
  return { code: e.error_code, text };
}

function isTransportFailure(err: unknown): boolean {
  const { code, text } = describeError(err);
  if (typeof code === "number") return false;
  return (
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("fetch") ||
    text.includes("http") ||
    text.includes("econn") ||
    text.includes("socket") ||
    text.includes("httperror")
  );
}

async function classifyChannel(
  api: Api,
  env: Env,
  userId: number,
  channel: ForceChannel
): Promise<MembershipStatus> {
  const validStatuses = new Set(["member", "administrator", "creator"]);

  try {
    const member = await api.getChatMember(channel.channel_id, userId);
    if (validStatuses.has(member.status)) return "ok";
    if (member.status === "restricted" && (member as { is_member?: boolean }).is_member) return "ok";
    return "missing";
  } catch (err: unknown) {
    const { code, text } = describeError(err);

    if (code === 429 || text.includes("too many requests") || text.includes("retry after") || isTransportFailure(err)) {
      return "flood";
    }

    if (text.includes("user not found") || text.includes("user_not_participant")) {
      return "missing";
    }

    if (
      code === 403 ||
      text.includes("chat_admin_required") ||
      text.includes("bot was kicked") ||
      text.includes("chat not found")
    ) {
      await handleChannelDeactivation(api, env, channel, false, text);
      return "ok";
    }

    return "missing";
  }
}

export async function checkUserMembership(
  api: Api,
  env: Env,
  userId: number
): Promise<{ ok: boolean; missing: ForceChannel[] }> {
  const channels = await getActiveForceChannels(env);
  if (channels.length === 0) return { ok: true, missing: [] };

  const missing: ForceChannel[] = [];

  for (let i = 0; i < channels.length; i += MEMBERSHIP_CONCURRENCY) {
    const batch = channels.slice(i, i + MEMBERSHIP_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ch) => ({ ch, status: await classifyChannel(api, env, userId, ch) }))
    );

    let flooded = false;
    for (const result of results) {
      if (result.status === "flood") {
        flooded = true;
        missing.push(result.ch);
      } else if (result.status === "missing") {
        missing.push(result.ch);
      }
    }

    if (flooded) {
      missing.push(...channels.slice(i + MEMBERSHIP_CONCURRENCY));
      break;
    }
  }

  return { ok: missing.length === 0, missing };
}