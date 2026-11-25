# ig-bridge — پل اینستاگرام بدون اپ Meta

یک سرویس کوچک Python (FastAPI + [instagrapi](https://github.com/subzeroid/instagrapi)، متن‌باز و MIT) که هاب برای حساب‌های اینستاگرامی که به API رسمی Meta دسترسی ندارند، از آن استفاده می‌کند. هاب همان ابزارهای `ig_*` را روی آن اجرا می‌کند.

> ⚠️ **ریسک**: این پل از API خصوصی اپ موبایل استفاده می‌کند و خلاف شرایط استفاده‌ی اینستاگرام است. ممکن است حساب چک‌پوینت، محدود یا بن شود و با هر تغییر اینستاگرام کار نکند. کد صادقانه این‌ها را کم نمی‌کند، فقط ریسک را با سرعت‌دهی انسانی کاهش می‌دهد. این کد روی اینستاگرام واقعی تست **نشده** (بدون حساب)؛ با کلاینت جعلی و با هاب تست شده است.

## نصب (روی همان سرور هاب)
```bash
cd /opt/iran-camping-hub/ig-bridge
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export IG_BRIDGE_TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(32))")   # همین را در .env هاب هم بگذارید
IG_BRIDGE_DATA=./data .venv/bin/python -m bridge          # گوش می‌دهد روی 127.0.0.1:8791
```
برای اجرای دائم: `deploy/ig-bridge.service` (systemd). هاب: `IG_BRIDGE_URL=http://127.0.0.1:8791` و `IG_BRIDGE_TOKEN=…`.

## گرفتن session (روی PC خودتان، نه سرور)
```bash
pip install instagrapi
python login_local.py --name irancamping --sessionid <کوکی sessionid از مرورگر>      # امن‌تر: رمز را تایپ نمی‌کنید
# یا
python login_local.py --name irancamping --username <user>                           # رمز و کد ۲FA را همان‌جا می‌پرسد
```
سپس `irancamping.json` را به هاب بدهید و از PC پاک کنید:
```bash
node dist/cli.js ig import --bridge-account irancamping --file irancamping.json
```
در چت با کاربر owner: `ig_link_bridge_account` (`label=irancamping`, `bridge_account=irancamping`). **رمز یا کوکی را در چت نفرستید.**

## سرعت‌دهی و سقف‌ها
فاصله‌ی تصادفی بین عمل‌های نوشتنی: `IG_MIN_GAP_SECONDS=8` تا `IG_MAX_GAP_SECONDS=25`. سقف روزانه (پیش‌فرض): `IG_CAP_PUBLISH=20`، `IG_CAP_COMMENT=60`، `IG_CAP_DM=60`، `IG_CAP_DELETE=60`. مقدار `0` یعنی نامحدود و فاصله‌ی `0` یعنی بدون تأخیر؛ این کار را با پذیرش ریسک بن انجام دهید. وضعیت: ابزار `ig_publishing_limit` یا `GET /pacing`.

## API (برای دیباگ؛ همه با `Authorization: Bearer $IG_BRIDGE_TOKEN`)
`GET /accounts` · `GET /accounts/{n}/me` · `/media` · `/media/{pk}/comments` · `/media/{pk}/insights` · `/insights` · `POST /comments/reply` · `/comments/delete` · `GET /direct/threads` · `POST /direct/send` · `POST /publish {kind: photo|reel|story|carousel, urls[], caption}` · `GET /pacing`

## خطاهای رایج
| پیام | معنی و اقدام |
|---|---|
| `session_expired` (409) | اینستاگرام لاگین دوباره خواست. session را از PC دوباره بسازید و import کنید. هم‌زمان از جای دیگر تأیید نکنید |
| `instagram_throttled` (429) | اینستاگرام حساب را کند کرد. چند ساعت همه‌چیز را متوقف و سرعت را کم کنید |
| `account_blocked` (423) | حساب محدود شده؛ در اپ اینستاگرام رفع کنید |
| `cap_reached` (429) | سقف روزانه‌ی پل؛ فردا یا با تغییر `IG_CAP_*` |
| `unsafe_url` (400) | آدرس رسانه عمومی نیست (localhost/شبکه‌ی داخلی ممنوع) |

## تست
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```
