# استقرار هاب (VPS میهن‌وب) + ایجنت PC + اینستاگرام

## ۱) کجا اجرا شود؟
هاب باید از اینترنت خارجی با **HTTPS** قابل دسترسی باشد، چون Claude/ChatGPT از سرورهای خودشان به آن وصل می‌شوند.

| گزینه | مزیت | عیب |
|---|---|---|
| **روی VPS میهن‌وب** (iranoutdoor.com) | کنار سایت؛ `VPS_MODE=local` بدون SSH؛ دسترسی سریع به irancamping.com | دسترسی به API اینستاگرام از IP ایران معمولاً مسدود است ← نیاز به `IG_PROXY_URL` یا آینه (بخش ۶)؛ و باید مطمئن شوید سرورهای Anthropic/OpenAI/Google به IP ایرانی می‌رسند |
| **سرور خارج از ایران** | اینستاگرام و ابزارهای AI بدون مشکل | برای کنترل VPS باید `VPS_MODE=ssh` و برای irancamping.com اتصال خارج→ایران برقرار باشد |

پیشنهاد: اگر تست اولیه نشان داد اینستاگرام از VPS ایرانی در دسترس نیست، هاب را روی یک سرور کوچک خارجی بگذارید و VPS میهن‌وب را با SSH (کلید + کاربر محدود) وصل کنید.

## ۲) نصب — مسیر سریع (پیشنهادی): بسته از روی PC شما، نصب‌کننده‌ی یک‌دستوری روی سرور
نیازی به GitHub روی سرور، npm روی سرور، یا ساخت DNS جدید نیست. نصب‌کننده خودش پیش‌آزمون اتصال می‌گیرد، Node را (در صورت نبود) با چک‌سام نصب می‌کند، `.env` را با رمزهای تصادفی می‌سازد، کاربر owner می‌سازد، سرویس systemd و سایت nginx را راه می‌اندازد و HTTPS می‌گیرد.

**روی PC (Windows/Mac/Linux، Node 22+):**
```powershell
cd D:\claude-website
node deploy\make-release.mjs                       # → release\iran-camping-hub-0.1.0.tar.gz  (+ node_modules داخلش)
```
**فقط آزمون اتصال سرور (چیزی تغییر نمی‌کند):**
```powershell
.\deploy\push-from-pc.ps1 -Server 89.32.251.143 -Port <پورت SSH> -User <کاربر> -Domain server1.iranoutdoor.com -PreflightOnly
```
**نصب کامل:**
```powershell
.\deploy\push-from-pc.ps1 -Server 89.32.251.143 -Port <پورت SSH> -User <کاربر> -Domain server1.iranoutdoor.com -Email you@example.com -VpsLocal -WithBridge
```
(اگر `-User` غیر root است، باید `sudo` بدون رمز داشته باشد.) یا دستی:
```bash
scp -P <پورت> release/iran-camping-hub-0.1.0.tar.gz <کاربر>@89.32.251.143:/tmp/
ssh -p <پورت> <کاربر>@89.32.251.143 'mkdir -p /tmp/ich && tar -xzf /tmp/iran-camping-hub-0.1.0.tar.gz -C /tmp/ich && sudo bash /tmp/ich/deploy/install.sh --domain server1.iranoutdoor.com --vps-local --with-bridge'
```
گزینه‌ها: `--tls none` (certbot نزن؛ TLS جلوتر از این سرور تمام می‌شود، ولی `HUB_PUBLIC_URL` همچنان `https://` است)، `--no-proxy` (nginx نساز؛ وب‌سرور/پنل موجود را خودتان به `127.0.0.1:8787` وصل کنید)، `--dry-run`، `--preflight-only`، `--dir`، `--port`.
اگر پورت 80 را وب‌سرور دیگری (پنل) گرفته باشد، نصب‌کننده به آن دست نمی‌زند و فایل `deploy/nginx.generated.conf` را برای reverse proxy می‌سازد.
اگر `nodejs.org` از سرور بسته است: `node deploy\make-release.mjs --node` (Node را داخل بسته می‌گذارد). اگر PyPI بسته است: `--wheels 3.12,3.13,3.14` (چرخ‌های لینوکس را برای پل اینستاگرام می‌گذارد).
خروجی: کلید owner (یک‌بار نمایش و در `/root/iran-camping-owner-key.txt` با سطح ۶۰۰)، آدرس MCP و مراحل بعد. اجرای دوباره‌ی نصب‌کننده امن است (`.env`، کاربران و داده‌ها حفظ می‌شوند).

