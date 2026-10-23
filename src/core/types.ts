import { AsyncLocalStorage } from "node:async_hooks";
import { Context } from "grammy";

export interface RequestStore {
  env: Env;
  executionCtx: ExecutionContext;
}

export const requestStorage = new AsyncLocalStorage<RequestStore>();

export interface Env {
  DB: D1Database;
  FILESTORE_ANALYTICS: AnalyticsEngineDataset;
  BOT_TOKEN: string;
  BOT_USERNAME?: string;
  BOT_FIRST_NAME?: string;
  ENABLE_QUOTA_CACHE?: string;
  OWNER_ID: number | string;
  STORAGE_CHANNEL_ID?: number | string;
  LOG_CHANNEL_ID?: number | string;
  WEBHOOK_SECRET?: string;
  WEBHOOK_PATH?: string;
}

export interface ForceChannel {
  channel_id: string;
  channel_name: string;
  button_text: string;
  invite_link: string;
  target_limit: number;
  is_active: number;
}

export type UserRole = "owner" | "superadmin" | "admin" | "vip" | "user";

export type BundleMediaType = "document" | "video" | "audio" | "photo" | "animation" | "voice";

export interface BundleItem {
  file_id: string;
  file_unique_id: string;
  type: BundleMediaType;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  storage_message_id?: number;
}

export interface BundleRow {
  code: string;
  title: string | null;
  items: string; // JSON string
  created_by: number;
  protect_content: number;
  created_at: number;
  owner_locked?: number;
  expires_at?: number;
  is_one_time?: number;
  consumed_by?: number;
  passcode_hash?: string | null;
  post_channel_id?: string | null;
  post_message_id?: number;
  rotate_interval_sec?: number;
  last_rotated_at?: number;
}

export interface Bundle extends Omit<BundleRow, "items"> {
  items: BundleItem[];
}

export interface CustomContextFields {
  env: Env;
  executionCtx: ExecutionContext;
  role: UserRole;
  isOwner: boolean;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  lang: string;
}

export type BotContext = Context & CustomContextFields;
export type MyContext = BotContext;