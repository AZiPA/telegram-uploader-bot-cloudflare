**English** | [فارسی](./README.fa.md)

# Telegram Uploader Bot — Serverless File Store on Cloudflare Workers & D1

[![Live Docs](https://img.shields.io/badge/Docs-azipa.github.io-007ACC?style=flat-square)](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/)
[![Runtime](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![grammY](https://img.shields.io/badge/grammY-%5E1.46.0-009688?style=flat-square)](https://grammy.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-24%20(CI)-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./.github/workflows/deploy.yml)
[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue?style=flat-square)](./LICENSE)

A TypeScript and grammY Telegram uploader bot and Telegram file store bot engineered for **Cloudflare Workers** and **Cloudflare D1**—requiring **zero VPS**, zero KV/R2, and zero file-byte proxying. Built around auto-delete cron triggers, Analytics Engine telemetry, bilingual English/Persian UI, password-protected links (SHA-256 PINs), force-join channels, content protection, one-time burn links, and auto-rotating links.

> [!NOTE]
> 1. **Backend-only Cloudflare Worker:** Exposes only `POST /<WEBHOOK_PATH>` authenticated via `X-Telegram-Bot-Api-Secret-Token` (no Mini App or static frontend); media remains on Telegram servers (`file_id` + optional private Storage Channel mirror).
> 2. **Prefer native Telegram Serverless (zero external cloud account)?** Use the sister edition [`AZiPA/telegram-uploader-bot`](https://github.com/AZiPA/telegram-uploader-bot) ([Documentation](https://azipa.github.io/projects/telegram-uploader-bot/)).

## Quick Start (GitHub Actions)

1. **Prepare Bot & Cloudflare Access:** Create a bot in `@BotFather` (`BOT_TOKEN`; disable group joins and inline mode) and create a Cloudflare API token from the **Edit Cloudflare Workers** template (`Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read`; add Zone-level `Workers Routes:Edit` / `DNS:Edit` only when binding a custom domain) alongside your 32-character `CLOUDFLARE_ACCOUNT_ID`.
2. **Fork the Repository:** Click **Fork** on [`AZiPA/telegram-uploader-bot-cloudflare`](https://github.com/AZiPA/telegram-uploader-bot-cloudflare) to create your own copy.
3. **Add Repository Secrets:** Under **Settings → Secrets and variables → Actions**, add the required secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BOT_TOKEN`, `OWNER_ID`, `WEBHOOK_PATH`, and `WEBHOOK_SECRET` with at least 16 characters), plus optional `BOT_USERNAME` (recommended to skip `getMe` on cold starts), `STORAGE_CHANNEL_ID`, `LOG_CHANNEL_ID`, and `BOT_FIRST_NAME`.
4. **Deploy & Register Webhook:** Run the **Deploy Worker** GitHub Actions deploy workflow (optionally setting `custom_db_name`, `custom_db_region`, or `custom_worker_name` via `workflow_dispatch`; CI provisions D1 `filestore-db`, applies `schema.sql`, seeds `OWNER_ID`, and deploys), register your Telegram webhook at `https://<your-domain>/<WEBHOOK_PATH>` with `secret_token` (`scripts/webhook.mjs` or `setWebhook`), and send `/start` in private chat.

> **Need custom-domain WAF rules, local `wrangler` deployment, or Bash/CMD/PowerShell webhook commands?** See the [**Setup & Deployment Guide**](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/setup/).

## Key Features

- **Single & Batch Uploads with Bulk Storage Mirroring:** Accepts 6 media types (`document`, `video`, `audio`, `photo`, `animation`, `voice`) with caps of 20 files per batch session (`600s` timeout) and 25 files per bundle; optional `STORAGE_CHANNEL_ID` mirroring enables 1-subrequest `copyMessages` delivery with automatic `file_id` fallback.
- **Content Protection, SHA-256 Passcodes & Ephemeral Links:** Delivers files in 10-item chunks with Bot API colored buttons, optional `protect_content` + UUID v4 upgrades, `/setpass` SHA-256 PIN protection with a 0-write 5-strike/30-minute lockout, `/setexpiry` / `/setbundlettl` expiration, minute-cron auto-delete (`LIMIT 25` rows/tick), and one-time burn bundles.
- **15-Minute Auto-Rotation & Live Channel Sync:** Supports manual `/rotatelink` rotation and scheduled 15-minute cron rotation (`LIMIT 5` due bundles) that atomically updates D1 codes and refreshes `/postbundle` channel post buttons in real time.
- **Multi-Channel Force-Join & Community Voting:** Enforces up to 8 force-join channels checked in 6-socket waves (fail-closed on 429/transport errors), customizable verify and channel button labels, invite member limits, and per-bundle like/dislike voting on non-protected bundles.
- **5-Level RBAC, Security & Atomic Backups:** Enforces Owner, Super Admin, Admin (max 10 regular admins), VIP (×5 daily / ×3 per-link quota multipliers), and User permissions with secret-only `OWNER_ID`, fail-closed webhook secret and private-chat delivery guards, an in-memory fixed-window burst rate limiter (`3` updates / `5s` → `60s` mute), and `/factoryreset confirm` export + atomic `/restore` JSON recovery (up to 256 KB).
- **Cloudflare Free-Tier Engineered + Bilingual UI:** Uses a 10-table D1 schema with 2 daily-limit SQL triggers and 8 indexes, Workers Analytics Engine telemetry (`filestore_analytics`), single-row JSON `bundles.items` CAS storage (up to 96% fewer item writes than per-file rows), and a 322-key English/Persian UI.

## Full Documentation Hub

| Topic | Documentation Guide |
|---|---|
| Overview, Free-Tier Limits & Editions | [Overview & Highlights](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/) |
| Cloudflare API Token, Secrets, WAF & Webhook | [Setup & Deployment](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/setup/) |
| Upload Sessions, Chunk Delivery, PINs & Auto-Rotation | [Uploads, Delivery & Protection](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/features-delivery/) |
| 5-Level RBAC, Force-Join, Rate Limits & Backups | [Roles, Security & Operations](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/roles-security/) |
| Operator Commands, Quotas & Live `/settings` | [Commands & Configuration](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/commands-config/) |
| Worker Lifecycle, Single-Row D1 Schema & Cron Budget | [Architecture, D1 Schema & Cron](https://azipa.github.io/projects/telegram-uploader-bot-cloudflare/architecture/) |

## License

Licensed under the [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE).
