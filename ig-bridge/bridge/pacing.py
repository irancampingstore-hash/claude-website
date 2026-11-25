"""Human-like pacing for write actions.

Instagram's private API flags accounts that act like robots (bursts, identical delays, hundreds of actions a
day). This module spaces write actions out with random jitter and keeps daily counters.

Defaults are deliberately conservative to protect your business account. They are NOT hard-coded limits:
set a cap to 0 in the environment to remove it (you accept the ban risk), see README.
"""
from __future__ import annotations

import json
import random
import threading
import time
from datetime import date
from pathlib import Path
from typing import Callable

# kind -> (env name, default daily cap).  0 = unlimited.
DEFAULT_CAPS = {
    "publish": 20,
    "comment": 60,
    "dm": 60,
    "delete": 60,
}


class CapReached(Exception):
    def __init__(self, kind: str, cap: int):
        super().__init__(f"Daily cap for '{kind}' reached ({cap}/day). Raise IG_CAP_{kind.upper()} (0 = unlimited) if you accept the ban risk.")
        self.kind, self.cap = kind, cap


class Pacer:
    def __init__(
        self,
        state_file: Path | None = None,
        caps: dict[str, int] | None = None,
        min_gap: float = 8.0,
        max_gap: float = 25.0,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[float, float], float] = random.uniform,
        today: Callable[[], str] = lambda: date.today().isoformat(),
    ):
        self.caps = {**DEFAULT_CAPS, **(caps or {})}
        self.min_gap, self.max_gap = min_gap, max_gap
        self._sleep, self._rand, self._today = sleep, rand, today
        self._lock = threading.Lock()
        self._last_write = 0.0
        self._file = state_file
        self._counts: dict[str, int] = {}
        self._day = self._today()
        if state_file and state_file.exists():
            try:
                data = json.loads(state_file.read_text())
                if data.get("day") == self._day:
                    self._counts = {k: int(v) for k, v in data.get("counts", {}).items()}
            except (ValueError, OSError):
                pass

    def _persist(self) -> None:
        if self._file:
            try:
                self._file.write_text(json.dumps({"day": self._day, "counts": self._counts}))
            except OSError:
                pass

    def before_write(self, kind: str, now: Callable[[], float] = time.monotonic) -> float:
        """Block until it is safe to perform a write action; returns seconds slept. Raises CapReached."""
        with self._lock:
            if self._today() != self._day:
                self._day, self._counts = self._today(), {}
            cap = self.caps.get(kind, 0)
            if cap and self._counts.get(kind, 0) >= cap:
                raise CapReached(kind, cap)
            gap = self._rand(self.min_gap, self.max_gap) if self.max_gap > 0 else 0.0
            wait = max(0.0, self._last_write + gap - now()) if self._last_write else 0.0
            if wait > 0:
                self._sleep(wait)
            self._last_write = now()
            self._counts[kind] = self._counts.get(kind, 0) + 1
            self._persist()
            return wait

    def status(self) -> dict:
        return {"day": self._day, "counts": dict(self._counts), "caps": dict(self.caps), "gap_seconds": [self.min_gap, self.max_gap]}
