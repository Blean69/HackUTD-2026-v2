"""cXML/TwiML for SignalWire (and Twilio): the document that sends a call's audio to our /ws, the webhook signature check,
and the short-lived token that keeps strangers off the media WebSocket."""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
from collections.abc import Mapping
from urllib.parse import urlsplit, urlunsplit
from xml.sax.saxutils import quoteattr

TOKEN_MAX_AGE_SECS = 600


def build_twiml(stream_url: str, params: dict[str, str]) -> str:
    ps = "".join(f"<Parameter name={quoteattr(k)} value={quoteattr(v)}/>" for k, v in params.items() if v != "")
    return f'<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url={quoteattr(stream_url)}>{ps}</Stream></Connect></Response>'


def say_and_hangup(text: str) -> str:
    from xml.sax.saxutils import escape

    return f'<?xml version="1.0" encoding="UTF-8"?><Response><Say>{escape(text)}</Say><Hangup/></Response>'


def twilio_signature(token: str, url: str, params: dict[str, str]) -> str:
    """Twilio/SignalWire request signature: base64(HMAC-SHA1(token, url + sorted(key+value)...))."""
    data = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()


def valid_signature(token: str, url: str, params: dict[str, str], header: str | None) -> bool:
    """The Twilio scheme only (kept for callers and tests that use it directly); the /twiml route uses verify_webhook()."""
    if not token or not header:
        return False
    return hmac.compare_digest(twilio_signature(token, url, params).encode(), header.strip().encode())


# ---- webhook signatures: SignalWire (hex HMAC over url + raw body) and Twilio-compatible (base64 HMAC-SHA1 over url + sorted params) --------
# SignalWire call requests carry X-SignalWire-Signature = hex(HMAC-SHA1(key, url + rawBody)) and X-SignalWire-SHA256-Signature =
# hex(HMAC-SHA256(key, url + rawBody)); the compatibility (LaML/cXML) callbacks may instead send X-Twilio-Signature = the Twilio scheme.
# The signed URL is the full public URL including any query string, with no basic-auth part, joined to the body with no separator.
SIGNATURE_HEADERS = ("x-signalwire-sha256-signature", "x-signalwire-signature", "x-twilio-signature")


def signalwire_signature(key: str, url: str, raw_body: bytes, algo: str = "sha256") -> str:
    """hex(HMAC-<algo>(key, url + raw body)), the SignalWire scheme. algo: "sha256" or "sha1"."""
    return hmac.new(key.encode(), url.encode() + (raw_body or b""), hashlib.sha256 if algo == "sha256" else hashlib.sha1).hexdigest()


def url_variants(public_url: str, query: str = "") -> list[str]:
    """The URLs a sender may have signed for our public webhook URL: with and without the explicit :443 port, with and without the query
    string, never with basic-auth credentials. Order: the plain URL first."""
    parts = urlsplit(public_url)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"  # IPv6 literal
    default_port = {"https": 443, "http": 80}.get(parts.scheme)
    hostports = [host]
    if default_port and parts.port in (None, default_port):
        hostports.append(f"{host}:{default_port}")
    elif parts.port:
        hostports = [f"{host}:{parts.port}"]
    queries = [parts.query] if parts.query else []
    if query and query not in queries:
        queries.append(query)
    queries.append("")
    out: list[str] = []
    for q in queries:
        for hp in hostports:
            u = urlunsplit((parts.scheme, hp, parts.path, q, ""))
            if u not in out:
                out.append(u)
    return out


def verify_webhook(key: str, urls: list[str], raw_body: bytes, params: Mapping[str, str], headers: Mapping[str, str]) -> tuple[bool, dict]:
    """True when ANY signature header present verifies under ANY scheme for ANY of the candidate URLs (all compares constant-time).

    Returns (ok, info). info never carries secrets or signatures: {"headers": [names present], "variants": URLs tried, "scheme": what matched}."""
    present = [(h, (headers.get(h) or "").strip()) for h in SIGNATURE_HEADERS if (headers.get(h) or "").strip()]
    info: dict = {"headers": [h for h, _ in present], "variants": len(urls), "scheme": None}
    if not key or not present:
        return False, info
    given_hex = [(h, v.lower().encode()) for h, v in present]
    given_raw = [(h, v.encode()) for h, v in present]
    ok = False  # keep comparing after a hit so the time does not depend on which URL or scheme matched
    for url in urls:
        candidates = (
            ("sha256-body", signalwire_signature(key, url, raw_body, "sha256").encode(), given_hex),
            ("sha1-body", signalwire_signature(key, url, raw_body, "sha1").encode(), given_hex),
            ("twilio-params", twilio_signature(key, url, dict(params)).encode(), given_raw),
        )
        for scheme, want, givens in candidates:
            for _h, got in givens:
                if hmac.compare_digest(want, got) and not ok:
                    ok, info["scheme"] = True, scheme
    return ok, info


def make_stream_token(secret: str, now: float | None = None) -> str:
    ts = str(int(now if now is not None else time.time()))
    mac = hmac.new(secret.encode(), f"stream:{ts}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{ts}.{mac}"


def valid_stream_token(secret: str, token: str | None, now: float | None = None) -> bool:
    if not secret or not token or "." not in token:
        return False
    ts, _, mac = token.partition(".")
    if not ts.isdigit():
        return False
    age = (now if now is not None else time.time()) - int(ts)
    if age < -30 or age > TOKEN_MAX_AGE_SECS:
        return False
    good = hmac.new(secret.encode(), f"stream:{ts}".encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(good, mac)


def caller_hash(salt: str, number: str) -> str:
    """Salted hash of the caller's number. The raw number is never stored, logged or sent to the worker."""
    if not number:
        return ""
    return hashlib.sha256(f"{salt}{number}".encode()).hexdigest()[:24]
