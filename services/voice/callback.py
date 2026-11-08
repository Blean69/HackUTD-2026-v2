"""Phone callback (docs/contracts.md section 10): about 15 s after a phone call that passed the PIN ends, Brian rings the same number back
from the SignalWire number with a critical alert.

What lives here
  * tokens          HMAC-signed, short-lived (~2 min) and single-use. They carry the household and the alert, never the phone number.
                    `cb` (in the dial URL /voice/twiml?cb=...) -> `cbs` (the callback session token handed to the media stream).
  * SignalWireDialer  POST {space}/api/laml/2010-04-01/Accounts/{project}/Calls.json (basic auth project:token; From, To, Url, Method=POST).
  * CallbackManager the rules and the clock: remember the caller's number in memory only, decide at hang-up whether a callback is due
                    (phone only, PIN passed, once per call, enabled, caps), wait VOICE_CALLBACK_SECS, pick the alert, dial, forget the number.
  * redaction       a loguru patcher that masks phone numbers in every log line (the numbers in memory exactly, anything number-shaped by pattern).

Privacy: the raw number exists only in `CallbackManager._numbers` (from the inbound webhook's `From`, until the call ends) and then in the
local variable of the single task that dials. It is never written to disk, sent to the worker, put in a token, or logged; logs carry the
salted hash (twiml.caller_hash). Dial failures are logged by HTTP status and SignalWire error code only."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import random
import re
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlsplit

import httpx
from loguru import logger

import alerts
from config import Settings
from twiml import caller_hash

TOKEN_TTL_SECS = 120
NUMBER_TTL_SECS = 30 * 60  # a remembered number older than this is dropped even if its call never reported an end
E164 = re.compile(r"^\+[1-9]\d{7,14}$")
RECENT_KEYS_SECS = 3600
DIAL_RETRY_SECS = 3.0  # one retry, only when SignalWire certainly did not place the call (CallbackManager._safe_to_retry)


# ==== log redaction ==============================================================================================================
_NUMBER_SHAPES = re.compile(
    r"(?<![\w.])(?:\+\d[\d\s().-]{6,17}\d|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4}|\d{10,15})(?![\w])"
)


class Redactor:
    """Masks phone numbers in text: the numbers currently held in memory exactly (any of their spellings), and anything number-shaped."""

    MASK = "[number]"

    def __init__(self) -> None:
        self._exact: dict[str, int] = {}

    def add(self, number: str) -> None:
        digits = re.sub(r"\D", "", number or "")
        if len(digits) >= 7:
            self._exact[digits] = self._exact.get(digits, 0) + 1

    def discard(self, number: str) -> None:
        digits = re.sub(r"\D", "", number or "")
        if digits in self._exact:
            self._exact[digits] -= 1
            if self._exact[digits] <= 0:
                del self._exact[digits]

    def redact(self, text: str) -> str:
        if not text:
            return text
        for digits in self._exact:
            # the number with optional +, spaces, dashes, dots and brackets between its digits
            text = re.sub(r"\+?" + r"[\s().-]*".join(re.escape(d) for d in digits), self.MASK, text)
        return _NUMBER_SHAPES.sub(self.MASK, text)


REDACTOR = Redactor()


def redact(text: str) -> str:
    return REDACTOR.redact(text)


def install_log_redaction() -> None:
    """Every loguru record (ours and pipecat's) gets phone numbers masked before any sink sees it. Idempotent."""

    def patch(record: dict) -> None:
        record["message"] = REDACTOR.redact(record["message"])

    logger.configure(patcher=patch)


# ==== tokens =====================================================================================================================
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _mac(secret: str, purpose: str, body: str) -> str:
    return hmac.new(secret.encode(), f"callback:{purpose}:{body}".encode(), hashlib.sha256).hexdigest()[:32]


def make_token(secret: str, purpose: str, claims: dict[str, str], now: float | None = None, ttl: int = TOKEN_TTL_SECS) -> str:
    """`<base64url(json claims + purpose + expiry)>.<hmac>`: URL-safe as it stands. `purpose` is part of the MAC, so a dial token can
    never be used as a session token or the other way round."""
    payload = {**claims, "p": purpose, "e": int((now if now is not None else time.time()) + ttl)}
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    return f"{body}.{_mac(secret, purpose, body)}"


def read_token(secret: str, purpose: str, token: str | None, now: float | None = None) -> dict[str, str] | None:
    """The claims when the signature, purpose and expiry are all good; otherwise None."""
    if not secret or not token or token.count(".") != 1 or len(token) > 1200:
        return None
    body, _, mac = token.partition(".")
    if not hmac.compare_digest(_mac(secret, purpose, body).encode(), mac.encode(errors="replace")):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("p") != purpose or not isinstance(payload.get("e"), int):
        return None
    if (now if now is not None else time.time()) > payload["e"]:
        return None
    return {k: str(v) for k, v in payload.items() if k not in ("p", "e")}


def make_callback_token(secret: str, household_id: str, alert_id: str, nonce: str, now: float | None = None) -> str:
    """The `cb` token in the dial URL: household + alert + a one-time id. No phone number."""
    return make_token(secret, "cb", {"h": household_id, "a": alert_id, "n": nonce}, now)


def read_callback_token(secret: str, token: str | None, now: float | None = None) -> dict[str, str] | None:
    return read_token(secret, "cb", token, now)


# ==== the plan for one callback ===================================================================================================
@dataclass
class CallbackPlan:
    nonce: str
    household_id: str
    first_name: str
    caller_hash: str  # salted hash only
    alert: alerts.CallbackAlert
    expires_at: float
    state: str = "pending"  # pending (dial URL out) -> answered (/twiml?cb accepted) -> gone (media stream claimed it)


class CallbackStore:
    """The plans waiting for their callback to be answered. Both tokens are single-use: the plan changes state each time one is accepted."""

    def __init__(self, secret: str, now: Callable[[], float] = time.time):
        self._secret = secret
        self._now = now
        self._plans: dict[str, CallbackPlan] = {}

    def __len__(self) -> int:
        self.sweep()
        return len(self._plans)

    def sweep(self) -> None:
        t = self._now()
        for n in [n for n, p in self._plans.items() if t > p.expires_at]:
            del self._plans[n]

    def add(self, plan: CallbackPlan) -> str:
        """Store the plan and return the dial token (valid TOKEN_TTL_SECS)."""
        self.sweep()
        t = self._now()
        plan.expires_at = t + TOKEN_TTL_SECS
        self._plans[plan.nonce] = plan
        return make_callback_token(self._secret, plan.household_id, plan.alert.key, plan.nonce, t)

    def discard(self, nonce: str) -> None:
        self._plans.pop(nonce, None)

    def answer(self, token: str | None) -> tuple[CallbackPlan, str] | None:
        """/twiml?cb=<token>: the plan and a fresh session token for the media stream, or None (bad, expired, or already used)."""
        self.sweep()
        claims = read_callback_token(self._secret, token, self._now())
        plan = self._plans.get((claims or {}).get("n", ""))
        if not claims or not plan or plan.state != "pending" or plan.household_id != claims.get("h") or plan.alert.key != claims.get("a"):
            return None
        plan.state = "answered"
        plan.expires_at = self._now() + TOKEN_TTL_SECS
        return plan, make_token(self._secret, "cbs", {"n": plan.nonce, "h": plan.household_id}, self._now())

    def connect(self, session_token: str | None) -> CallbackPlan | None:
        """The media stream's `cb_session` parameter: the plan (removed from the store: the session token works once)."""
        self.sweep()
        claims = read_token(self._secret, "cbs", session_token, self._now())
        plan = self._plans.get((claims or {}).get("n", ""))
        if not claims or not plan or plan.state != "answered" or plan.household_id != claims.get("h"):
            return None
        del self._plans[plan.nonce]
        return plan


# ==== SignalWire Compatibility (LaML) REST API =====================================================================================
class DialError(RuntimeError):
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"SignalWire {status} {code}{': ' + message if message else ''}")
        self.status, self.code = status, code


