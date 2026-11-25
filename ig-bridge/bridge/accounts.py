"""Instagram sessions kept on disk (one JSON per account). Treat the sessions folder like a password vault."""
from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

NAME_RE = re.compile(r"^[a-z0-9_-]{2,30}$")


class SessionMissing(Exception):
    pass


@dataclass
class Account:
    name: str
    client: object
    lock: threading.Lock = field(default_factory=threading.Lock)


class AccountManager:
    def __init__(self, session_dir: Path, proxy: str | None = None, client_factory: Callable[[], object] | None = None):
        self.dir = session_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        self.proxy = proxy
        if client_factory is None:
            from instagrapi import Client  # imported lazily so tests can run without the package

            client_factory = Client
        self._factory = client_factory
        self._accounts: dict[str, Account] = {}
        self._guard = threading.Lock()

    @staticmethod
    def valid_name(name: str) -> str:
        if not NAME_RE.match(name):
            raise ValueError("Account name must be 2-30 chars: a-z 0-9 _ -")
        return name

    def _path(self, name: str) -> Path:
        return self.dir / f"{self.valid_name(name)}.json"

    def names(self) -> list[str]:
        return sorted(p.stem for p in self.dir.glob("*.json") if NAME_RE.match(p.stem))

    def _new_client(self):
        cl = self._factory()
        try:
            cl.delay_range = [1, 3]  # small jitter between the library's own requests
            if self.proxy:
                cl.set_proxy(self.proxy)
        except AttributeError:
            pass
        return cl

    def get(self, name: str) -> Account:
        with self._guard:
            acc = self._accounts.get(name)
            if acc:
                return acc
            path = self._path(name)
            if not path.exists():
                raise SessionMissing(f"No session for account '{name}'. Import one (see README: login_local.py).")
            cl = self._new_client()
            cl.load_settings(path)
            acc = Account(name=name, client=cl)
            self._accounts[name] = acc
            return acc

    def save(self, name: str) -> None:
        acc = self._accounts.get(name)
        if acc:
            path = self._path(name)
            acc.client.dump_settings(path)
            os.chmod(path, 0o600)

    def import_settings(self, name: str, settings: dict) -> None:
        if "authorization_data" not in settings and "cookies" not in settings:
            raise ValueError("That does not look like an instagrapi session file")
        path = self._path(name)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(settings, f)
        with self._guard:
            self._accounts.pop(name, None)

    def remove(self, name: str) -> None:
        self._path(name).unlink(missing_ok=True)
        with self._guard:
            self._accounts.pop(name, None)

    def login_sessionid(self, name: str, sessionid: str) -> None:
        cl = self._new_client()
        cl.login_by_sessionid(sessionid)
        cl.dump_settings(self._path(name))
        os.chmod(self._path(name), 0o600)
        with self._guard:
            self._accounts.pop(name, None)

    def login_password(self, name: str, username: str, password: str, code: str = "") -> None:
        cl = self._new_client()
        cl.login(username, password, verification_code=code)
        cl.dump_settings(self._path(name))
        os.chmod(self._path(name), 0o600)
        with self._guard:
            self._accounts.pop(name, None)
