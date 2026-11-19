#!/usr/bin/env python3
"""
Sync local agent receipts -> Todoist status tasks.

Run on YOUR computer every 4 hours (see README.md). Read-only for agents:
this script never starts, stops or commands an agent. It only rewrites the
status block of the 8 status tasks in Todoist.

Inputs
  receipts.json  (local file written by your agents / dashboard), format:
  {
    "Agent OS Supervisor": {"status": "RUNNING", "last_receipt": "2026-11-19T12:00:00+03:30"},
    "Vini": {"status": "PAUSED", "last_receipt": "2026-11-19T08:00:00+03:30"}
  }
  Allowed status: RUNNING, PAUSED, UNKNOWN, BLOCKED.
  Any agent missing from the file, or whose receipt is older than STALE_HOURS,
  is written as UNKNOWN.

Env
  TODOIST_TOKEN   your Todoist API token (set it in the environment, never in code)
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.todoist.com/api/v1/tasks/{id}"  # verify against Todoist docs if it changes
STALE_HOURS = 6
ALLOWED = {"RUNNING", "PAUSED", "UNKNOWN", "BLOCKED"}

# agent name -> Todoist task id (from the status tasks created in project "پروژه‌ها و هوش مصنوعی")
TASKS = {
    "Agent OS Supervisor": "6j3W2rQCVqhrp8w2",
    "Agent One": "6j3W2rQChHF7jcMR",
    "Vini": "6j3W2rV2HRHx3W6R",
    "Bridge": "6j3W2rVH7fXWmh7R",
    "Dashboard": "6j3W2rRCqCXHC4V2",
    "Barney": "6j3W2rX7rXQRqggR",
    "Instagram Intelligence": "6j3W2rQG3H7r6Pw8",
    "KalaPark Import": "6j3W2rMgRwmCvJq8",
}


def load_receipts(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def build_description(name, status, last_receipt, now):
    if last_receipt:
        ts = datetime.fromisoformat(last_receipt)
        if now - ts > timedelta(hours=STALE_HOURS):
            status = "UNKNOWN"
    else:
        last_receipt = "-"
    return (
        f"**وضعیت:** {status}\n"
        f"**آخرین رسید:** {last_receipt}\n"
        f"**آخرین بروزرسانی:** {now.astimezone().strftime('%Y-%m-%d %H:%M')}\n"
        f"**مالک:** {name}\n\n"
        "فقط رصد. هیچ فرمانی از اینجا اجرا نمی‌شود."
    )


def update_task(token, task_id, description):
    body = json.dumps({"description": description}).encode("utf-8")
    req = urllib.request.Request(
        API.format(id=task_id),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status


def main():
    token = os.environ.get("TODOIST_TOKEN")
    if not token:
        sys.exit("TODOIST_TOKEN is not set")
    receipts_path = os.environ.get(
        "RECEIPTS_PATH", os.path.join(os.path.dirname(__file__), "receipts.json")
    )
    receipts = load_receipts(receipts_path)
    now = datetime.now(timezone.utc)

    failed = 0
    for name, task_id in TASKS.items():
        r = receipts.get(name, {})
        status = str(r.get("status", "UNKNOWN")).upper()
        if status not in ALLOWED:
            status = "UNKNOWN"
        desc = build_description(name, status, r.get("last_receipt"), now)
        try:
            update_task(token, task_id, desc)
            print(f"OK   {name}: {status}")
        except Exception as exc:  # keep going; report at the end
            failed += 1
            print(f"FAIL {name}: {exc}", file=sys.stderr)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