@dataclass(frozen=True)
class DialResult:
    sid: str
    status: str


def api_base(space_url: str) -> str:
    """https://<space> from `yourspace.signalwire.com`, `https://yourspace.signalwire.com/` etc. (plain http only for a local mock server)."""
    raw = (space_url or "").strip().rstrip("/")
    parts = urlsplit(raw if "://" in raw else f"https://{raw}")
    if parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"):
        return f"http://{parts.netloc}"
    return f"https://{parts.netloc}"


class SignalWireDialer:
    def __init__(self, space_url: str, project_id: str, api_token: str, from_number: str, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 10.0):
        self.space_url, self.project_id, self.api_token, self.from_number = space_url, project_id, api_token, from_number
        self._transport, self._timeout = transport, timeout

    @classmethod
    def from_settings(cls, s: Settings, **kw: Any) -> "SignalWireDialer":
        return cls(s.signalwire_space_url, s.signalwire_project_id, s.signalwire_api_token, s.signalwire_number, **kw)

    @property
    def configured(self) -> bool:
        return bool(self.space_url and self.project_id and self.api_token and self.from_number)

    @property
    def endpoint(self) -> str:
        return f"{api_base(self.space_url)}/api/laml/2010-04-01/Accounts/{quote(self.project_id, safe='')}/Calls.json"

    def form(self, to: str, url: str, *, ring_secs: int = 0, amd: str = "off") -> dict[str, str]:
        data = {"From": self.from_number, "To": to, "Url": url, "Method": "POST"}
        if ring_secs > 0:
            data["Timeout"] = str(ring_secs)  # stop ringing after this long (the carrier's voicemail usually picks up later than 20 s)
        if amd == "enable":
            data["MachineDetection"] = "Enable"
        elif amd == "detect_message_end":
            data["MachineDetection"] = "DetectMessageEnd"
        return data

    async def call(self, to: str, url: str, *, ring_secs: int = 0, amd: str = "off") -> DialResult:
        """Place ONE call. Never retried (a retry after a timeout could ring the person twice)."""
        if not self.configured:
            raise DialError(0, "not_configured", "SIGNALWIRE_* is incomplete")
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as http:
                r = await http.post(self.endpoint, data=self.form(to, url, ring_secs=ring_secs, amd=amd), auth=(self.project_id, self.api_token))
        except httpx.HTTPError as e:
            raise DialError(0, type(e).__name__) from None
        try:
            body = r.json()
        except ValueError:
            body = {}
        body = body if isinstance(body, dict) else {}
        if r.status_code >= 400:
            raise DialError(r.status_code, str(body.get("code") or "http_error"), redact(str(body.get("message") or ""))[:160])
        return DialResult(sid=str(body.get("sid") or ""), status=str(body.get("status") or "queued"))


