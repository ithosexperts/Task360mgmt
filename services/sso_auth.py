"""One Portal SSO for Task 360.

Only a signed, one-time ticket from One Portal may create a Task 360 session.
The cookie contains employee code and the originating One Portal session ID;
roles and department are always re-read from VM_EmployeeMaster.
"""
from __future__ import annotations

import html
import os
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs
from typing import Any

import jwt
from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware

from services.api_service import fetch_table_filtered, set_request_api_base, reset_request_api_base
from services.employee_service import read_employee_master, find_employee

PORTAL_ISSUER = "one-portal"
TICKET_AUDIENCE = "task360"
SESSION_ISSUER = "task360"
SESSION_AUDIENCE = "task360-session"
SESSION_COOKIE = "task360_sso_session"
ALGORITHM = "HS256"
PUBLIC_PATHS = {"/api/health", "/auth/launch", "/favicon.ico"}
PUBLIC_PREFIXES = ("/static/", "/docs", "/redoc", "/openapi.json")


class SsoError(Exception):
    def __init__(self, message: str, status_code: int = 401):
        super().__init__(message)
        self.status_code = status_code


def _secret() -> str:
    secret = (os.getenv("TASK360_SSO_SECRET") or "").strip()
    if len(secret) < 32:
        raise SsoError("Task 360 SSO is not configured. Set TASK360_SSO_SECRET.", 503)
    return secret


def _pick(row: dict[str, Any] | None, *keys: str) -> Any:
    lookup = {str(k).strip().casefold(): v for k, v in (row or {}).items()}
    for key in keys:
        if key.casefold() in lookup:
            return lookup[key.casefold()]
    return None


def _database_api_base(target_database: str | None) -> str:
    target = str(target_database or "").strip().casefold()
    if target == "test_operationsdb":
        return "API_1"
    if target == "operationsdb":
        return "API_2"
    raise SsoError("Launch ticket has an invalid database target.", 401)


def _decode_ticket(ticket: str) -> dict[str, Any]:
    try:
        return jwt.decode(
            ticket, _secret(), algorithms=[ALGORITHM], issuer=PORTAL_ISSUER,
            audience=TICKET_AUDIENCE,
            options={"require": ["exp", "iat", "jti", "employee_code", "portal_session_id"]},
            leeway=3,
        )
    except jwt.ExpiredSignatureError as exc:
        raise SsoError("Launch ticket expired. Please reopen Task 360 from One Portal.") from exc
    except jwt.InvalidTokenError as exc:
        raise SsoError("Invalid One Portal launch ticket.") from exc


class _ReplayStore:
    def __init__(self) -> None:
        self._used: dict[str, int] = {}
        self._lock = threading.Lock()

    def consume(self, jti: str, exp: int) -> bool:
        now = int(time.time())
        with self._lock:
            for key, expiry in list(self._used.items()):
                if expiry < now:
                    self._used.pop(key, None)
            if not jti or jti in self._used:
                return False
            self._used[jti] = max(int(exp or 0), now + 60)
            return True


_replay_store = _ReplayStore()
# Tiny cache avoids an external session-table lookup on every polling request.
_SESSION_CACHE: dict[str, tuple[float, bool]] = {}
_SESSION_CACHE_LOCK = threading.Lock()
_SESSION_CACHE_SECONDS = 8


def _fetch_active_portal_session(session_id: str, employee_code: str) -> bool:
    now = time.monotonic()
    with _SESSION_CACHE_LOCK:
        cached = _SESSION_CACHE.get(session_id)
        if cached and now - cached[0] < _SESSION_CACHE_SECONDS:
            return cached[1]
    try:
        rows = fetch_table_filtered("TM_Login_Sessions", {"session_id": session_id})
    except Exception as exc:
        raise SsoError("One Portal session validation service is temporarily unavailable.", 503) from exc
    row = next((r for r in rows if str(_pick(r, "session_id", "SessionID") or "").strip() == session_id), None)
    status = str(_pick(row, "Status", "status") or "").strip().casefold() if row else ""
    row_code = str(_pick(row, "EmployeeCode", "employee_code") or "").strip()
    logout_raw = _pick(row, "LogoutTime", "logout_time") if row else None
    expiry_raw = _pick(row, "ExpiryTime", "expiry_time") if row else None
    expiry_ok = True
    if expiry_raw and str(expiry_raw).strip().casefold() not in {"none", "null"}:
        try:
            expiry_text = str(expiry_raw).strip().replace("Z", "+00:00")
            expiry_dt = datetime.fromisoformat(expiry_text)
            if expiry_dt.tzinfo is None:
                expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
            expiry_ok = datetime.now(timezone.utc) <= expiry_dt
        except ValueError:
            # Match the FMS behavior: malformed expiry text is not itself proof
            # of an expired session; the signed cookie still has its own expiry.
            expiry_ok = True
    logout_is_set = logout_raw is not None and str(logout_raw).strip().casefold() not in {"", "none", "null", "0"}
    is_active = bool(row and status == "active" and not logout_is_set and expiry_ok and (not row_code or row_code.casefold() == employee_code.casefold()))
    with _SESSION_CACHE_LOCK:
        _SESSION_CACHE[session_id] = (now, is_active)
    return is_active


