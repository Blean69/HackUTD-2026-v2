"""Webhook signature check on POST /twiml: SignalWire (hex HMAC-SHA256 / HMAC-SHA1 over url + raw body) and the Twilio scheme
(base64 HMAC-SHA1 over url + sorted params). Known vectors are literals so an implementation drift shows up as a failing test."""
import pytest
from fastapi.testclient import TestClient
from loguru import logger

import config
from server import create_app
from twiml import SIGNATURE_HEADERS, signalwire_signature, twilio_signature, url_variants, verify_webhook

KEY = "PSK_testSigningKey0123456789"
URL = "https://keystone.example/voice/twiml"
BODY = b"CallSid=CA1&From=%2B15555550123&To=%2B14695550100"
FORM = {"CallSid": "CA1", "From": "+15555550123", "To": "+14695550100"}
# precomputed with an independent HMAC implementation
SHA256_HEX = "d85cfaf66227e32d46fd2d4eb911520f833652502e4841fb7167ce08ef342410"
SHA1_HEX = "ae1f7b038f690326faccdb3a2564eb5f8440f230"
SHA256_HEX_443_QUERY = "fe4976b8af337a00a087b8f3a8cd4aeb3b6ea9ae1c7fa451a2896eed296770b5"  # url https://keystone.example:443/voice/twiml?x=1
TWILIO_DOC = ("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", "GvWf1cFY/Q7PnoempGyD5oXAezc=")  # the vector in Twilio's own docs
TWILIO_DOC_PARAMS = {"Digits": "1234", "To": "+18005551212", "From": "+14158675310", "Caller": "+14158675310", "CallSid": "CA1234567890ABCDE"}

S = config.Settings(shared_secret="vs", signature_token=KEY, public_hostname="keystone.example", caller_hash_salt="pepper", nvidia_api_key="k")


def test_known_vectors():
    assert signalwire_signature(KEY, URL, BODY, "sha256") == SHA256_HEX
    assert signalwire_signature(KEY, URL, BODY, "sha1") == SHA1_HEX
    assert signalwire_signature(KEY, "https://keystone.example:443/voice/twiml?x=1", BODY) == SHA256_HEX_443_QUERY
    k, u, want = TWILIO_DOC
    assert twilio_signature(k, u, TWILIO_DOC_PARAMS) == want


def test_url_variants_cover_port_and_query_and_drop_credentials():
    v = url_variants(URL)
    assert v == [URL, "https://keystone.example:443/voice/twiml"]
    q = url_variants(URL, "x=1")
    assert "https://keystone.example/voice/twiml?x=1" in q and "https://keystone.example:443/voice/twiml?x=1" in q and URL in q
    assert url_variants("https://user:pw@keystone.example/voice/twiml")[0] == URL  # basic-auth stripped
    assert url_variants("https://keystone.example:8443/voice/twiml") == ["https://keystone.example:8443/voice/twiml"]


@pytest.mark.parametrize(
    "header,value",
    [
        ("x-signalwire-sha256-signature", SHA256_HEX),
        ("x-signalwire-sha256-signature", SHA256_HEX.upper()),
        ("x-signalwire-signature", SHA1_HEX),
        ("x-twilio-signature", twilio_signature(KEY, URL, FORM)),
        ("x-signalwire-signature", twilio_signature(KEY, URL, FORM)),  # the compatibility API signs X-SignalWire-Signature the Twilio way
    ],
)
def test_each_scheme_verifies(header, value):
    ok, info = verify_webhook(KEY, url_variants(URL), BODY, FORM, {header: value})
    assert ok and info["scheme"] and info["headers"] == [header]


