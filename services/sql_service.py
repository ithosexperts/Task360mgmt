"""Read the merged KPI 360 task table through the existing SQL API gateway.

This module preserves its historical name so the dashboard transformation code
stays unchanged. It does not open a SQL Server connection and does not execute SQL.
"""
from __future__ import annotations

import os
import re
import threading
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from services.api_service import fetch_table, api_configuration, current_api_base_name

REQUIRED_COLUMNS = [
    "KPIRecordKey", "InsertTS", "AppID", "RowID", "StageNo", "FMSName",
    "StageName", "DoerCode", "DoerName", "ScoreYear", "ScoreMonth",
    "ScoreWeekNo", "ScoreDayNo", "PLTimeStamp", "LeadTimeMins",
    "ALTimeStamp", "DelayMins", "PresenceFactor", "TaskStatus_KPI01",
    "KPI01_Score", "KPI01_ScoreFactored", "TaskStatus_KPI02", "KPI02_Score",
    "KPI02_ScoreFactored", "LastSyncTS", "KPIApplicable", "TaskGroupID",
    "ManagerCode", "ManagerName", "ManagerChain",
]

_CACHE: dict[str, Any] = {"entries": {}}
_CACHE_LOCK = threading.Lock()


def _table_name() -> str:
    table = (os.getenv("KPI_SQL_TABLE") or "").strip()
    if not table:
        raise RuntimeError(
            "KPI_SQL_TABLE is not configured. Set it to the merged KPI table name "
            "as recognized by the existing SQL API gateway."
        )
    return table


def _clean(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str) and value.strip().upper() in {"NULL", "NONE"}:
        return None
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _row_is_applicable(row: dict[str, Any]) -> bool:
    value = str(row.get("KPIApplicable") or "").strip().lower()
    return value not in {"n", "no", "0", "false"}


def load_records(force: bool = False) -> list[dict[str, Any]]:
    """Fetch and briefly cache API rows so both dashboards share the same read."""
    ttl = max(0, int(os.getenv("KPI_SQL_CACHE_SECONDS", "30")))
    now = time.time()
    cache_key = current_api_base_name()
    with _CACHE_LOCK:
        entry = (_CACHE.get("entries") or {}).get(cache_key) or {}
        if not force and entry.get("rows") and now - entry.get("fetched_at", 0.0) < ttl:
            return [dict(row) for row in entry["rows"]]

    table = _table_name()
    max_rows = max(1, min(int(os.getenv("KPI_SQL_MAX_ROWS", "100000")), 500000))
    fetched = fetch_table(table)
    rows: list[dict[str, Any]] = []
    for raw in fetched[:max_rows]:
        # Column names are returned by the shared API; preserve them as-is while
        # normalizing dates/decimals to JSON-friendly values.
        cleaned = {str(key): _clean(value) for key, value in raw.items()}
        if _row_is_applicable(cleaned):
            rows.append(cleaned)

    with _CACHE_LOCK:
        _CACHE.setdefault("entries", {})[cache_key] = {"rows": rows, "fetched_at": now}
    return [dict(row) for row in rows]


# Cached lookup maps used for the Department and Team Name dashboard filters.
_LOOKUP_CACHE: dict[str, Any] = {"entries": {}}
_LOOKUP_LOCK = threading.Lock()


def _lookup_key(value: Any) -> str:
    return str(value if value is not None else "").strip().casefold()


def _lookup_canonical_code(value: Any) -> str:
    key = _lookup_key(value)
    if key.isdigit():
        return key.lstrip("0") or "0"
    return key


def _lookup_field(row: dict[str, Any], *aliases: str) -> Any:
    normalized = {
        re.sub(r"[^a-z0-9]", "", str(key).casefold()): value
        for key, value in row.items()
    }
    for alias in aliases:
        key = re.sub(r"[^a-z0-9]", "", alias.casefold())
        value = normalized.get(key)
        if value is not None and str(value).strip() and str(value).strip().casefold() not in {"null", "none"}:
            return value
    return None