**چه چیزی تست شده:** ساخت بسته، اجرای کامل نصب‌کننده روی یک اوبونتو (کاربر سرویس، `.env`، owner، idempotency، sudoers با `visudo`، فایل systemd با `systemd-analyze verify`، سایت nginx با `nginx -t`، بالا آمدن هاب با کاربر `mcphub` و فراخوانی MCP). **تست نشده:** اجرا روی Ubuntu 26.04 واقعی و روی سرور شما، issuance گواهی Let's Encrypt، نصب پل اینستاگرام (pip) و `push-from-pc.ps1` روی ویندوز.

## ۲-ب) نصب دستی (اگر نصب‌کننده را نمی‌خواهید)
 (Ubuntu؛ آزموده‌نشده روی 26.04 — نسخه‌ی خیلی جدید)
**دامنه:** اگر نمی‌توانید DNS جدید اضافه کنید، از همان دامنه‌ی سرور استفاده کنید (مثلاً `server1.iranoutdoor.com`، به شرط اینکه به IP سرور اشاره کند: `getent hosts server1.iranoutdoor.com`). در `.env`: `HUB_PUBLIC_URL=https://server1.iranoutdoor.com`، و در `deploy/nginx.conf` هم `server_name` همان باشد. اگر پنل مدیریت (DirectAdmin/Plesk/cPanel…) پورت‌های 80/443 را قبلاً گرفته، به‌جای nginx جدا، یک «reverse proxy» از همان وب‌سرور به `127.0.0.1:8787` بسازید (حتماً با پشتیبانی WebSocket برای مسیر `/agent/ws` و بدون بافر).

**Node 22 (باینری رسمی؛ مستقل از نسخه‌ی اوبونتو):**
```bash
cd /tmp && curl -fsSLO https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.xz
echo "cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8  node-v22.23.5-linux-x64.tar.xz" | sha256sum -c -
sudo tar -xJf node-v22.23.5-linux-x64.tar.xz -C /usr/local --strip-components=1 && node -v   # v22.23.5
sudo apt-get update && sudo apt-get install -y nginx git certbot python3-certbot-nginx python3-venv
```
(اگر `nodejs.org` یا `registry.npmjs.org` از سرور باز نشد، روی یک سیستم لینوکس x64 بیلد کنید: `npm ci && npm run build && npm ci --omit=dev` و پوشه‌ی پروژه را با `scp`/`rsync` ببرید.)

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin mcphub
sudo -u mcphub git clone -b ccr-84251afb-x7i9xi https://github.com/irancampingstore-hash/claude-website /opt/iran-camping-hub
cd /opt/iran-camping-hub
sudo -u mcphub npm ci && sudo -u mcphub npm run build
sudo -u mcphub cp .env.example .env && sudo -u mcphub cp agents.example.json agents.json && sudo chmod 600 .env
sudo -u mcphub node dist/cli.js secret     # مقدار را در HUB_SECRET بگذارید
sudo -u mcphub node dist/cli.js user add --name owner --role owner
sudo cp deploy/iran-camping-hub.service /etc/systemd/system/ && sudo systemctl enable --now iran-camping-hub
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mcp && sudo ln -s /etc/nginx/sites-available/mcp /etc/nginx/sites-enabled/
sudo certbot --nginx -d server1.iranoutdoor.com
sudo -u mcphub node dist/cli.js doctor
```
گواهی Let's Encrypt (روش HTTP-01) فقط وقتی کار می‌کند که پورت 80 از اینترنت به سرور برسد. اگر سرور پشت فیلتر/محدودیت ورودی است یا دامنه به IP دیگری اشاره می‌کند، صادر نمی‌شود.

### آزمون اتصال‌ها از روی خود VPS (قبل از هر نصبی)
```bash
# DNS: اگر IP برگشتی 10.10.34.x بود یعنی توسط فیلترینگ مسدود است
getent hosts www.instagram.com i.instagram.com graph.instagram.com
for u in https://www.instagram.com/ https://i.instagram.com/api/v1/ https://graph.instagram.com/ https://irancamping.com/ https://nodejs.org/ https://registry.npmjs.org/ https://github.com/; do
  printf "%-40s " "$u"; curl -sS -o /dev/null -w "%{http_code}  %{time_total}s\n" --max-time 15 "$u" 2>&1 | tail -1
