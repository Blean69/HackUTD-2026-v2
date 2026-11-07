"""PIPECAT_ICE_SERVERS: bare URLs separated by commas, one JSON object, or a JSON array of objects with urls/username/credential
(the same format as Pipecat's own runner). aiortc uses only the first STUN and the first TURN server."""
from __future__ import annotations

import json
from typing import Any

ALLOWED = {"urls", "username", "credential"}


def parse_ice_servers(value: str | None) -> list[dict[str, Any]]:
    if not value or not value.strip():
        return []
    text = value.strip()
    if text.startswith("["):
        entries: list[Any] = json.loads(text)
        if not isinstance(entries, list):
            raise ValueError("expected a JSON array of ICE servers")
    elif text.startswith("{"):
        entries = [json.loads(text)]
    else:
        entries = [x.strip() for x in text.split(",") if x.strip()]
    out: list[dict[str, Any]] = []
    for e in entries:
        if isinstance(e, str):
            out.append({"urls": e})
            continue
        if not isinstance(e, dict) or not e.get("urls"):
            raise ValueError(f"ICE server needs 'urls': {e!r}")
        bad = set(e) - ALLOWED
        if bad:
            raise ValueError(f"unsupported ICE server key(s) {sorted(bad)}")
        out.append({k: v for k, v in e.items() if v is not None})
    return out
