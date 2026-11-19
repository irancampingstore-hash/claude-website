# همگام‌سازی وضعیت ایجنت‌ها با Todoist (هر ۴ ساعت)

این اسکریپت روی **کامپیوتر شما** اجرا می‌شود (نه در کانتینر ابری)، چون ایجنت‌ها آنجا هستند.

## ۱. توکن Todoist
Todoist → Settings → Integrations → Developer → API token را کپی کنید.
آن را **در کد یا چت قرار ندهید**؛ فقط در محیط سیستم ذخیره کنید:

```bash
export TODOIST_TOKEN="توکن_شما"          # Linux/macOS (در ~/.bashrc یا ~/.zshrc)
```

## ۲. فایل رسید‌ها
ایجنت‌ها یا داشبورد محلی باید فایل `receipts.json` را بنویسند (مسیر پیش‌فرض کنار اسکریپت):

```json
{
  "Agent OS Supervisor": {"status": "RUNNING", "last_receipt": "2026-11-19T12:00:00+03:30"},
  "Vini": {"status": "PAUSED", "last_receipt": "2026-11-19T08:00:00+03:30"}
}
```

وضعیت‌های مجاز: `RUNNING`، `PAUSED`، `UNKNOWN`، `BLOCKED`.
اگر رسیدی نباشد یا از ۶ ساعت قدیمی‌تر باشد، اسکریپت وضعیت را `UNKNOWN` می‌نویسد.

## ۳. اجرای دستی برای تست
```bash
cd todoist-agent-sync
python3 sync_agent_status.py
```
خروجی `OK` برای هر ایجنت یعنی کار در Todoist به‌روز شده است.

## ۴. زمان‌بندی هر ۴ ساعت
- **Linux/macOS (cron):** `crontab -e` و اضافه کنید:
  ```
  0 */4 * * * cd /path/to/todoist-agent-sync && /usr/bin/python3 sync_agent_status.py >> sync.log 2>&1
  ```
  (متغیر `TODOIST_TOKEN` باید برای cron هم در دسترس باشد؛ ساده‌ترین راه تعریف آن در همان خط cron است: `TODOIST_TOKEN=... cd ...`)
- **Windows:** Task Scheduler → Create Task → Trigger: Daily، Repeat every 4 hours → Action: `python sync_agent_status.py` با Environment متغیر `TODOIST_TOKEN`.

## نکات
- شناسه‌های کارها داخل `TASKS` ثبت شده‌اند. اگر کاری را پاک کردید، شناسه جدید را اینجا بگذارید.
- API Todoist ممکن است تغییر کند؛ اگر خطای ۴۰۴ یا ۴۱۰ دیدید، آدرس `API` را با مستندات فعلی Todoist مقایسه کنید.
- Todoist فقط نمایش است؛ هیچ اجرای فرمان یا توقف ایجنت از این مسیر انجام نمی‌شود.
