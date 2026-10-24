"""Shared HTTP client for the existing HoseXperts SQL API gateway.

The Task 360 application never connects to SQL Server directly. It consumes
API_1_URL / API_2_URL using the same action=select contract as the other portals.
"""
from __future__ import annotations

import os
from contextvars import ContextVar, Token
from typing import Any

import httpx

_REQUEST_API_BASE: ContextVar[str | None] = ContextVar("task360_request_api_base", default=None)


def set_request_api_base(api_base: str | None) -> Token:
    """Set a request-scoped API base from a verified One Portal SSO ticket."""
    key = str(api_base or "").strip().upper()
    if key not in {"API_1", "API_2"}:
        key = "API_1"
    return _REQUEST_API_BASE.set(key)


def reset_request_api_base(token: Token) -> None:
    _REQUEST_API_BASE.reset(token)


def current_api_base_name() -> str:
    override = _REQUEST_API_BASE.get()
    if override in {"API_1", "API_2"}:
        return override
    raw = (os.getenv("KPI_API_BASE") or "API_1").strip().upper()
    return "API_2" if raw in {"2", "API2", "API_2", "PROD", "PRODUCTION", "OPERATIONSDB"} else "API_1"


_WRAPPER_KEYS = (
    "data", "rows", "items", "result", "results", "records",
    "recordset", "value", "payload", "list",
)


def _active_api_base() -> tuple[str, str]:
    """Return the explicitly selected API base name and URL.

    Default to API_1, which is the apiv2.php endpoint used for Test_OperationsDB
    in the existing portal convention. Set KPI_API_BASE=API_2 to select API_2.
    """
    base = current_api_base_name()
    if base in {"1", "API1", "API_1", "TEST", "TEST_OPERATIONSDB"}:
        key = "API_1"
        env_key = "API_1_URL"
    elif base in {"2", "API2", "API_2", "PROD", "PRODUCTION", "OPERATIONSDB"}:
        key = "API_2"
        env_key = "API_2_URL"
    else:
        raise RuntimeError("KPI_API_BASE must be API_1 or API_2.")

    url = (os.getenv(env_key) or "").strip().rstrip("/")
    if not url:
        raise RuntimeError(f"{env_key} is not configured. Set it to the existing PHP SQL API URL.")
    return key, url


def api_configuration() -> dict[str, str | bool]:
    """Return safe, non-secret API configuration details for health checks."""
    raw_base = (os.getenv("KPI_API_BASE") or "API_1").strip().upper()
    try:
        key, url = _active_api_base()
        return {"apiBase": key, "configured": True, "endpoint": url}
    except RuntimeError:
        key = "API_2" if raw_base in {"2", "API2", "API_2", "PROD", "PRODUCTION", "OPERATIONSDB"} else "API_1"
        return {"apiBase": key, "configured": False, "endpoint": ""}


def _extract_rows(payload: Any) -> list[dict[str, Any]]:
    """Normalize common API response envelopes into a list of row objects."""
    if payload is None:
        return []
    if isinstance(payload, list):
        result: list[dict[str, Any]] = []
        for item in payload:
            if isinstance(item, dict):
                # Flatten wrapper objects such as [{"data": [...]}].
                if any(key in item for key in _WRAPPER_KEYS):
                    result.extend(_extract_rows(item))
                else:
                    result.append(item)
            elif isinstance(item, list):
                result.extend(_extract_rows(item))
        return result

    if isinstance(payload, dict):
        status = str(payload.get("success", payload.get("ok", ""))).strip().casefold()
        status_word = str(payload.get("status", "")).strip().casefold()
        if status in {"false", "0", "no"} or status_word in {"error", "failed", "failure"}:
            detail = payload.get("error") or payload.get("message") or payload.get("detail") or "API reported failure"
            raise RuntimeError(f"SQL API returned an error: {detail}")
        if payload.get("error"):
            raise RuntimeError(f"SQL API returned an error: {payload['error']}")

        for key in _WRAPPER_KEYS:
            if key in payload:
                nested = payload[key]
                if isinstance(nested, (list, dict)):
                    return _extract_rows(nested)

        for value in payload.values():
            if isinstance(value, (list, dict)):
                rows = _extract_rows(value)
                if rows:
                    return rows

        # Some gateways return one row directly rather than wrapping it.
        if payload and not {"success", "ok", "message", "status", "error", "detail"}.intersection(payload):
            return [payload]
    return []


