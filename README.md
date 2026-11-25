# هاب یکپارچه MCP برای ایران کمپینگ

یک سرور MCP واحد که **Claude، ChatGPT و Gemini** را به همه‌ی سیستم‌های شما وصل می‌کند و برای هر کارمند دسترسی جدا، لاگ جدا و سطح اختیار جدا دارد.

```
 Claude.ai / Claude Code / Claude Desktop ─┐
 ChatGPT (Developer mode connectors)      ─┼── HTTPS + OAuth ──►  هاب  (/mcp)
 Gemini CLI / Gemini API                  ─┘                       │
                                          ┌────────────┬───────────┼────────────┬──────────────┐
                                          ▼            ▼           ▼            ▼              ▼
                                   irancamping.com   VPS میهن‌وب   Instagram   ایجنت‌های AI    PC شما
                                   WordPress+Woo    iranoutdoor.com  (بدون FB)  ایران کمپینگ/بارنی  فایل، نرم‌افزار،
                                   REST API         SSH / local                  http/openai/MCP    Ollama/LM Studio
```

## چه چیزهایی دارد (۸۰+ ابزار)

| کانکتور | پیشوند ابزار | کارهایی که می‌شود کرد |
|---|---|---|
| **سایت اصلی** irancamping.com | `wp_` `wc_` | نوشتن/ویرایش/انتشار نوشته و صفحه، رسانه، کامنت‌ها، محصولات (قیمت، موجودی، وضعیت)، سفارش‌ها، گزارش فروش، کوپن |
| **VPS جدید** iranoutdoor.com | `vps_` | وضعیت سرور، لاگ‌ها، ری‌استارت سرویس‌ها، خواندن/نوشتن فایل با بک‌آپ، دستور خواندنی امن، شل ادمین (با تأیید) |
| **کامپیوتر شما** | `pc_` | لیست/خواندن/نوشتن فایل در پوشه‌های مجاز، اجرای نرم‌افزارهای مجاز، پردازش‌ها، شل (فقط اگر روی خود PC فعال کنید) |
| **مدل‌های لوکال** | `local_ai_` | Ollama و LM Studio روی PC شما: لیست مدل، چت، embedding، دانلود مدل |
| **اینستاگرام** | `ig_` | پروفایل، پست‌ها، آمار، کامنت‌ها، دایرکت، انتشار عکس/ریل/استوری/کاروسل، زمان‌بندی، صندوق وب‌هوک — **ورود فقط با خود اینستاگرام** |
| **ایجنت‌های AI** | `agent_` | گفتگو با ایجنت ایران کمپینگ و بارنی (پروتکل OpenAI / HTTP دلخواه / MCP)، صف کار و گزارش دوطرفه |
| **یکپارچگی** | `hub_` `workflow_` `search` `fetch` | حافظه‌ی مشترک بین همه‌ی کارمندان و همه‌ی مدل‌ها، گزارش روزانه، سلامت سایت‌ها، «محصول → پست اینستاگرام»، پیش‌نویس پاسخ کامنت با ایجنت، لاگ ممیزی |

## اصول ایمنی (پیش‌فرض‌ها)

- **هر کارمند یک کلید شخصی و یک نقش دارد**: `owner`، `manager`، `content`، `support`، `viewer` — و می‌توان برای هر نفر دسترسی را دستی تغییر داد. ابزارهای بدون دسترسی اصلاً برای او دیده نمی‌شوند.
- **کارهای پرخطر دو مرحله‌ای‌اند**: اول پیش‌نمایش + `confirm_token`، بعد اجرا با همان آرگومان‌ها (تغییر قیمت، انتشار، ری‌استارت سرویس، شل، دایرکت…). توکن به کاربر، ابزار و آرگومان‌ها قفل است و ۱۰ دقیقه اعتبار دارد.
- **محتوا پیش‌فرض پیش‌نویس است**؛ انتشار جدا و با تأیید.
- لاگ ممیزی همه‌ی فراخوانی‌ها (رمزها پاک می‌شوند)، محدودیت نرخ، توکن‌های اینستاگرام رمزگذاری‌شده (AES-256-GCM)، محافظ SSRF، فهرست مجاز دستورها، مسدودسازی دستورهای مخرب، فایل‌های حساس (`wp-config.php`, `.env`, کلیدها) خوانده نمی‌شوند.
- جزئیات و محدودیت‌های صادقانه: [`docs/SECURITY.md`](docs/SECURITY.md)

## شروع سریع

```bash
npm install && npm run build
cp .env.example .env            # HUB_SECRET را با: node dist/cli.js secret بسازید و بقیه را پر کنید
cp agents.example.json agents.json
node dist/cli.js user add --name owner --role owner     # کلید دسترسی فقط یک بار نمایش داده می‌شود
node dist/cli.js doctor                                 # بررسی تنظیمات و اتصال‌ها
npm start
```

بعد از استقرار روی HTTPS:
- اتصال Claude / ChatGPT / Gemini → [`docs/CONNECT.md`](docs/CONNECT.md)
- نصب روی VPS میهن‌وب، nginx، systemd، نصب ایجنت PC و اتصال اینستاگرام → [`docs/DEPLOY.md`](docs/DEPLOY.md)

## مدیریت کارمندان

```bash
node dist/cli.js user add --name sara --role content --grant localai=write
node dist/cli.js user role sara support
node dist/cli.js user rotate sara      # کلید جدید؛ کلید قبلی بی‌اعتبار می‌شود
node dist/cli.js user disable sara     # قطع فوری (توکن‌های OAuth هم از کار می‌افتند)
node dist/cli.js tools --user sara     # دقیقاً چه ابزارهایی می‌بیند
node dist/cli.js roles
```

## ساختار پروژه

```
src/app.ts            اپ Express: OAuth، /mcp، وب‌هوک اینستاگرام، گذرگاه ایجنت‌ها
src/core/             کاربران و نقش‌ها، تأیید دومرحله‌ای، لاگ ممیزی، رمزنگاری، SQLite
src/connectors/       wordpress · vps · pc (+local AI) · instagram · agents · integration
src/pc-agent/         برنامه‌ای که روی کامپیوتر شما اجرا می‌شود (اتصال خروجی، بدون باز کردن پورت)
src/cli.ts            مدیریت کاربران، doctor
test/                 ۶۹ تست (سیاست‌ها، RBAC، OAuth، WordPress/Instagram جعلی، پل PC)
```

## آنچه از شما لازم دارم (برای تکمیل راه‌اندازی)

1. نشانی/API ایجنت **ایران کمپینگ** و **بارنی** (OpenAI-compatible؟ REST؟ MCP؟) تا `agents.json` را دقیق کنیم.
2. آیا هاب روی VPS میهن‌وب اجرا شود یا روی سرور خارج از ایران (به‌خاطر دسترسی به API اینستاگرام — [`docs/DEPLOY.md`](docs/DEPLOY.md) بخش ۶).
3. ساخت اپ در developers.facebook.com برای «Instagram API with Instagram Login» (راهنما در DEPLOY).
