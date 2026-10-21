"""Read the merged KPI 360 task table through the existing SQL API gateway.

This module preserves its historical name so the dashboard transformation code
stays unchanged. It does not open a SQL Server connection and does not execute SQL.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from services.api_service import fetch_table, api_configuration

REQUIRED_COLUMNS = [
    "KPIRecordKey", "InsertTS", "AppID", "RowID", "StageNo", "FMSName",
    "StageName", "DoerCode", "DoerName", "ScoreYear", "ScoreMonth",
    "ScoreWeekNo", "ScoreDayNo", "PLTimeStamp", "LeadTimeMins",
    "ALTimeStamp", "DelayMins", "PresenceFactor", "TaskStatus_KPI01",
    "KPI01_Score", "KPI01_ScoreFactored", "TaskStatus_KPI02", "KPI02_Score",
    "KPI02_ScoreFactored", "LastSyncTS", "KPIApplicable", "TaskGroupID",
    "ManagerCode", "ManagerName", "ManagerChain",
]

_CACHE: dict[str, Any] = {"fetched_at": 0.0, "rows": []}
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
    with _CACHE_LOCK:
        if not force and _CACHE["rows"] and now - _CACHE["fetched_at"] < ttl:
            return [dict(row) for row in _CACHE["rows"]]

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
        _CACHE["rows"] = rows
        _CACHE["fetched_at"] = now
    return [dict(row) for row in rows]


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
