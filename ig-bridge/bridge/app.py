"""HTTP API in front of instagrapi. Bind it to 127.0.0.1 and give the hub the bearer token."""
from __future__ import annotations

import hmac
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import netguard
from .accounts import AccountManager, SessionMissing
from .pacing import CapReached, Pacer


def _iso(dt) -> str | None:
    if not dt:
        return None
    if isinstance(dt, datetime):
        return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()
    return str(dt)


def media_dict(m) -> dict:
    code = getattr(m, "code", None)
    return {
        "pk": str(m.pk),
        "code": code,
        "permalink": f"https://www.instagram.com/p/{code}/" if code else None,
        "media_type": getattr(m, "media_type", None),
        "product_type": getattr(m, "product_type", None),
        "caption": getattr(m, "caption_text", "") or "",
        "taken_at": _iso(getattr(m, "taken_at", None)),
        "like_count": getattr(m, "like_count", None),
        "comment_count": getattr(m, "comment_count", None),
        "play_count": getattr(m, "play_count", None),
        "thumbnail_url": str(m.thumbnail_url) if getattr(m, "thumbnail_url", None) else None,
    }


def comment_dict(c) -> dict:
    return {
        "pk": str(c.pk),
        "text": c.text,
        "username": getattr(c.user, "username", None),
        "user_pk": str(getattr(c.user, "pk", "")) or None,
        "created_at": _iso(getattr(c, "created_at_utc", None)),
        "like_count": getattr(c, "like_count", 0),
        "replied_to": str(c.replied_to_comment_id) if getattr(c, "replied_to_comment_id", None) else None,
    }


def message_dict(m) -> dict:
    return {
        "id": str(m.id),
        "user_id": str(m.user_id) if m.user_id is not None else None,
        "from_me": bool(getattr(m, "is_sent_by_viewer", False)),
        "text": getattr(m, "text", None),
        "type": getattr(m, "item_type", None),
        "timestamp": _iso(getattr(m, "timestamp", None)),
    }


def thread_dict(t) -> dict:
    return {
        "id": str(t.id or t.pk),
        "pk": str(t.pk),
        "users": [{"pk": str(u.pk), "username": u.username} for u in (t.users or [])],
        "last_activity_at": _iso(getattr(t, "last_activity_at", None)),
        "unread": getattr(t, "read_state", 0) not in (0, None),
        "messages": [message_dict(m) for m in (t.messages or [])[:5]],
    }


class SessionImport(BaseModel):
    settings: dict


class SessionIdLogin(BaseModel):
    sessionid: str = Field(min_length=10)


class ReplyBody(BaseModel):
    media_pk: str
    text: str = Field(min_length=1, max_length=2200)
    comment_pk: str | None = None


class DeleteBody(BaseModel):
    media_pk: str
    comment_pks: list[str] = Field(min_length=1, max_length=50)


class DmBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    thread_id: str | None = None
    user_id: str | None = None


class PublishBody(BaseModel):
    kind: str  # photo | reel | story | carousel
    urls: list[str] = Field(min_length=1, max_length=10)
    caption: str = Field(default="", max_length=2200)