def fetch_table(table_name: str, *, api_base: str | None = None) -> list[dict[str, Any]]:
    """Read all rows from a table through the configured API gateway."""
    table = str(table_name or "").strip()
    if not table:
        raise RuntimeError("A table name is required. Set KPI_SQL_TABLE or VM_EMPLOYEE_TABLE.")

    if api_base is None:
        _base_key, url = _active_api_base()
    else:
        key = str(api_base).strip().upper()
        if key in {"1", "API1", "API_1", "TEST", "TEST_OPERATIONSDB"}:
            url = (os.getenv("API_1_URL") or "").strip().rstrip("/")
            env_key = "API_1_URL"
        elif key in {"2", "API2", "API_2", "PROD", "PRODUCTION", "OPERATIONSDB"}:
            url = (os.getenv("API_2_URL") or "").strip().rstrip("/")
            env_key = "API_2_URL"
        else:
            raise RuntimeError("api_base must be API_1 or API_2.")
        if not url:
            raise RuntimeError(f"{env_key} is not configured.")

    timeout_seconds = float(os.getenv("REQUEST_TIMEOUT", "15"))
    headers = {"Accept": "application/json"}
    token = (os.getenv("API_AUTH_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    params = {
        "action": "select",
        "table": table,
        "fetchAll": "true",
    }
    try:
        with httpx.Client(timeout=timeout_seconds, follow_redirects=True) as client:
            response = client.get(url, params=params, headers=headers)
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise RuntimeError(f"SQL API request timed out after {timeout_seconds:g} seconds.") from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        body = (exc.response.text or "")[:500]
        raise RuntimeError(f"SQL API returned HTTP {status}: {body}") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach the configured SQL API: {exc}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        snippet = (response.text or "")[:250]
        raise RuntimeError(f"SQL API did not return JSON. Response starts with: {snippet}") from exc

    return _extract_rows(payload)


def fetch_table_filtered(table_name: str, filters: dict[str, Any], *, api_base: str | None = None) -> list[dict[str, Any]]:
    """SELECT rows with API gateway filters, used for One Portal session validation."""
    table = str(table_name or "").strip()
    if not table:
        raise RuntimeError("A table name is required.")
    if api_base is None:
        _base_key, url = _active_api_base()
    else:
        key = str(api_base).strip().upper()
        if key not in {"API_1", "API_2"}:
            raise RuntimeError("api_base must be API_1 or API_2.")
        url = (os.getenv(f"{key}_URL") or "").strip().rstrip("/")
        if not url:
            raise RuntimeError(f"{key}_URL is not configured.")
    timeout_seconds = float(os.getenv("REQUEST_TIMEOUT", "15"))
    headers = {"Accept": "application/json"}
    token = (os.getenv("API_AUTH_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {"action": "SELECT", "table": table, "filters": filters or {}}
    try:
        with httpx.Client(timeout=timeout_seconds, follow_redirects=True) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise RuntimeError(f"SQL API request timed out after {timeout_seconds:g} seconds.") from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        body = (exc.response.text or "")[:500]
        raise RuntimeError(f"SQL API returned HTTP {status}: {body}") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach the configured SQL API: {exc}") from exc
    try:
        payload_data = response.json()
    except ValueError as exc:
        snippet = (response.text or "")[:250]
        raise RuntimeError(f"SQL API did not return JSON. Response starts with: {snippet}") from exc
    return _extract_rows(payload_data)
