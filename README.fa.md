<div dir="rtl">

[English](./README.md) | **فارسی**

# ربات آپلودر تلگرام — فایل‌استور سرورلس روی کلادفلر ورکرز و D1

[![مستندات زنده](https://img.shields.io/badge/Docs-azipa.github.io-007ACC?style=flat-square)](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/)
[![زیرساخت](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![grammY](https://img.shields.io/badge/grammY-%5E1.46.0-009688?style=flat-square)](https://grammy.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-24%20(CI)-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./.github/workflows/deploy.yml)
[![مجوز: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue?style=flat-square)](./LICENSE)

یک ربات آپلودر تلگرام و ربات فایل‌استور تلگرام با TypeScript و کتابخانه grammY که اختصاصاً برای **کلادفلر ورکرز** و **دیتابیس Cloudflare D1** طراحی شده و **بدون نیاز به VPS**، بدون KV/R2 و بدون عبور بایت فایل از Worker اجرا می‌شود. این ربات از کرون‌جاب حذف خودکار دقیقه‌ای، تله‌متری Analytics Engine، رابط دوزبانه فارسی و انگلیسی، لینک رمزدار با هش SHA-256، قفل جوین اجباری چندکاناله، محافظت از محتوا، لینک یک‌بارمصرف، چرخش خودکار لینک و تحویل گروهی مقاوم پشتیبانی می‌کند.

> [!NOTE]
> 1. **ورکر صرفاً بک‌اند (Backend-only):** فقط مسیر `POST /<WEBHOOK_PATH>` را با احراز هویت هدر `X-Telegram-Bot-Api-Secret-Token` ارائه می‌دهد (بدون مینی‌اپ یا فرانت‌اند ایستا)؛ فایل‌ها روی سرورهای تلگرام می‌مانند (`file_id` به‌همراه کانال آرشیو خصوصی اختیاری).
> 2. **نسخه سرورلس بومی تلگرام را ترجیح می‌دهید (بدون نیاز به حساب ابری جانبی)؟** از مخزن همکار [`AZiPA/telegram-uploader-bot`](https://github.com/AZiPA/telegram-uploader-bot) ([مستندات فارسی](https://azipa.github.io/fa/projects/telegram-uploader-bot/)) استفاده کنید.

## راه‌اندازی سریع (GitHub Actions)

1. **آماده‌سازی ربات و دسترسی کلودفلر:** یک ربات در `@BotFather` بسازید (`BOT_TOKEN`؛ عضویت در گروه و حالت inline را غیرفعال کنید) و یک توکن API کلودفلر از قالب **Edit Cloudflare Workers** با مجوزهای `Workers Scripts:Edit`، `D1:Edit`، `Account Settings:Read` (و فقط در صورت اتصال دامنه اختصاصی، مجوزهای سطح Zone شامل `Workers Routes:Edit` / `DNS:Edit`) همراه با شناسه ۳۲ کاراکتری `CLOUDFLARE_ACCOUNT_ID` بسازید.
2. **فورک کردن مخزن:** روی مخزن [`AZiPA/telegram-uploader-bot-cloudflare`](https://github.com/AZiPA/telegram-uploader-bot-cloudflare) دکمه **Fork** را بزنید تا کپی اختصاصی خود را بسازید.
3. **افزودن رازهای مخزن (Secrets):** در مسیر **Settings → Secrets and variables → Actions** رازهای الزامی (`CLOUDFLARE_API_TOKEN`، `CLOUDFLARE_ACCOUNT_ID`، `BOT_TOKEN`، `OWNER_ID`، `WEBHOOK_PATH` و `WEBHOOK_SECRET` با حداقل ۱۶ نویسه) و رازهای اختیاری `BOT_USERNAME` (پیشنهادشده برای حذف `getMe` در استارت سرد)، `STORAGE_CHANNEL_ID`، `LOG_CHANNEL_ID` و `BOT_FIRST_NAME` را ثبت کنید.
4. **دیپلوی با GitHub Actions و ثبت وب‌هوک:** ورک‌فلوی **Deploy Worker** را اجرا کنید (در صورت نیاز با ورودی‌های اختیاری `custom_db_name`، `custom_db_region` یا `custom_worker_name` در `workflow_dispatch`؛ CI دیتابیس D1 با نام `filestore-db` را تأمین می‌کند، `schema.sql` را اعمال کرده، `OWNER_ID` را ثبت می‌کند و دیپلوی انجام می‌شود)، سپس وب‌هوک تلگرام را روی `https://<your-domain>/<WEBHOOK_PATH>` همراه با `secret_token` ثبت کنید (`scripts/webhook.mjs` یا `setWebhook`) و دستور `/start` را در چت خصوصی ربات بفرستید.

> **برای تنظیم قوانین WAF دامنه اختصاصی، دیپلوی محلی با `wrangler` یا دستورات وب‌هوک در Bash/CMD/PowerShell،** به [**راهنمای راه‌اندازی و دیپلوی**](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/setup/) مراجعه کنید.

## ویژگی‌های کلیدی

- **آپلود تکی و دسته‌ای به‌همراه آینه‌سازی در کانال آرشیو:** پشتیبانی از ۶ نوع رسانه (`document`، `video`، `audio`، `photo`، `animation`، `voice`) با سقف ۲۰ فایل در هر نشست دسته‌ای (مهلت ۶۰۰ ثانیه) و ۲۵ فایل در هر بسته؛ با تنظیم اختیاری `STORAGE_CHANNEL_ID`، تحویل دسته‌ای با `copyMessages` در یک زیردرخواست و بازگشت خودکار به `file_id` انجام می‌شود.
- **محافظت از محتوا، پین‌کد SHA-256 و لینک‌های زمان‌دار:** تحویل در بخش‌های ۱۰ فایلی با دکمه‌های رنگی Bot API، فعال‌سازی `protect_content` و ارتقا به UUID v4، لینک رمزدار با `/setpass` (هش SHA-256 و قفل موقت ۳۰ دقیقه‌ای پس از ۵ خطا بدون نوشتن در D1)، انقضای TTL با `/setexpiry` و `/setbundlettl`، حذف خودکار با کرون دقیقه‌ای (`LIMIT 25` ردیف در هر تیک) و بسته‌های یک‌بارمصرف.
- **چرخش خودکار لینک هر ۱۵ دقیقه و همگام‌سازی کانال:** پشتیبانی از چرخش دستی (`/rotatelink`) و چرخش خودکار زمان‌بندی‌شده هر ۱۵ دقیقه (`LIMIT 5` بسته در هر نوبت) که کدهای D1 را به‌صورت اتمیک تغییر داده و دکمه پست کانال `/postbundle` را به‌طور زنده به‌روزرسانی می‌کند.
- **قفل جوین اجباری چندکاناله و رأی‌گیری کاربران:** بررسی عضویت تا ۸ کانال در موج‌های ۶ سوکتی (بسته‌شدن ایمن در خطای ۴۲۹ یا اختلال شبکه)، امکان شخصی‌سازی متن دکمه تایید و دکمه هر کانال، سقف جذب عضو در لینک دعوت و رأی‌گیری لایک/دیسلایک برای بسته‌های غیرمحافظت‌شده.
- **سطوح دسترسی ۵لایه، امنیت و پشتیبان‌گیری اتمیک:** تفکیک نقش‌های مالک، سوپرادمین، ادمین (حداکثر ۱۰ ادمین عادی)، کاربر ویژه VIP (ضریب سهمیه ۵× روزانه و ۳× هر لینک) و کاربر عادی؛ مالکیت انحصاری با راز `OWNER_ID`، بررسی هدر وب‌هوک به‌صورت fail-closed و محدودیت تحویل در چت خصوصی ربات، محدودکننده نرخ ثابت‌بازه‌ای در حافظه (۳ درخواست در ۵ ثانیه ← ۶۰ ثانیه سکوت) و پشتیبان‌گیری با `/factoryreset confirm` + بازیابی اتمیک JSON با `/restore` (تا ۲۵۶ کیلوبایت).
- **مهندسی‌شده برای پلن رایگان کلودفلر و رابط دوزبانه:** مبتنی بر اسکیمای ۱۰ جدولی D1 با ۲ تریگر سهمیه روزانه و ۸ ایندکس، ثبت آمار در Workers Analytics Engine (`filestore_analytics`)، ذخیره‌سازی تک‌ردیفی JSON در `bundles.items` با CAS (کاهش تا ۹۶٪ عملیات نوشتن نسبت به مدل هر فایل یک ردیف) و پشتیبانی کامل از ۳۲۲ کلید ترجمه فارسی و انگلیسی.

## مرکز مستندات کامل

| بخش | راهنمای آنلاین |
|---|---|
| معرفی، محدودیت‌های پلن رایگان و نسخه‌ها | [معرفی و ویژگی‌ها](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/) |
| توکن کلودفلر، رازها، قوانین WAF و وب‌هوک | [راه‌اندازی و دیپلوی](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/setup/) |
| نشست‌های آپلود، تحویل دسته‌ای، پین‌کد و چرخش لینک | [آپلود، تحویل و امنیت محتوا](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/features-delivery/) |
| سطوح دسترسی ۵لایه، جوین اجباری، محدودیت نرخ و بکاپ | [نقش‌ها، امنیت و مدیریت](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/roles-security/) |
| دستورات مدیریتی، سهمیه‌ها و تنظیمات زنده `/settings` | [دستورات و پیکربندی](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/commands-config/) |
| چرخه حیات ورکر، اسکیمای تک‌ردیفی D1 و بودجه کرون | [معماری، دیتابیس D1 و کرون](https://azipa.github.io/fa/projects/telegram-uploader-bot-cloudflare/architecture/) |

## مجوز انتشار

تحت مجوز [Mozilla Public License 2.0 (MPL-2.0)](./LICENSE) منتشر شده است.

</div>
