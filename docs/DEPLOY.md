# استقرار هاب (VPS میهن‌وب) + ایجنت PC + اینستاگرام

## ۱) کجا اجرا شود؟
هاب باید از اینترنت خارجی با **HTTPS** قابل دسترسی باشد، چون Claude/ChatGPT از سرورهای خودشان به آن وصل می‌شوند.

| گزینه | مزیت | عیب |
|---|---|---|
| **روی VPS میهن‌وب** (iranoutdoor.com) | کنار سایت؛ `VPS_MODE=local` بدون SSH؛ دسترسی سریع به irancamping.com | دسترسی به API اینستاگرام از IP ایران معمولاً مسدود است ← نیاز به `IG_PROXY_URL` یا آینه (بخش ۶)؛ و باید مطمئن شوید سرورهای Anthropic/OpenAI/Google به IP ایرانی می‌رسند |
| **سرور خارج از ایران** | اینستاگرام و ابزارهای AI بدون مشکل | برای کنترل VPS باید `VPS_MODE=ssh` و برای irancamping.com اتصال خارج→ایران برقرار باشد |

پیشنهاد: اگر تست اولیه نشان داد اینستاگرام از VPS ایرانی در دسترس نیست، هاب را روی یک سرور کوچک خارجی بگذارید و VPS میهن‌وب را با SSH (کلید + کاربر محدود) وصل کنید.

## ۲) نصب (Ubuntu 22.04/24.04)
```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs nginx
sudo useradd --system --create-home --shell /usr/sbin/nologin mcphub
sudo -u mcphub git clone <repo-url> /opt/iran-camping-hub && cd /opt/iran-camping-hub
sudo -u mcphub npm ci && sudo -u mcphub npm run build
sudo -u mcphub cp .env.example .env && sudo -u mcphub cp agents.example.json agents.json
sudo -u mcphub chmod 600 .env
sudo -u mcphub node dist/cli.js secret     # مقدار را در HUB_SECRET بگذارید
sudo -u mcphub node dist/cli.js user add --name owner --role owner
sudo cp deploy/iran-camping-hub.service /etc/systemd/system/ && sudo systemctl enable --now iran-camping-hub
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mcp && sudo ln -s /etc/nginx/sites-available/mcp /etc/nginx/sites-enabled/
sudo certbot --nginx -d mcp.iranoutdoor.com
sudo -u mcphub node dist/cli.js doctor
```
DNS: رکورد A برای `mcp.iranoutdoor.com` به IP سرور. nginx حتماً بافر پاسخ را خاموش دارد (در فایل نمونه هست).

## ۳) WordPress / WooCommerce (irancamping.com)
1. یک کاربر اختصاصی بسازید (مثلاً `mcp-hub`) با نقش **Shop Manager** (یا Editor) — نه Administrator.
2. پروفایل کاربر → **Application Passwords** → بسازید → `WP_USER` و `WP_APP_PASSWORD`.
3. WooCommerce → تنظیمات → پیشرفته → **REST API** → کلید با دسترسی Read/Write → `WC_KEY` و `WC_SECRET`.
4. اگر افزونه‌ی امنیتی/WAF دارید، REST API و هدر Authorization را برای IP هاب مجاز کنید. سایت باید HTTPS باشد.

## ۴) VPS iranoutdoor.com
- **هاب روی خود VPS**: `VPS_MODE=local`، و کاربر `mcphub` را فقط به گروه‌های لازم اضافه کنید. برای ری‌استارت سرویس‌ها یک فایل sudoers محدود بدهید:
  ```
  # /etc/sudoers.d/mcphub
  mcphub ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx, /usr/bin/systemctl restart php8.2-fpm, /usr/bin/systemctl restart mysql, /usr/sbin/nginx -t
  ```
  (هاب برای کاربر غیر root خودکار `sudo -n` می‌گذارد؛ مرز واقعی امنیت همین sudoers است. اگر از هاردنینگ systemd استفاده می‌کنید `NoNewPrivileges` باید خاموش بماند.)
- **هاب جای دیگر**: `VPS_MODE=ssh`، کلید ed25519 اختصاصی، کاربر غیر root، و حتماً `VPS_HOST_KEY_SHA256` (اثرانگشت کلید میزبان) را تنظیم کنید تا حمله‌ی MITM ممکن نباشد.
- `VPS_FILE_ROOTS` را فقط به پوشه‌هایی که لازم است محدود کنید.

## ۵) ایجنت کامپیوتر شخصی
روی PC خودتان (Windows/Mac/Linux، Node ≥ 22):
```bash
git clone <repo-url> && cd claude-website && npm ci && npm run build
```
فایل `agent.config.json` (کنار پروژه):
```json
{
  "hubUrl": "wss://mcp.iranoutdoor.com/agent/ws",
  "token": "همان PC_AGENT_TOKEN هاب",
  "name": "main",
  "roots": ["C:\\Users\\me\\Documents\\iran-camping"],
  "writeRoots": ["C:\\Users\\me\\Documents\\iran-camping\\output"],
  "allowExec": false,
  "apps": { "vscode": "code", "blender": "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe" },
  "aiProviders": { "ollama": "http://127.0.0.1:11434", "lmstudio": "http://127.0.0.1:1234/v1" }
}
```
اجرا: `npm run agent` (برای اجرای دائم: Task Scheduler در ویندوز یا systemd/launchd). فقط اتصال **خروجی** برقرار می‌شود.
- پیش‌فرض: هیچ پوشه‌ای باز نیست و اجرای دستور **خاموش** است. فقط وقتی لازم دارید `allowExec: true` کنید.
- مدل‌ها: Ollama را نصب و `ollama pull qwen2.5:7b` بزنید؛ `local_ai_models` آن را می‌بیند.

