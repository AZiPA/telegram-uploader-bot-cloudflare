import { BundleItem, MyContext } from "../core/types";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function truncateText(text: string, maxLen = 4096): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export function parseBundleItems(rawItems: string): BundleItem[] {
  try {
    const parsed = JSON.parse(rawItems);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function configuredChatId(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value === 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^-?\d+$/.test(raw) || raw === "0") return null;
  return raw;
}

export function getBotUsername(ctx: MyContext): string {
  const envUsername = ctx.env.BOT_USERNAME && ctx.env.BOT_USERNAME !== "YOUR_BOT_USERNAME_HERE"
    ? ctx.env.BOT_USERNAME
    : undefined;
  const username = envUsername || ctx.me?.username || "bot";
  return username.replace(/^@/, "").trim();
}

export function botIdFromToken(token: string | undefined | null): number | undefined {
  if (!token) return undefined;
  const match = /^(\d+):/.exec(token);
  if (!match) return undefined;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return id;
}