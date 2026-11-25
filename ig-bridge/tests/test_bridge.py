import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from bridge.accounts import AccountManager
from bridge.app import create_app
from bridge.netguard import UnsafeUrl, assert_public
from bridge.pacing import CapReached, Pacer

TOKEN = "t" * 32
H = {"Authorization": f"Bearer {TOKEN}"}


class FakeClient:
    user_id = 99
    delay_range = None

    def __init__(self):
        self.calls = []
        self.fail_with = None

    def set_proxy(self, dsn): self.proxy = dsn
    def load_settings(self, path): self.settings = json.loads(Path(path).read_text())
    def dump_settings(self, path): Path(path).write_text(json.dumps({"authorization_data": {"ds_user_id": "99"}}))
    def _maybe_fail(self):
        if self.fail_with:
            raise self.fail_with
    def account_info(self):
        self._maybe_fail()
        return NS(pk=99, username="irancamping", full_name="Iran Camping", biography="bio", is_business=True)
    def user_info(self, pk, use_cache=True): return NS(follower_count=1234, following_count=10, media_count=7, account_type=2)
    def user_medias(self, pk, amount=0): return [NS(pk=1, code="AbC", media_type=1, product_type="feed", caption_text="سلام", taken_at=datetime(2026, 1, 1, tzinfo=timezone.utc), like_count=5, comment_count=2, play_count=None, thumbnail_url="https://x/t.jpg")]
    def media_comments(self, media_id, amount=20): return [NS(pk=11, text="قیمت؟", user=NS(username="ali", pk=5), created_at_utc=datetime(2026, 1, 2), like_count=0, replied_to_comment_id=None)]
    def media_comment(self, media_id, text, replied_to_comment_id=None):
        self.calls.append(("comment", media_id, text, replied_to_comment_id))
        return NS(pk=12, text=text, user=NS(username="irancamping", pk=99), created_at_utc=datetime(2026, 1, 2), like_count=0, replied_to_comment_id=replied_to_comment_id)
    def comment_bulk_delete(self, media_id, pks): self.calls.append(("delete", media_id, pks)); return True
    def direct_threads(self, amount=20, selected_filter=None):
        self.calls.append(("threads", selected_filter))
        return [NS(id="t1", pk="t1", users=[NS(pk=5, username="ali")], last_activity_at=datetime(2026, 1, 3), read_state=1, messages=[NS(id="m1", user_id=5, is_sent_by_viewer=False, text="سلام", item_type="text", timestamp=datetime(2026, 1, 3))])]
    def direct_messages(self, thread_id, amount=20): return []
    def direct_answer(self, thread_id, text): self.calls.append(("answer", thread_id, text)); return NS(id="m2", user_id=99, is_sent_by_viewer=True, text=text, item_type="text", timestamp=datetime(2026, 1, 3))
    def direct_send(self, text, user_ids=()): self.calls.append(("send", user_ids, text)); return NS(id="m3", user_id=99, is_sent_by_viewer=True, text=text, item_type="text", timestamp=datetime(2026, 1, 3))
    def photo_upload(self, path, caption): self.calls.append(("photo", Path(path).name, caption)); return NS(pk=77, code="NEW", media_type=1, product_type="feed", caption_text=caption, taken_at=None, like_count=0, comment_count=0, play_count=None, thumbnail_url=None)
    def album_upload(self, paths, caption): self.calls.append(("album", len(paths), caption)); return NS(pk=78, code="ALB", media_type=8, product_type="album", caption_text=caption, taken_at=None, like_count=0, comment_count=0, play_count=None, thumbnail_url=None)
    def clip_upload(self, path, caption): self.calls.append(("reel", Path(path).name)); return NS(pk=79, code="REL", media_type=2, product_type="clips", caption_text=caption, taken_at=None, like_count=0, comment_count=0, play_count=None, thumbnail_url=None)
    def photo_upload_to_story(self, path): self.calls.append(("story_photo",)); return NS(pk=80, code=None)
    def video_upload_to_story(self, path): self.calls.append(("story_video",)); return NS(pk=81, code=None)


@pytest.fixture
def env(tmp_path):
    fake = FakeClient()
    mgr = AccountManager(tmp_path / "sessions", client_factory=lambda: fake)
    pacer = Pacer(tmp_path / "pacing.json", caps={"comment": 2, "publish": 0}, min_gap=0, max_gap=0, sleep=lambda s: None)
    files = []

    def fake_dl(url, limit):
        p = tmp_path / ("v.mp4" if url.endswith(".mp4") else "p.jpg")
        p.write_bytes(b"x")
        files.append(p)
        return p

    app = create_app(mgr, pacer, TOKEN, downloader=fake_dl)
    c = TestClient(app, raise_server_exceptions=False)
    assert c.post("/accounts/main/session", headers=H, json={"settings": {"authorization_data": {"ds_user_id": "99"}}}).status_code == 200
    return c, fake, tmp_path, files