def load_department_team_lookups(force: bool = False) -> dict[str, Any]:
    """Return DoerCode -> Department/Team Name lookups, without joining extra visible table columns.

    Defaults match the SQL tables confirmed by the user: VM_EmployeeMaster and VM_Team.
    A Doer may belong to multiple teams; those team names are returned as a list.
    Lookup failures are non-fatal to the main KPI dashboard and included as warnings.
    """
    ttl = max(30, int(os.getenv("KPI_ORG_LOOKUP_CACHE_SECONDS", "300")))
    now = time.time()
    cache_key = current_api_base_name()
    with _LOOKUP_LOCK:
        entry = (_LOOKUP_CACHE.get("entries") or {}).get(cache_key) or {}
        if not force and entry.get("fetched_at") and now - entry["fetched_at"] < ttl:
            return {
                "department_by_code": dict(entry["department_by_code"]),
                "teams_by_code": {k: list(v) for k, v in entry["teams_by_code"].items()},
                "warnings": list(entry["warnings"]),
            }

    employee_table = (os.getenv("KPI_EMPLOYEE_LOOKUP_TABLE") or "VM_EmployeeMaster").strip()
    team_table = (os.getenv("KPI_TEAM_LOOKUP_TABLE") or "VM_Team").strip()
    warnings: list[str] = []
    try:
        employee_rows = fetch_table(employee_table)
    except Exception as exc:  # keep core KPI page available if a lookup table is not accessible
        employee_rows = []
        warnings.append(f"Department lookup from {employee_table} failed: {exc}")
    try:
        team_rows = fetch_table(team_table)
    except Exception as exc:
        team_rows = []
        warnings.append(f"Team lookup from {team_table} failed: {exc}")

    department_by_code: dict[str, str] = {}
    departments_by_canonical: dict[str, set[str]] = {}
    for row in employee_rows:
        code = _lookup_field(row, "EmployeeCode", "Employee Code", "EmpCode", "EmployeeID")
        dept = _lookup_field(row, "Department", "DepartmentName", "Dept")
        key = _lookup_key(code)
        dept_text = str(dept).strip() if dept is not None else ""
        if not key or not dept_text:
            continue
        department_by_code.setdefault(key, dept_text)
        departments_by_canonical.setdefault(_lookup_canonical_code(code), set()).add(dept_text)

    teams_by_code_mut: dict[str, set[str]] = {}
    teams_by_canonical_mut: dict[str, set[str]] = {}
    for row in team_rows:
        code = _lookup_field(row, "EmployeeCode", "Employee Code", "EmpCode", "EmployeeID")
        team = _lookup_field(row, "TeamName", "Team Name")
        key = _lookup_key(code)
        team_text = str(team).strip() if team is not None else ""
        if not key or not team_text:
            continue
        teams_by_code_mut.setdefault(key, set()).add(team_text)
        teams_by_canonical_mut.setdefault(_lookup_canonical_code(code), set()).add(team_text)

    # Add numeric-code fallbacks only when the canonical employee-code mapping is unambiguous.
    for canonical, departments in departments_by_canonical.items():
        if len(departments) == 1:
            department_by_code.setdefault(f"__canonical__:{canonical}", next(iter(departments)))
    for canonical, teams in teams_by_canonical_mut.items():
        teams_by_code_mut.setdefault(f"__canonical__:{canonical}", set()).update(teams)

    teams_by_code = {key: sorted(values, key=str.casefold) for key, values in teams_by_code_mut.items()}
    with _LOOKUP_LOCK:
        _LOOKUP_CACHE.setdefault("entries", {})[cache_key] = {
            "fetched_at": now,
            "department_by_code": department_by_code,
            "teams_by_code": teams_by_code,
            "warnings": warnings,
        }
    return {
        "department_by_code": dict(department_by_code),
        "teams_by_code": {k: list(v) for k, v in teams_by_code.items()},
        "warnings": list(warnings),
    }


def sql_status() -> dict[str, Any]:
    """Legacy-named status check; verifies table access via HTTP API only."""
    table = _table_name()
    rows = fetch_table(table)
    return {
        "connected": True,
        "accessMethod": "HTTP SQL API",
        "table": table,
        "rowCount": len(rows),
        **api_configuration(),
    }