done
ss -ltnp | grep -E ':(80|443|8787) '        # چه چیزی پورت‌ها را گرفته؟
```
تفسیر: کد HTTP (حتی 301/302/400/403) یعنی **رسیده‌ایم**؛ `000`، `timed out`، `Connection reset` یا `Could not resolve` یعنی مسدود است. پل `ig-bridge` به `i.instagram.com` نیاز دارد (API موبایل)، API رسمی به `graph.instagram.com`.
از بیرون هم باید بررسی شود که Claude/ChatGPT به هاب می‌رسند: بعد از نصب، `https://server1.iranoutdoor.com/healthz` را از یک شبکه‌ی خارج از ایران (مثلاً موبایل با VPN یا یک سایت «check host») باز کنید.

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
- `httpAllow`: فهرست آدرس‌هایی که هاب می‌تواند از طریق PC فقط با **GET** بخواند (مثلاً `["http://127.0.0.1:7422/fleet"]`)؛ سرویس‌هایی که فقط روی `127.0.0.1` همان PC گوش می‌دهند از VPS دیده نمی‌شوند و با ابزار `pc_http_get` در دسترس می‌شوند. بدون ارسال توکن و بدون دنبال‌کردن redirect.
- پیش‌فرض: هیچ پوشه‌ای باز نیست و اجرای دستور **خاموش** است. فقط وقتی لازم دارید `allowExec: true` کنید.
- مدل‌ها: Ollama را نصب و `ollama pull qwen2.5:7b` بزنید؛ `local_ai_models` آن را می‌بیند.

## ۶) اینستاگرام — دو راه، هر دو در همان ابزارهای `ig_*`

| | **پل متن‌باز (`ig-bridge`)** — بدون اپ Meta | **API رسمی Meta** |
|---|---|---|
| نیاز به اپ در developers.facebook.com | ❌ ندارد | ✅ دارد |
| نحوه‌ی ورود | کوکی `sessionid` یا نام‌کاربری/رمز، یک‌بار روی PC خودتان | OAuth با خود اینستاگرام |
| امکانات | پست/ریل/استوری/کاروسل، کامنت، دایرکت، آمار، حذف کامنت | همان + مخفی‌کردن کامنت، وب‌هوک زنده، سهمیه‌ی رسمی |
| ریسک | **خلاف قوانین اینستاگرام** (API خصوصی موبایل)؛ احتمال چک‌پوینت/محدودیت/بن حساب | رسمی و بدون ریسک بن |
| صندوق کامنت/دایرکت | polling هر ۱۰ دقیقه | وب‌هوک |

### راه A — پل بدون اپ Meta (`ig-bridge/`)
راه‌اندازی کامل در [`ig-bridge/README.md`](../ig-bridge/README.md). خلاصه:
1. روی سرور: پل را نصب و اجرا کنید (فقط `127.0.0.1`)، `IG_BRIDGE_URL` و `IG_BRIDGE_TOKEN` را در `.env` هاب بگذارید.
2. روی **PC خودتان**: `python login_local.py --name irancamping --sessionid …` (یا با نام‌کاربری/رمز)، فایل `irancamping.json` ساخته می‌شود.
3. `node dist/cli.js ig import --bridge-account irancamping --file irancamping.json` و بعد فایل را از PC پاک کنید.
4. در چت (با کاربر owner): `ig_link_bridge_account` با `label=irancamping` و `bridge_account=irancamping`.
رمز و کوکی را **هرگز در چت ندهید**؛ فقط از مسیر بالا.

### راه B — API رسمی (اگر کسی دسترسی به اپ Meta دارد)
Use case: *Instagram* → *API setup with Instagram login*. `IG_APP_ID`/`IG_APP_SECRET` را بگیرید، Redirect URI را `https://mcp.iranoutdoor.com/instagram/callback` بگذارید، حساب را Business/Creator و Instagram Tester کنید، و `ig_connect_start` را بزنید. اگر اپ را **شخص دیگری** بسازد، شما فقط ID و Secret را از او می‌گیرید و ورود اینستاگرام را خودتان انجام می‌دهید. وب‌هوک: `https://mcp.iranoutdoor.com/instagram/webhook` + `ig_subscribe_webhooks`. اگر سرور شما به Meta دسترسی ندارد: `IG_PROXY_URL` یا `IG_GRAPH_BASE`.
عکس‌های راه B باید **JPEG** و روی URL عمومی باشند (راه A این محدودیت را ندارد).

## ۷) ایجنت‌های ایران کمپینگ و بارنی
فایل `agents.json` (نمونه: `agents.example.json`). سه پروتکل:
- `openai`: ایجنتی که `POST {baseUrl}/chat/completions` سازگار با OpenAI دارد.
- `http`: هر REST دلخواه با `requestTemplate` (جایگزین‌ها: `{{message}}` `{{conversation_id}}` `{{context}}` `{{user}}`) و `responsePath` (مثل `data.reply`).
- `mcp`: ایجنتی که خودش سرور MCP دارد؛ با `agent_mcp_list_tools` / `agent_mcp_call`.
- `queue`: ایجنتی بدون endpoint مستقیم (Agent One، نقش‌های Barney)؛ فقط `agent_handoff` و گذرگاه رویداد. ثبت کار در صف به‌معنی اجرا نیست.

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