def _safe_next(value: str | None) -> str:
    path = (value or "/").strip()
    if not path.startswith("/") or path.startswith("//") or "\\" in path or path.startswith("/auth/") or any(c in path for c in "\r\n"):
        return "/"
    return path


def _error_page(message: str, code: int) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>Task 360 SSO</title></head><body style='font-family:Arial,sans-serif;padding:32px;color:#24344d'>"
        "<h2>Unable to sign in to Task 360</h2><p>" + html.escape(message) + "</p>"
        "<p>Please close this view and open Task 360 again from One Portal.</p></body></html>", status_code=code,
    )


async def launch_from_one_portal(request: Request):
    # One Portal's launcher POSTs urlencoded fields into the embedded app.
    raw = (await request.body()).decode("utf-8", errors="replace")
    form = parse_qs(raw, keep_blank_values=True)
    ticket = str((form.get("ticket") or [""])[0]).strip()
    next_path = _safe_next((form.get("next") or ["/"])[0])
    try:
        claims = _decode_ticket(ticket)
        jti = str(claims.get("jti") or "")
        exp = int(claims.get("exp") or 0)
        if not _replay_store.consume(jti, exp):
            raise SsoError("This launch ticket has already been used. Reopen Task 360 from One Portal.")
        employee_code = str(claims.get("employee_code") or "").strip()
        portal_session_id = str(claims.get("portal_session_id") or "").strip()
        if not employee_code or not portal_session_id:
            raise SsoError("Launch ticket is incomplete.")
        api_base = _database_api_base(claims.get("target_database"))
        api_context = set_request_api_base(api_base)
        try:
            if not _fetch_active_portal_session(portal_session_id, employee_code):
                raise SsoError("Your One Portal session is no longer active. Sign in again to One Portal.")
            # Fail closed if EmployeeCode cannot be resolved in the employee master.
            master = read_employee_master(force=True)
            if not find_employee(employee_code, master):
                raise SsoError("EmployeeCode was not found in VM_EmployeeMaster. Contact your administrator.", 403)
        finally:
            reset_request_api_base(api_context)
        ttl = max(300, int(os.getenv("TASK360_SSO_SESSION_MINUTES", "480")) * 60)
        now = int(datetime.now(timezone.utc).timestamp())
        cookie = jwt.encode({
            "iss": SESSION_ISSUER, "aud": SESSION_AUDIENCE, "sub": employee_code,
            "employee_code": employee_code, "portal_session_id": portal_session_id,
            "target_database": str(claims.get("target_database") or "OperationsDB"),
            "iat": now, "nbf": now - 1, "exp": now + ttl,
        }, _secret(), algorithm=ALGORITHM)
        response = RedirectResponse(url=next_path, status_code=303)
        response.set_cookie(SESSION_COOKIE, cookie, max_age=ttl, httponly=True, secure=True, samesite="none", path="/")
        response.headers.append("Set-Cookie", f"{SESSION_COOKIE}={cookie}; Max-Age={ttl}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned")
        return response
    except SsoError as exc:
        return _error_page(str(exc), exc.status_code)


def read_session_cookie(value: str | None) -> dict[str, Any] | None:
    value = str(value or "").strip()
    if not value:
        return None
    try:
        return jwt.decode(
            value, _secret(), algorithms=[ALGORITHM], issuer=SESSION_ISSUER,
            audience=SESSION_AUDIENCE,
            options={"require": ["exp", "employee_code", "portal_session_id"]}, leeway=3,
        )
    except (jwt.InvalidTokenError, SsoError):
        return None


class Task360SsoMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in PUBLIC_PATHS or any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES):
            return await call_next(request)
        claims = read_session_cookie(request.cookies.get(SESSION_COOKIE))
        if not claims:
            return self._unauthorized(path)
        employee_code = str(claims.get("employee_code") or "").strip()
        session_id = str(claims.get("portal_session_id") or "").strip()
        try:
            api_context = set_request_api_base(_database_api_base(claims.get("target_database")))
        except SsoError as exc:
            return JSONResponse(status_code=401, content={"detail": str(exc)})
        try:
            try:
                session_active = _fetch_active_portal_session(session_id, employee_code)
                master = read_employee_master()
            except SsoError as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})
            except Exception:
                return JSONResponse(status_code=503, content={"detail": "Authentication validation service is temporarily unavailable."})
            if not session_active:
                with _SESSION_CACHE_LOCK:
                    _SESSION_CACHE.pop(session_id, None)
                return JSONResponse(status_code=401, content={"detail": "One Portal session is no longer active. Reopen Task 360 from One Portal."})
            identity = find_employee(employee_code, master)
            if not identity:
                return JSONResponse(status_code=403, content={"detail": "EmployeeCode is not present in VM_EmployeeMaster."})
            request.state.employee_code = employee_code
            request.state.employee = identity
            request.state.portal_session_id = session_id
            request.state.target_database = claims.get("target_database")
            return await call_next(request)
        finally:
            reset_request_api_base(api_context)

    @staticmethod
    def _unauthorized(path: str):
        if path.startswith("/api/"):
            return JSONResponse(status_code=401, content={"detail": "Open Task 360 from One Portal to sign in."})
        return _error_page("Open Task 360 from One Portal. Email login is disabled for this application.", 401)
