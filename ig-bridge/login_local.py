#!/usr/bin/env python3
"""Create an Instagram session file on YOUR OWN computer, then copy it to the server.

Why locally? Instagram trusts logins from your usual device and network. Logging in for the first time from a
data-center IP is the most common trigger for challenges and temporary locks.

Two ways (pick one):
  A) Session cookie (no password ever typed here — safest):
       1. Log in to instagram.com in your browser as the business account.
       2. DevTools → Application/Storage → Cookies → https://www.instagram.com → copy the value of "sessionid".
       python login_local.py --name irancamping --sessionid <value>
  B) Username + password (handles 2FA / challenge prompts in this terminal):
       python login_local.py --name irancamping --username <user>

Result: ./irancamping.json. Upload it:   scp irancamping.json server:/opt/iran-camping-hub/ig-bridge/data/sessions/
or POST it to the bridge (see README). Delete the local copy afterwards — the file is as sensitive as a password.
"""
import argparse
import getpass
import sys

from instagrapi import Client
from instagrapi.exceptions import TwoFactorRequired


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="short account name, e.g. irancamping")
    ap.add_argument("--sessionid")
    ap.add_argument("--username")
    ap.add_argument("--proxy", help="optional proxy URL if you normally reach Instagram through one")
    a = ap.parse_args()

    cl = Client()
    if a.proxy:
        cl.set_proxy(a.proxy)
    try:
        if a.sessionid:
            cl.login_by_sessionid(a.sessionid)
        elif a.username:
            pw = getpass.getpass("Password (not echoed): ")
            try:
                cl.login(a.username, pw)
            except TwoFactorRequired:
                cl.login(a.username, pw, verification_code=input("2FA code: ").strip())
        else:
            ap.error("give --sessionid or --username")
    except Exception as e:  # noqa: BLE001
        print(f"Login failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    out = f"{a.name}.json"
    cl.dump_settings(out)
    me = cl.account_info()
    print(f"OK — logged in as @{me.username}. Session saved to ./{out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
