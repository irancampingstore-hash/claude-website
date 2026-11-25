"""Download user-supplied media URLs safely (no localhost / LAN / metadata endpoints, redirects re-checked)."""
from __future__ import annotations

import ipaddress
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_PHOTO = 20 * 1024 * 1024
MAX_VIDEO = 300 * 1024 * 1024


class UnsafeUrl(ValueError):
    pass


def assert_public(url: str, allow_private: bool = False) -> urllib.parse.ParseResult:
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise UnsafeUrl("Only http(s) URLs are allowed")
    if allow_private:
        return p
    host = p.hostname
    if host == "localhost" or host.endswith((".local", ".internal")):
        raise UnsafeUrl("Local/internal hosts are not allowed")
    try:
        infos = socket.getaddrinfo(host, p.port or (443 if p.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise UnsafeUrl(f"Cannot resolve {host}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise UnsafeUrl(f"Host resolves to a non-public address ({ip})")
    return p


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # we follow manually so every hop is validated
        return None


def download(url: str, max_bytes: int, allow_private: bool = False, suffix_hint: str = "") -> Path:
    opener = urllib.request.build_opener(_NoRedirect)
    current = url
    for _ in range(4):
        assert_public(current, allow_private)
        req = urllib.request.Request(current, headers={"User-Agent": "Mozilla/5.0 (iran-camping-ig-bridge)"})
        try:
            resp = opener.open(req, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                current = urllib.parse.urljoin(current, e.headers["Location"])
                continue
            raise UnsafeUrl(f"Download failed: HTTP {e.code}") from e
        suffix = Path(urllib.parse.urlparse(current).path).suffix.lower() or suffix_hint
        fd = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        total = 0
        try:
            with resp, fd:
                while chunk := resp.read(1024 * 256):
                    total += len(chunk)
                    if total > max_bytes:
                        raise UnsafeUrl(f"File larger than {max_bytes // (1024 * 1024)} MB")
                    fd.write(chunk)
        except Exception:
            Path(fd.name).unlink(missing_ok=True)
            raise
        return Path(fd.name)
    raise UnsafeUrl("Too many redirects")