## ۶) اینستاگرام (بدون لاگین فیسبوک)
از «Instagram API with Instagram Login» استفاده می‌شود: کاربر فقط با اینستاگرام وارد می‌شود و صفحه‌ی فیسبوک لازم نیست. شرط‌ها:
1. حساب اینستاگرام باید **Business یا Creator** باشد (تبدیل از تنظیمات اینستاگرام، رایگان).
2. یک **اپ در developers.facebook.com** لازم است (حتی بدون لاگین فیسبوک برای کاربران). Use case: *Instagram* → *API setup with Instagram login*. مقادیر `IG_APP_ID` و `IG_APP_SECRET` را از همان‌جا بردارید.
3. در تنظیمات اپ، **Valid OAuth Redirect URI** را دقیقاً `https://mcp.iranoutdoor.com/instagram/callback` بگذارید (ابزار `ig_accounts` همین آدرس را نشان می‌دهد).
4. برای حساب‌های خودتان، اپ در حالت Development کافی است (حساب را به‌عنوان Instagram Tester اضافه و قبول کنید). برای حساب‌های دیگر، App Review لازم است.
5. وب‌هوک (اختیاری، برای صندوق کامنت/دایرکت زنده): Callback `https://mcp.iranoutdoor.com/instagram/webhook` و Verify Token = `IG_WEBHOOK_VERIFY_TOKEN`؛ سپس ابزار `ig_subscribe_webhooks`.
6. اتصال: با حساب owner ابزار `ig_connect_start` را بزنید، لینک را در مرورگری که در اینستاگرام وارد شده‌اید باز کنید و تأیید کنید. توکن ۶۰‌روزه است و هاب هر هفته خودکار تمدیدش می‌کند.

**دسترسی از ایران:** سرورهای Meta اغلب از IP ایران بسته‌اند و ثبت‌نام توسعه‌دهنده هم ممکن است محدود باشد (تحریم/محدودیت منطقه‌ای) — این را من از اینجا نمی‌توانم تأیید کنم؛ باید امتحان کنید. اگر مسدود بود: `IG_PROXY_URL=http://…` (پروکسی روی سرور خارج) یا آینه‌ی معکوس با `IG_GRAPH_BASE=https://ig-mirror.example.com` یا اجرای هاب در خارج.
عکس‌های انتشار باید **JPEG** و روی URL عمومی باشند؛ سرورهای Meta باید بتوانند آن‌ها را دانلود کنند (اگر عکس روی هاست ایرانی است و باز نمی‌شود، همان را موقتاً روی یک CDN خارجی بگذارید).
از کتابخانه‌های غیررسمی (لاگین با رمز، instagrapi) **عمداً استفاده نشده**: خلاف قوانین اینستاگرام است و حساب را در معرض مسدود شدن می‌گذارد.

## ۷) ایجنت‌های ایران کمپینگ و بارنی
فایل `agents.json` (نمونه: `agents.example.json`). سه پروتکل:
- `openai`: ایجنتی که `POST {baseUrl}/chat/completions` سازگار با OpenAI دارد.
- `http`: هر REST دلخواه با `requestTemplate` (جایگزین‌ها: `{{message}}` `{{conversation_id}}` `{{context}}` `{{user}}`) و `responsePath` (مثل `data.reply`).
- `mcp`: ایجنتی که خودش سرور MCP دارد؛ با `agent_mcp_list_tools` / `agent_mcp_call`.

توکن‌ها در فایل نیستند؛ `authEnv` نام متغیر محیطی را می‌دهد. برای ارتباط **از ایجنت به هاب** (گزارش، تحویل نتیجه، گرفتن کار صف‌شده):
```
POST /api/agents/events                 {"kind":"alert","payload":{...}}        Authorization: Bearer <AGENT_BUS_TOKEN_BARNEY>
GET  /api/agents/tasks                  کارهای صف‌شده با agent_handoff
POST /api/agents/tasks/:id/result       نتیجه‌ی کار
```
خروجی ایجنت‌ها «داده‌ی غیرقابل‌اعتماد» علامت می‌خورد تا مدل دستورهای داخل آن را اجرا نکند.

## ۸) به‌روزرسانی و پشتیبان
- `git pull && npm ci && npm run build && sudo systemctl restart iran-camping-hub`
- از پوشه‌ی `data/` (دیتابیس SQLite: کاربران، یادداشت‌ها، توکن‌های رمزگذاری‌شده) و فایل `.env` پشتیبان بگیرید. بدون `HUB_SECRET` توکن‌های اینستاگرام قابل بازیابی نیستند.