def create_app(
    manager: AccountManager,
    pacer: Pacer,
    token: str,
    downloader: Callable[[str, int], Path] | None = None,
) -> FastAPI:
    if len(token) < 24:
        raise ValueError("IG_BRIDGE_TOKEN must be at least 24 characters")
    app = FastAPI(title="Iran Camping Instagram bridge", docs_url=None, redoc_url=None, openapi_url=None)
    dl = downloader or (lambda url, limit: netguard.download(url, limit, allow_private=os.environ.get("IG_BRIDGE_ALLOW_PRIVATE_URLS") == "1"))

    def auth(authorization: str = Header(default="")) -> None:
        given = authorization[7:] if authorization.lower().startswith("bearer ") else ""
        if not given or not hmac.compare_digest(given.encode(), token.encode()):
            raise HTTPException(401, "invalid bridge token")

    def err(status: int, code: str, message: str) -> JSONResponse:
        return JSONResponse(status_code=status, content={"error": code, "message": message})

    def run(name: str, fn: Callable[[object], object], write_kind: str | None = None):
        """Execute `fn(client)` under the account lock, with pacing for writes and error mapping."""
        from instagrapi import exceptions as ex

        try:
            acc = manager.get(name)
        except SessionMissing as e:
            return err(404, "no_session", str(e))
        except ValueError as e:
            return err(400, "bad_name", str(e))
        try:
            if write_kind:
                pacer.before_write(write_kind)
            with acc.lock:
                result = fn(acc.client)
                manager.save(name)
            return result
        except CapReached as e:
            return err(429, "cap_reached", str(e))
        except netguard.UnsafeUrl as e:
            return err(400, "unsafe_url", str(e))
        except (ex.LoginRequired, ex.ChallengeRequired, ex.ClientLoginRequired, ex.BadPassword, ex.ReloginAttemptExceeded) as e:
            return err(409, "session_expired", f"Instagram asked to log in again ({type(e).__name__}). Re-import the session. Never approve it from a different network at the same time.")
        except (ex.PleaseWaitFewMinutes, ex.RateLimitError, ex.ClientThrottledError, ex.FeedbackRequired) as e:
            return err(429, "instagram_throttled", f"Instagram throttled the account ({type(e).__name__}). Stop for several hours and lower the pace.")
        except (ex.AccountSuspended, ex.SentryBlock) as e:
            return err(423, "account_blocked", f"Instagram restricted the account ({type(e).__name__}). Resolve it in the Instagram app.")
        except ex.ClientError as e:
            return err(502, "instagram_error", f"{type(e).__name__}: {str(e)[:300]}")

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/accounts", dependencies=[Depends(auth)])
    def accounts():
        return {"accounts": manager.names(), "pacing": pacer.status()}

    @app.post("/accounts/{name}/session", dependencies=[Depends(auth)])
    def import_session(name: str, body: SessionImport):
        try:
            manager.import_settings(name, body.settings)
        except ValueError as e:
            return err(400, "bad_session", str(e))
        return {"ok": True, "name": name}

    @app.post("/accounts/{name}/login-sessionid", dependencies=[Depends(auth)])
    def login_sessionid(name: str, body: SessionIdLogin):
        try:
            manager.login_sessionid(name, body.sessionid)
        except ValueError as e:
            return err(400, "bad_name", str(e))
        except Exception as e:  # library raises many types here
            return err(401, "login_failed", f"{type(e).__name__}: {str(e)[:200]}")
        return {"ok": True, "name": name}

    @app.delete("/accounts/{name}", dependencies=[Depends(auth)])
    def delete_account(name: str):
        manager.remove(name)
        return {"ok": True}

    @app.get("/accounts/{name}/me", dependencies=[Depends(auth)])
    def me(name: str):
        def go(cl):
            a = cl.account_info()
            u = cl.user_info(str(a.pk), use_cache=False)
            return {
                "pk": str(a.pk), "username": a.username, "full_name": a.full_name, "biography": a.biography,
                "is_business": a.is_business, "followers_count": u.follower_count, "follows_count": u.following_count,
                "media_count": u.media_count, "account_type": getattr(u, "account_type", None),
            }
        return run(name, go)

    @app.get("/accounts/{name}/media", dependencies=[Depends(auth)])
    def list_media(name: str, limit: int = 12):
        return run(name, lambda cl: {"items": [media_dict(m) for m in cl.user_medias(str(cl.user_id), amount=max(1, min(limit, 50)))]})

    @app.get("/accounts/{name}/media/{pk}/insights", dependencies=[Depends(auth)])
    def media_insights(name: str, pk: str):
        return run(name, lambda cl: {"insights": cl.insights_media(int(pk))})

    @app.get("/accounts/{name}/insights", dependencies=[Depends(auth)])
    def account_insights(name: str):
        return run(name, lambda cl: {"insights": cl.insights_account()})

    @app.get("/accounts/{name}/media/{pk}/comments", dependencies=[Depends(auth)])
    def comments(name: str, pk: str, limit: int = 25):
        return run(name, lambda cl: {"items": [comment_dict(c) for c in cl.media_comments(pk, amount=max(1, min(limit, 100)))]})

    @app.post("/accounts/{name}/comments/reply", dependencies=[Depends(auth)])
    def reply(name: str, body: ReplyBody):
        def go(cl):
            c = cl.media_comment(body.media_pk, body.text, replied_to_comment_id=int(body.comment_pk) if body.comment_pk else None)
            return comment_dict(c)
        return run(name, go, write_kind="comment")

    @app.post("/accounts/{name}/comments/delete", dependencies=[Depends(auth)])
    def delete_comments(name: str, body: DeleteBody):
        return run(name, lambda cl: {"deleted": bool(cl.comment_bulk_delete(body.media_pk, [int(p) for p in body.comment_pks]))}, write_kind="delete")

    @app.get("/accounts/{name}/direct/threads", dependencies=[Depends(auth)])
    def threads(name: str, limit: int = 10, unread_only: bool = False):
        return run(name, lambda cl: {"items": [thread_dict(t) for t in cl.direct_threads(amount=max(1, min(limit, 30)), selected_filter="unread" if unread_only else None)]})

    @app.get("/accounts/{name}/direct/threads/{thread_id}/messages", dependencies=[Depends(auth)])
    def thread_messages(name: str, thread_id: str, limit: int = 15):
        return run(name, lambda cl: {"items": [message_dict(m) for m in cl.direct_messages(int(thread_id), amount=max(1, min(limit, 50)))]})

    @app.post("/accounts/{name}/direct/send", dependencies=[Depends(auth)])
    def send_dm(name: str, body: DmBody):
        if bool(body.thread_id) == bool(body.user_id):
            return err(400, "bad_request", "Provide exactly one of thread_id or user_id")
        def go(cl):
            if body.thread_id:
                m = cl.direct_answer(int(body.thread_id), body.text)
            else:
                m = cl.direct_send(body.text, user_ids=[int(body.user_id)])
            return message_dict(m)
        return run(name, go, write_kind="dm")

    @app.post("/accounts/{name}/publish", dependencies=[Depends(auth)])
    def publish(name: str, body: PublishBody):
        kind = body.kind
        if kind not in ("photo", "reel", "story", "carousel"):
            return err(400, "bad_request", "kind must be photo, reel, story or carousel")
        if kind != "carousel" and len(body.urls) != 1:
            return err(400, "bad_request", f"{kind} needs exactly one url")
        if kind == "carousel" and len(body.urls) < 2:
            return err(400, "bad_request", "carousel needs 2-10 urls")

        def go(cl):
            files: list[Path] = []
            try:
                for u in body.urls:
                    limit = netguard.MAX_VIDEO if (kind == "reel" or u.lower().split("?")[0].endswith((".mp4", ".mov"))) else netguard.MAX_PHOTO
                    files.append(dl(u, limit))
                is_video = lambda p: p.suffix.lower() in (".mp4", ".mov")  # noqa: E731
                if kind == "photo":
                    m = cl.photo_upload(files[0], body.caption)
                    return media_dict(m)
                if kind == "reel":
                    return media_dict(cl.clip_upload(files[0], body.caption))
                if kind == "carousel":
                    return media_dict(cl.album_upload(files, body.caption))
                s = cl.video_upload_to_story(files[0]) if is_video(files[0]) else cl.photo_upload_to_story(files[0])
                return {"pk": str(s.pk), "code": getattr(s, "code", None), "permalink": None, "media_type": "story"}
            finally:
                for f in files:
                    f.unlink(missing_ok=True)

        return run(name, go, write_kind="publish")

    @app.get("/pacing", dependencies=[Depends(auth)])
    def pacing():
        return pacer.status()

    @app.exception_handler(Exception)
    async def unhandled(_req: Request, exc: Exception):  # never leak internals
        return err(500, "internal_error", type(exc).__name__)

    return app


def build_from_env() -> FastAPI:
    token = os.environ.get("IG_BRIDGE_TOKEN") or ""
    if not token:
        raise SystemExit("IG_BRIDGE_TOKEN is required (generate one: python -c \"import secrets;print(secrets.token_urlsafe(32))\")")
    data = Path(os.environ.get("IG_BRIDGE_DATA", "./data")).resolve()
    data.mkdir(parents=True, exist_ok=True)
    caps = {k: int(os.environ[f"IG_CAP_{k.upper()}"]) for k in ("publish", "comment", "dm", "delete") if f"IG_CAP_{k.upper()}" in os.environ}
    pacer = Pacer(
        state_file=data / "pacing.json",
        caps=caps,
        min_gap=float(os.environ.get("IG_MIN_GAP_SECONDS", 8)),
        max_gap=float(os.environ.get("IG_MAX_GAP_SECONDS", 25)),
    )
    manager = AccountManager(data / "sessions", proxy=os.environ.get("IG_PROXY") or None)
    return create_app(manager, pacer, token)


def generate_token() -> str:
    return secrets.token_urlsafe(32)