# ==== the manager ================================================================================================================
@dataclass
class _Job:
    call_sid: str
    household_id: str
    first_name: str
    who: str  # salted hash only


class CallbackManager:
    def __init__(
        self,
        s: Settings,
        *,
        dialer: SignalWireDialer | None = None,
        worker: Any = None,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: random.Random | None = None,
    ):
        self.s = s
        self.dialer = dialer or SignalWireDialer.from_settings(s)
        self.worker = worker  # anything with `await alert_candidates(household_id) -> dict` (WorkerClient)
        self.store = CallbackStore(s.shared_secret, now)
        self._now, self._sleep, self._rng = now, sleep, rng or random.Random()
        self._numbers: dict[str, tuple[str, float]] = {}  # call_sid -> (number, remembered_until): the ONLY place a raw number lives
        self._scheduled: dict[str, float] = {}  # call_sid -> when: one callback per call
        self._last_for: dict[str, float] = {}  # caller hash -> last callback scheduled
        self._dials: deque[float] = deque()
        self._recent: dict[str, dict[str, float]] = {}  # household -> {alert key: when used}
        self.tasks: set[asyncio.Task] = set()
        self.placed = 0

    # ---- switches ---------------------------------------------------------------------------------------------------------------
    def missing(self) -> list[str]:
        """What stops callbacks from working (empty = ready). Names only, never values."""
        out = []
        if not self.s.shared_secret:
            out.append("VOICE_SHARED_SECRET")
        for name, ok in (("SIGNALWIRE_SPACE_URL", self.s.signalwire_space_url), ("SIGNALWIRE_PROJECT_ID", self.s.signalwire_project_id), ("SIGNALWIRE_API_TOKEN", self.s.signalwire_api_token), ("SIGNALWIRE_PHONE_NUMBER", self.s.signalwire_number)):
            if not ok:
                out.append(name)
        return out

    @property
    def enabled(self) -> bool:
        return self.s.callback_enabled and self.s.enabled and "twilio" in self.s.transports and not self.missing() and self.dialer.configured

    def status_line(self) -> str:
        if not self.s.callback_enabled:
            return "callback: off (VOICE_CALLBACK_ENABLED=0)"
        if self.missing():
            return f"callback: off (missing {', '.join(self.missing())})"
        return f"callback: on ({self.s.callback_secs:g}s after the call ends, rings {self.s.callback_ring_secs}s, answering-machine detection={self.s.callback_amd})"

    # ---- the caller's number: memory only ---------------------------------------------------------------------------------------
    def _sweep_numbers(self) -> None:
        t = self._now()
        for sid in [k for k, (_, until) in self._numbers.items() if t > until]:
            self.forget(sid)

    def remember(self, call_sid: str, number: str) -> bool:
        """Called from the inbound webhook with `From`. Held until the call ends (or NUMBER_TTL_SECS), then dropped. Anything that is not a
        dialable E.164 number (withheld, "anonymous", short codes) or is our own number is ignored."""
        if not self.enabled or not call_sid or not E164.match(number or "") or number == self.s.signalwire_number:
            return False
        self._sweep_numbers()
        self.forget(call_sid)
        self._numbers[call_sid] = (number, self._now() + NUMBER_TTL_SECS)
        REDACTOR.add(number)
        return True

    def forget(self, call_sid: str) -> str:
        """Drop the number held for this call (returns it so the one caller that dials can use it)."""
        number, _ = self._numbers.pop(call_sid, ("", 0.0))
        if number:
            REDACTOR.discard(number)
        return number

    def who(self, number_or_hash: str) -> str:
        return number_or_hash[:8] if number_or_hash else "unknown"

    # ---- hang-up: is a callback due? --------------------------------------------------------------------------------------------
    def call_ended(self, call: Any) -> str:
        """`call` is the finished VoiceCall (init, unlocked, household_id, first_name, end_reason). Returns "scheduled" or the reason it was not.
        Never raises: this runs in a finally block."""
        init = call.init
        call_sid = getattr(init, "call_sid", "")
        number = self.forget(call_sid) if call_sid else ""
        try:
            reason = self._why_not(call, call_sid, number)
            if reason:
                return reason
            who = caller_hash(self.s.caller_hash_salt, number) if self.s.caller_hash_salt else ""
            t = self._now()
            self._scheduled[call_sid] = t
            self._last_for[who or call_sid] = t
            self._dials.append(t)
            job = _Job(call_sid=call_sid, household_id=call.household_id, first_name=call.first_name, who=who)
            task = asyncio.create_task(self._run(number, job), name=f"callback-{call_sid[-6:]}")
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            logger.info(f"callback scheduled in {self.s.callback_secs:g}s for caller {self.who(who)} (household {job.household_id})")
            return "scheduled"
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"callback scheduling failed: {type(e).__name__}")
            return "error"
        finally:
            number = ""  # noqa: F841  (the only copy left is the task's)

    def _why_not(self, call: Any, call_sid: str, number: str) -> str:
        init = call.init
        if not self.enabled:
            return "disabled"
        if init.kind != "phone":
            return "not_phone"  # the browser Talk call never triggers a callback
        if getattr(init, "callback", None) is not None:
            return "is_callback"  # a callback is never followed by another one
        if not call.unlocked or not call.household_id:
            return "never_unlocked"
        if str(call.end_reason).startswith("error"):
            return "errored"
        if not call_sid or not number:
            return "no_number"
        t = self._now()
        for k in [k for k, v in self._scheduled.items() if t - v > 6 * 3600]:
            del self._scheduled[k]
        if call_sid in self._scheduled:
            return "already_scheduled"
        who = caller_hash(self.s.caller_hash_salt, number) if self.s.caller_hash_salt else ""
        if self.s.callback_cooldown_secs and t - self._last_for.get(who or call_sid, -1e9) < self.s.callback_cooldown_secs:
            return "cooldown"
        while self._dials and t - self._dials[0] > 3600:
            self._dials.popleft()
        if len(self._dials) >= self.s.callback_max_per_hour:
            return "hourly_cap"
        return ""

    # ---- the callback itself ----------------------------------------------------------------------------------------------------
    @staticmethod
    def _safe_to_retry(e: DialError) -> bool:
        """SignalWire refused without placing the call (429 busy, 503 unavailable), or the request never reached it. A timeout after the
        request was sent is NOT retried: the call may already be ringing, and a second dial would ring the person twice."""
        return e.status in (429, 503) or (e.status == 0 and e.code in ("ConnectError", "ConnectTimeout"))

    def callback_url(self, token: str) -> str:
        return f"https://{self.s.public_hostname}{self.s.public_path}/twiml?cb={token}"

    def _recent_keys(self, household_id: str) -> set[str]:
        t = self._now()
        keys = {k: v for k, v in self._recent.get(household_id, {}).items() if t - v < RECENT_KEYS_SECS}
        self._recent[household_id] = keys
        return set(keys)

    async def pick_alert(self, household_id: str) -> alerts.CallbackAlert:
        """Real signals first, a template otherwise. Never raises."""
        payload = None
        if self.worker is not None:
            try:
                payload = await asyncio.wait_for(self.worker.alert_candidates(household_id), timeout=8.0)
            except Exception as e:
                logger.warning(f"alert candidates unavailable ({type(e).__name__}); using a template")
        alert = alerts.select_alert(payload, rng=self._rng, exclude=self._recent_keys(household_id))
        self._recent.setdefault(household_id, {})[alert.key] = self._now()
        return alert

    async def _run(self, number: str, job: _Job) -> None:
        plan: CallbackPlan | None = None
        try:
            picking = asyncio.create_task(self.pick_alert(job.household_id))  # while the wait runs
            await self._sleep(self.s.callback_secs)
            alert = await picking
            plan = CallbackPlan(nonce=secrets.token_urlsafe(9), household_id=job.household_id, first_name=job.first_name, caller_hash=job.who, alert=alert, expires_at=0.0)
            url = self.callback_url(self.store.add(plan))
            try:
                res = await self.dialer.call(number, url, ring_secs=self.s.callback_ring_secs, amd=self.s.callback_amd)
            except DialError as e:
                if not self._safe_to_retry(e):
                    raise
                logger.warning(f"callback dial refused ({e.status} {e.code}); retrying once in {DIAL_RETRY_SECS:g}s")
                await self._sleep(DIAL_RETRY_SECS)
                res = await self.dialer.call(number, url, ring_secs=self.s.callback_ring_secs, amd=self.s.callback_amd)
            self.placed += 1
            logger.info(f"callback call placed for caller {self.who(job.who)}: {res.status} (call {res.sid[-6:] or '?'}), alert {alert.source}:{alert.origin}")
        except DialError as e:
            logger.warning(f"callback not placed: {redact(str(e))}")
            if plan:
                self.store.discard(plan.nonce)
        except asyncio.CancelledError:
            if plan:
                self.store.discard(plan.nonce)
            raise
        except Exception as e:  # never a traceback: its frames hold the number
            logger.warning(f"callback not placed: {type(e).__name__}")
            if plan:
                self.store.discard(plan.nonce)
        finally:
            number = ""  # noqa: F841  drop the last reference to the raw number

    async def aclose(self) -> None:
        for t in list(self.tasks):
            t.cancel()
        for t in list(self.tasks):
            try:
                await t
            except BaseException:
                pass
        self._numbers.clear()
