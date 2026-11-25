# اتصال Claude، ChatGPT و Gemini به هاب

آدرس MCP هاب: `https://mcp.iranoutdoor.com/mcp` (آدرس واقعی خودتان را بگذارید). **HTTPS الزامی است.**
هر کارمند یک **کلید دسترسی** دارد (`icm_...`) که مدیر با `node dist/cli.js user add` می‌سازد.

دو روش احراز هویت داریم و هر دو روی همان `/mcp` کار می‌کنند:

| روش | کجا استفاده می‌شود |
|---|---|
| **OAuth** (صفحه‌ی ورود با کلید دسترسی) | Claude.ai، Claude Desktop (Connectors)، ChatGPT |
| **هدر `Authorization: Bearer icm_...`** | Claude Code، Gemini CLI، Gemini API/SDK، اسکریپت‌ها |

> مسیر دقیق منوها در اپ‌ها گاهی عوض می‌شود؛ نام‌ها زیر به‌روزترین حالتی است که می‌شناسم.

## Claude (claude.ai و Claude Desktop)
1. Settings → **Connectors** → *Add custom connector*.
2. آدرس: `https://mcp.iranoutdoor.com/mcp`. (نیاز به پلن‌هایی دارد که اتصال سفارشی را پشتیبانی می‌کنند؛ در پلن‌های تیمی معمولاً مدیر سازمان اضافه می‌کند.)
3. بعد از «Connect» صفحه‌ی ورود هاب باز می‌شود → کلید دسترسی شخصی را وارد کنید → تأیید.
4. ابزارهای پرخطر (نوشتن) را روی «Ask before use / Needs approval» نگه دارید.

### Claude Code
```bash
claude mcp add --transport http iran-camping https://mcp.iranoutdoor.com/mcp \
  --header "Authorization: Bearer icm_YOUR_KEY"
```

### Claude Desktop روی همان کامپیوتری که هاب نصب است (stdio، بدون HTTPS)
`claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "iran-camping": {
      "command": "node",
      "args": ["/path/to/claude-website/dist/server.js", "--stdio"],
      "env": { "HUB_SECRET": "…", "HUB_DATA_DIR": "/path/to/data", "HUB_STDIO_USER": "owner",
               "WP_URL": "https://irancamping.com", "…": "بقیه‌ی متغیرهای .env" }
    }
  }
}
```

## ChatGPT
1. Settings → **Connectors** → Advanced → فعال‌کردن **Developer mode** (در پلن‌هایی که اجازه می‌دهند؛ در Business/Enterprise ادمین باید مجاز کند).
2. *Create* / *Add connector* → نوع **MCP server**، آدرس `https://mcp.iranoutdoor.com/mcp`، احراز هویت **OAuth**.
3. وارد صفحه‌ی ورود هاب شوید و کلید شخصی را بدهید.
4. در هر گفتگو، کانکتور را از منوی ابزارها فعال کنید. هاب ابزارهای `search` و `fetch` را هم با قالب مورد انتظار ChatGPT دارد (جست‌وجوی یادداشت‌ها، نوشته‌ها و محصولات).

## Gemini
**Gemini CLI** — `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "iran-camping": {
      "httpUrl": "https://mcp.iranoutdoor.com/mcp",
      "headers": { "Authorization": "Bearer icm_YOUR_KEY" },
      "timeout": 60000
    }
  }
}
```
**Gemini API (SDK)**: یک MCP client با `StreamableHTTPClientTransport` و همان هدر بسازید و session را به SDK بدهید (راهنمای MCP در مستندات Google GenAI).
اسکیمای همه‌ی ابزارها عمداً ساده است (بدون union/`$ref`/آبجکت آزاد) تا Gemini هم مشکلی نداشته باشد؛ این در تست‌ها بررسی می‌شود.

## استفاده‌ی روزانه
- اولین پیام: «`hub_overview` را بزن» → می‌بینید چه چیزهایی وصل و سالم است و شما به چه دسترسی دارید.
- «گزارش روزانه بده» → `workflow_daily_digest`.
- «محصول ۱۲۳ را در اینستاگرام بگذار» → `workflow_product_to_instagram` (پیش‌نمایش کپشن، بعد تأیید شما).
- «از مدل لوکال بخواه این ۲۰ توضیح محصول را خلاصه کند» → `local_ai_chat` (روی PC شما، رایگان).
- یادداشت مشترک: «این لحن برند ماست، ذخیره کن» → `hub_note_save`؛ همه‌ی کارمندان و همه‌ی مدل‌ها همان را می‌خوانند.

## عیب‌یابی
| علامت | علت |
|---|---|
| Claude/ChatGPT می‌گوید connector قابل اتصال نیست | آدرس HTTPS معتبر نیست، یا سرور از اینترنت خارجی در دسترس نیست (فایروال/فیلتر)، یا `HUB_PUBLIC_URL` با آدرس واقعی یکی نیست |
| 421 Misdirected | هدر Host با `HUB_PUBLIC_URL` نمی‌خواند (nginx باید `proxy_set_header Host $host` بدهد) |
| `Permission denied` | نقش کاربر آن ابزار را ندارد: `node dist/cli.js tools --user NAME` |
| `PC agent is offline` | کامپیوتر خاموش است یا ایجنت اجرا نیست |
| خطای 190 اینستاگرام | توکن منقضی؛ دوباره `ig_connect_start` |