def test_any_present_header_is_enough_and_garbage_or_wrong_key_is_not():
    hdrs = {"x-signalwire-signature": "deadbeef", "x-signalwire-sha256-signature": SHA256_HEX}
    assert verify_webhook(KEY, url_variants(URL), BODY, FORM, hdrs)[0]  # one bad header does not poison a good one
    ok, info = verify_webhook(KEY, url_variants(URL), BODY, FORM, {"x-signalwire-signature": "deadbeef", "x-twilio-signature": "nope"})
    assert not ok and info["headers"] == ["x-signalwire-signature", "x-twilio-signature"] and info["variants"] == 2
    assert not verify_webhook("other-key", url_variants(URL), BODY, FORM, {"x-signalwire-sha256-signature": SHA256_HEX})[0]
    assert not verify_webhook(KEY, url_variants(URL), BODY + b"&x=1", FORM, {"x-signalwire-sha256-signature": SHA256_HEX})[0]  # body tampered
    assert not verify_webhook(KEY, url_variants(URL), BODY, FORM, {})[0] and not verify_webhook("", url_variants(URL), BODY, FORM, {"x-twilio-signature": "x"})[0]
    assert not verify_webhook(KEY, url_variants(URL), BODY, FORM, {"x-signalwire-signature": "ünïcode"})[0]  # no crash on non-ascii header values


def test_signature_headers_are_the_three_documented_ones():
    assert set(SIGNATURE_HEADERS) == {"x-signalwire-signature", "x-signalwire-sha256-signature", "x-twilio-signature"}


def _post(c, headers, body=BODY, path="/twiml"):
    return c.post(path, content=body, headers={"content-type": "application/x-www-form-urlencoded", **headers})


def test_route_accepts_each_scheme_over_the_raw_body():
    with TestClient(create_app(S)) as c:
        for h in ({"X-SignalWire-SHA256-Signature": SHA256_HEX}, {"X-SignalWire-Signature": SHA1_HEX}, {"X-Twilio-Signature": twilio_signature(KEY, URL, FORM)}):
            r = _post(c, h)
            assert r.status_code == 200 and 'Stream url="wss://keystone.example/voice/ws"' in r.text, h
        assert "5555550123" not in r.text  # the number is hashed, never echoed


def test_route_tries_the_443_and_query_variants():
    with TestClient(create_app(S)) as c:
        r = _post(c, {"X-SignalWire-SHA256-Signature": SHA256_HEX_443_QUERY}, path="/twiml?x=1")
        assert r.status_code == 200
        r = _post(c, {"X-SignalWire-SHA256-Signature": SHA256_HEX_443_QUERY})  # same signature, but the request has no ?x=1
        assert r.status_code == 403


def test_route_rejects_and_logs_without_leaking():
    lines: list[str] = []
    sink = logger.add(lambda m: lines.append(str(m)), level="WARNING")
    try:
        with TestClient(create_app(S)) as c:
            assert c.post("/twiml", data=FORM).status_code == 403  # no signature header at all
            bad = "f" * 64
            assert _post(c, {"X-SignalWire-SHA256-Signature": bad, "X-SignalWire-Signature": "abc"}).status_code == 403
            assert _post(c, {"X-SignalWire-SHA256-Signature": SHA256_HEX}, body=BODY + b"&Extra=1").status_code == 403
    finally:
        logger.remove(sink)
    text = "".join(lines)
    assert "headers present=none" in text and "x-signalwire-sha256-signature" in text and "url variants tried=2" in text
    assert KEY not in text and bad not in text and SHA256_HEX not in text


def test_a_key_set_but_wrong_still_hangs_up_and_no_key_skips_the_check():
    with TestClient(create_app(S.with_overrides(signature_token="wrong"))) as c:
        assert _post(c, {"X-SignalWire-SHA256-Signature": SHA256_HEX}).status_code == 403
    with TestClient(create_app(S.with_overrides(signature_token=""))) as c:
        assert "<Connect><Stream" in _post(c, {}).text
    with TestClient(create_app(S.with_overrides(enabled=False))) as c:  # a valid signature on a closed line gets the polite hang-up
        assert "<Hangup/>" in _post(c, {"X-SignalWire-SHA256-Signature": SHA256_HEX}).text


def test_json_bodies_are_tolerated():
    with TestClient(create_app(S.with_overrides(signature_token="k2"))) as c:
        body = b'{"CallSid":"CA1","From":"+15555550123"}'
        sig = signalwire_signature("k2", URL, body)
        r = c.post("/twiml", content=body, headers={"content-type": "application/json", "X-SignalWire-SHA256-Signature": sig})
        assert r.status_code == 200 and "Stream" in r.text