def test_requires_token(env):
    c, *_ = env
    assert c.get("/accounts").status_code == 401
    assert c.get("/accounts", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/health").json() == {"ok": True}


def test_short_token_refused(tmp_path):
    with pytest.raises(ValueError):
        create_app(AccountManager(tmp_path / "s", client_factory=FakeClient), Pacer(), "short")


def test_session_file_is_private(env):
    _, _, tmp, _ = env
    mode = (tmp / "sessions" / "main.json").stat().st_mode & 0o777
    assert mode == 0o600


def test_profile_media_comments(env):
    c, *_ = env
    me = c.get("/accounts/main/me", headers=H).json()
    assert me["username"] == "irancamping" and me["followers_count"] == 1234
    media = c.get("/accounts/main/media", headers=H).json()["items"][0]
    assert media["permalink"] == "https://www.instagram.com/p/AbC/" and media["caption"] == "سلام"
    assert c.get("/accounts/main/media/1/comments", headers=H).json()["items"][0]["username"] == "ali"


def test_unknown_account_and_bad_name(env):
    c, *_ = env
    assert c.get("/accounts/nobody/me", headers=H).json()["error"] == "no_session"
    assert c.get("/accounts/BAD NAME/me", headers=H).status_code in (400, 404)


def test_reply_is_capped_per_day(env):
    c, fake, *_ = env
    body = {"media_pk": "1", "text": "ممنون", "comment_pk": "11"}
    assert c.post("/accounts/main/comments/reply", headers=H, json=body).status_code == 200
    assert c.post("/accounts/main/comments/reply", headers=H, json=body).status_code == 200
    third = c.post("/accounts/main/comments/reply", headers=H, json=body)
    assert third.status_code == 429 and third.json()["error"] == "cap_reached"
    assert [x for x in fake.calls if x[0] == "comment"][0][3] == 11
    # other action kinds are unaffected
    assert c.post("/accounts/main/direct/send", headers=H, json={"text": "hi", "thread_id": "5"}).status_code == 200


def test_dm_requires_exactly_one_target(env):
    c, *_ = env
    assert c.post("/accounts/main/direct/send", headers=H, json={"text": "x"}).status_code == 400
    assert c.post("/accounts/main/direct/send", headers=H, json={"text": "x", "thread_id": "1", "user_id": "2"}).status_code == 400


def test_publish_kinds_and_cleanup(env):
    c, fake, _, files = env
    r = c.post("/accounts/main/publish", headers=H, json={"kind": "photo", "urls": ["https://x/a.jpg"], "caption": "c"}).json()
    assert r["permalink"] == "https://www.instagram.com/p/NEW/"
    assert c.post("/accounts/main/publish", headers=H, json={"kind": "carousel", "urls": ["https://x/a.jpg", "https://x/b.jpg"], "caption": "c"}).status_code == 200
    assert c.post("/accounts/main/publish", headers=H, json={"kind": "reel", "urls": ["https://x/a.mp4"]}).status_code == 200
    assert c.post("/accounts/main/publish", headers=H, json={"kind": "story", "urls": ["https://x/a.mp4"]}).status_code == 200
    assert [x[0] for x in fake.calls if x[0] in ("photo", "album", "reel", "story_video")] == ["photo", "album", "reel", "story_video"]
    assert c.post("/accounts/main/publish", headers=H, json={"kind": "photo", "urls": ["a", "b"]}).status_code == 400
    assert c.post("/accounts/main/publish", headers=H, json={"kind": "nope", "urls": ["https://x/a.jpg"]}).status_code == 400


def test_instagram_errors_are_mapped(env):
    from instagrapi import exceptions as ex

    c, fake, *_ = env
    fake.fail_with = ex.LoginRequired()
    r = c.get("/accounts/main/me", headers=H)
    assert r.status_code == 409 and r.json()["error"] == "session_expired"
    fake.fail_with = ex.PleaseWaitFewMinutes()
    assert c.get("/accounts/main/me", headers=H).status_code == 429
    fake.fail_with = ex.AccountSuspended()
    assert c.get("/accounts/main/me", headers=H).status_code == 423


def test_pacer_spaces_writes_and_resets_daily(tmp_path):
    sleeps, clock, day = [], [100.0], ["d1"]
    p = Pacer(tmp_path / "p.json", caps={"comment": 3}, min_gap=10, max_gap=10, sleep=lambda s: sleeps.append(s), rand=lambda a, b: a, today=lambda: day[0])
    p.before_write("comment", now=lambda: clock[0])
    clock[0] += 4
    p.before_write("comment", now=lambda: clock[0])
    assert sleeps == [6.0]
    p.before_write("comment", now=lambda: clock[0] + 20)
    with pytest.raises(CapReached):
        p.before_write("comment", now=lambda: clock[0] + 40)
    day[0] = "d2"
    p.before_write("comment", now=lambda: clock[0] + 60)  # new day → counter reset
    # counters survive a restart on the same day
    p2 = Pacer(tmp_path / "p.json", caps={"comment": 3}, min_gap=0, max_gap=0, today=lambda: "d2")
    assert p2.status()["counts"]["comment"] == 1


def test_cap_zero_means_unlimited(tmp_path):
    p = Pacer(caps={"publish": 0}, min_gap=0, max_gap=0, sleep=lambda s: None)
    for _ in range(200):
        p.before_write("publish")


def test_netguard_blocks_internal_targets():
    for u in ["http://127.0.0.1/x.jpg", "http://localhost/x.jpg", "http://169.254.169.254/latest", "http://10.0.0.5/a", "file:///etc/passwd", "ftp://example.com/a"]:
        with pytest.raises(UnsafeUrl):
            assert_public(u)
