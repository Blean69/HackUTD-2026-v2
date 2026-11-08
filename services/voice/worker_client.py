"""HTTP client for the worker's internal /phone/* routes (x-voice-secret header). Python never talks to SpacetimeDB."""
from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import httpx
from loguru import logger


class WorkerError(RuntimeError):
    def __init__(self, status: int, code: str, detail: str = ""):
        super().__init__(f"worker {status} {code}{': ' + detail if detail else ''}")
        self.status = status
        self.code = code


class WorkerClient:
    def __init__(self, base_url: str, secret: str, *, timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None):
        self._http = httpx.AsyncClient(base_url=base_url, headers={"x-voice-secret": secret}, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _call(self, method: str, path: str, body: dict | None = None, *, retries: int = 1) -> Any:
        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                r = await self._http.request(method, path, json=body)
            except httpx.HTTPError as e:  # connection refused, timeout...
                last = e
                await asyncio.sleep(0.15 * (attempt + 1))
                continue
            if r.status_code >= 500 and attempt < retries:
                last = WorkerError(r.status_code, "server_error")
                await asyncio.sleep(0.15 * (attempt + 1))
                continue
            try:
                data = r.json()
            except ValueError:
                data = {}
            if r.status_code >= 400:
                raise WorkerError(r.status_code, str(data.get("error", "http_error")), str(data.get("detail", "")))
            return data
        raise WorkerError(0, "unreachable", str(last))

    async def identify(self, call_id: str, caller_hash: str, pin: str) -> dict:
        return await self._call("POST", "/phone/identify", {"call_id": call_id, "caller_hash": caller_hash, "pin": pin}, retries=0)

    async def start(self, **body: Any) -> dict:
        return await self._call("POST", "/phone/start", body, retries=0)

    async def tools(self) -> list[dict]:
        return await self._call("GET", "/phone/tools")

    async def tool(self, run_id: str, name: str, args: dict) -> dict:
        return await self._call("POST", "/phone/tool", {"run_id": run_id, "name": name, "args": args}, retries=0)

    async def trace(self, run_id: str, events: list[dict]) -> dict:
        return await self._call("POST", "/phone/trace", {"run_id": run_id, "events": events})

    async def alert_candidates(self, household_id: str) -> dict:
        """Real signals for the callback's alert + the household's account context (GET /phone/alert_candidates)."""
        return await self._call("GET", f"/phone/alert_candidates?household_id={quote(household_id, safe='')}")

    async def ring_check(self, household_id: str, call_id: str) -> dict:
        """Did a phone in this household really answer this in-app ring? Single use (POST /phone/ring_check). Never retried."""
        return await self._call("POST", "/phone/ring_check", {"household_id": household_id, "call_id": call_id}, retries=0)

    async def callback_alert(self, run_id: str, alert: dict) -> dict:
        """Write the callback's alert as a critical `alert` row and trace it on the run (POST /phone/callback_alert)."""
        return await self._call("POST", "/phone/callback_alert", {"run_id": run_id, "alert": alert}, retries=0)

    async def end(self, run_id: str, reason: str, stats: dict | None = None) -> dict:
        try:
            return await self._call("POST", "/phone/end", {"run_id": run_id, "reason": reason, "stats": stats or {}})
        except WorkerError as e:
            logger.warning(f"could not end run {run_id}: {e}")
            return {}
