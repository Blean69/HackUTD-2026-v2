"""cXML/TwiML for SignalWire (and Twilio): the document that sends a call's audio to our /ws, the webhook signature check,
and the short-lived token that keeps strangers off the media WebSocket."""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
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
    if not token or not header:
        return False
    return hmac.compare_digest(twilio_signature(token, url, params), header.strip())


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
