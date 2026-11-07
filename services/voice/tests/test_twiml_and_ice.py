import base64
import hashlib
import hmac

import pytest

from ice import parse_ice_servers
from twiml import build_twiml, caller_hash, make_stream_token, say_and_hangup, twilio_signature, valid_signature, valid_stream_token


def test_twiml_connects_a_stream_and_escapes():
    xml = build_twiml("wss://host.example/voice/ws", {"token": "1.abc", "caller_hash": "h&h", "empty": ""})
    assert xml.startswith('<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://host.example/voice/ws">')
    assert '<Parameter name="token" value="1.abc"/>' in xml
    assert "h&amp;h" in xml and "empty" not in xml
    assert xml.endswith("</Stream></Connect></Response>")


def test_say_and_hangup_escapes():
    assert "&lt;" in say_and_hangup("a <b>") and "<Hangup/>" in say_and_hangup("x")


def test_signature_matches_the_documented_algorithm():
    # base64(HMAC-SHA1(token, url + sorted key+value pairs)), the Twilio/SignalWire LaML scheme
    token, url = "12345", "https://mycompany.com/myapp.php?foo=1&bar=2"
    params = {"Digits": "1234", "To": "+18005551212", "From": "+14158675310", "Caller": "+14158675310", "CallSid": "CA1234567890ABCDE"}
    data = url + "".join(k + params[k] for k in sorted(params))
    expect = base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()
    assert twilio_signature(token, url, params) == expect
    assert valid_signature(token, url, params, expect)
    assert not valid_signature(token, url, {**params, "Digits": "9999"}, expect)
    assert not valid_signature(token, url, params, None)
    assert not valid_signature("", url, params, expect)


def test_stream_token_is_short_lived_and_tamper_proof():
    t = make_stream_token("s3cret", now=1_000_000)
    assert valid_stream_token("s3cret", t, now=1_000_100)
    assert not valid_stream_token("s3cret", t, now=1_000_000 + 601)  # expired
    assert not valid_stream_token("other", t, now=1_000_100)
    assert not valid_stream_token("s3cret", t[:-1] + ("0" if t[-1] != "0" else "1"), now=1_000_100)
    assert not valid_stream_token("s3cret", None) and not valid_stream_token("s3cret", "nope") and not valid_stream_token("", t, now=1_000_100)


def test_caller_hash_is_salted_and_never_the_number():
    a, b = caller_hash("salt1", "+15555550123"), caller_hash("salt2", "+15555550123")
    assert a != b and "5555550123" not in a and len(a) == 24
    assert caller_hash("x", "") == ""


def test_ice_servers_formats():
    assert parse_ice_servers("") == [] and parse_ice_servers(None) == []
    assert parse_ice_servers("stun:stun.l.google.com:19302") == [{"urls": "stun:stun.l.google.com:19302"}]
    assert parse_ice_servers("stun:a:1, turn:b:2") == [{"urls": "stun:a:1"}, {"urls": "turn:b:2"}]
    assert parse_ice_servers('[{"urls":"stun:stun.l.google.com:19302"}]') == [{"urls": "stun:stun.l.google.com:19302"}]
    turn = '{"urls":"turn:t.example:3478","username":"u","credential":"c"}'
    assert parse_ice_servers(turn) == [{"urls": "turn:t.example:3478", "username": "u", "credential": "c"}]
    with pytest.raises(ValueError):
        parse_ice_servers('[{"url":"stun:x"}]')
    with pytest.raises(ValueError):
        parse_ice_servers('[{"urls":"stun:x","bogus":1}]')
