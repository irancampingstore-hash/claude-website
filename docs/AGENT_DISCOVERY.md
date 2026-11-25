# کشف ایجنت‌ها و ساخت API Registry

**چرا این مرحله باید روی کامپیوتر rahim اجرا شود؟** مسیرهای `D:\ic-agents`، پورت‌های `127.0.0.1` و `claude mcp list` فقط روی همان ماشین وجود دارند. نشست ابری Claude Code به آن دسترسی ندارد (rahim پوشه‌ها را به نشست‌های ابری نمی‌دهد؛ معمولاً باید برنامه‌ی Claude روی ویندوز به‌روز شود).

## اجرا (فقط‌خواندنی، بدون نیاز به نصب چیزی جز Node ≥ 18)
فایل فعلاً فقط روی شاخه‌ی PR است (هنوز merge نشده)، پس همان شاخه را بگیرید:
```powershell
cd D:\
git clone -b ccr-84251afb-x7i9xi https://github.com/irancampingstore-hash/claude-website
cd claude-website
node tools\discover-agents.mjs --roots "D:\ic-agents;D:\IranCamping-Intelligence-Core;D:\xampp\htdocs\ic-agents;D:\xampp\htdocs\claude" --out .\registry
```
خروجی در `registry\`:
`AGENT_API_REGISTRY.json` · `AGENT_API_REGISTRY.md` · `AGENT_INTEGRATION_MATRIX.md` · `AGENT_CONNECTION_TEST_REPORT.md` · `discovery-details.json`

> خطاهای رایج: نام فایل `discover-agent**s**.mjs` است (با s)؛ دستور باید داخل پوشه‌ی `claude-website` اجرا شود؛ گزینه `--roots` است و مسیرها با `D:\` (با دونقطه) و جداکننده‌ی `;`.

## چه کاری می‌کند / نمی‌کند
- فقط درخواست **GET** به آدرس‌های محلی شناخته‌شده (Ollama 11434، LM Studio 1234، FCC 8082، Mobile Command 17843، Fleet 7422) و یک handshake ‏`initialize` برای MCP عمومی ForgeOps. هیچ ابزاری اجرا نمی‌شود.
- پوشه‌ها را تا عمق ۶ می‌گردد (بدون `node_modules`، `.git`، `venv`…) و `.mcp.json`، `agent_catalog.json`، `package.json`، `openapi.json`، compose و … را خلاصه می‌کند.
- **مقدار هیچ secret/token ثبت نمی‌شود**؛ فقط نام متغیرها و هدرها. رشته‌های شبیه توکن ماسک می‌شوند (تست خودکار دارد).
- فقط داخل `--out` می‌نویسد. فایل `state\PAUSED` را فقط چک می‌کند و دست نمی‌زند. به `/v1/mutate` یا هر endpoint نوشتنی درخواست نمی‌فرستد.
- وضعیت `VERIFIED` فقط با شاهد زنده؛ بقیه `UNKNOWN`/`PARTIAL`/`UNREACHABLE`. هیچ API فرضی ثبت نمی‌شود.

## بعد از اجرا
1. فایل‌های `registry\*.md` را (بدون نگرانی از secret) برای من بفرستید یا در PR بگذارید.
2. من بر اساس آن `agents.json` هاب را می‌نویسم: Ollama/LM Studio از قبل از طریق ایجنت PC در دسترس‌اند؛ ForgeOps/Rahim MCP با `protocol: mcp`؛ Mobile Command/Fleet با `protocol: http` (پس از دانستن نوع توکن).
3. محدودیت‌های شناخته‌شده: ForgeOps Operator با OAuth+PKCE است و کلاینت MCP هاب فعلاً فقط هدر ثابت می‌فرستد؛ برای آن باید یا توکن بلندمدت داده شود یا پشتیبانی OAuth-client اضافه شود (در صورت نیاز می‌سازم). Agent One / Barney تا وقتی قرارداد واقعی‌شان از رجیستری معلوم نشده، فقط از مسیر صف رویداد هاب (`agent_handoff`، با ACK و تأیید مستقل) استفاده می‌شوند، نه «اجرای مستقیم».

## اصل طراحی
هاب «دروازه‌ی کلاینت‌های AI» است، نه جایگزین زیرساخت شما. ایجنت‌ها همان runtime موجودشان را حفظ می‌کنند (ICIC / ForgeOps / Agent One)؛ هاب فقط با قرارداد فعلی صدایشان می‌زند و موازی‌سازی نمی‌کند. دسترسی خواندن/نوشتن تجاری (سفارش، قیمت، موجودی) همچنان با نقش‌ها و `confirm_token` جدا کنترل می‌شود.
