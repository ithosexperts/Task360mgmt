"""Transforms the merged SQL task rows into the two existing dashboard formats."""
from __future__ import annotations

from datetime import date, datetime
import re
from typing import Any

from services.sql_service import load_records

KPI1_HEADERS = [
    "Record #", "FMS Name", "Stage Name", "Lead Time", "Planned", "Doer Name",
    "Actual", "Delay Hours", "Task Status", "KPI Month", "Week No.", "Day No",
    "KPI01 Score", "KPI01 Factored Score", "Presence Factor", "App ID", "Stage No",
    "KPI Year", "Doer Code", "Manager Name", "Manager Chain", "KPI Record Key",
    "Raw KPI01 Status",
]

KPI2_HEADERS = [
    "Record #", "FMS Name", "Stage Name", "Planned", "Doer Name", "Actual",
    "Task Status", "KPI Month", "Week No", "Day No", "Total Tasks", "Finished",
    "Task Completion Rate", "Task Completion Rate KPI Weightage",
    "Weighted Task Completion Rate Score", "KPI Year", "App ID", "Stage No", "Doer Code",
    "KPI Record Key", "Manager Name", "Manager Chain", "Raw KPI02 Status",
]

KPI2_FILTER_INDEXES = {
    "RECORD": 0, "FMS": 1, "STAGE": 2, "PLANNED": 3, "DOER": 4,
    "ACTUAL": 5, "TASK_STATUS": 6, "KPI_MONTH": 7, "WEEK_NO": 8,
    "DAY_NO": 9, "TOTAL_TASKS": 10, "DONE_TASKS": 11,
    "TASK_COMPLETION_RATE": 12, "KPI_WEIGHTAGE": 13, "WEIGHTED_SCORE": 14,
}


def norm(value: Any) -> str:
    return str(value or "").strip().casefold()


def clean_null(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str) and value.strip().casefold() in {"null", "none"}:
        return None
    return value


def numeric(value: Any, default: float = 0.0) -> float:
    value = clean_null(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def fmt_date(value: Any) -> str:
    value = clean_null(value)
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        dt = None
        for fmt in (
            "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
            "%d-%b-%Y %H:%M", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M",
        ):
            try:
                dt = datetime.strptime(s, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                return s
    return dt.strftime("%d-%b-%Y %H:%M")


def parse_datetime(value: Any) -> datetime | None:
    value = clean_null(value)
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    s = str(value).strip()
    for fmt in (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
        "%d-%b-%Y %H:%M", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M",
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def is_finished(value: Any) -> bool:
    s = norm(value)
    if any(phrase in s for phrase in ("not done", "not complet", "unfinished", "uncompleted", "cancel", "defer", "missed", "overdue")):
        return False
    return any(word in s for word in ("finish", "complet", "done", "closed"))


def kpi1_status(record: dict[str, Any]) -> str:
    raw = str(clean_null(record.get("TaskStatus_KPI01")) or "Planned").strip()
    s = norm(raw)
    delay_mins = numeric(record.get("DelayMins"), 0)
    if is_finished(raw):
        return "Done-Delayed" if delay_mins > 0 or any(word in s for word in ("delay", "late", "overdue")) else "Done-On-Time"
    if "defer" in s:
        return "Deferred"
    return raw


def kpi2_status(record: dict[str, Any]) -> str:
    raw = str(clean_null(record.get("TaskStatus_KPI02")) or "Awaited").strip()
    s = norm(raw)
    if is_finished(raw):
        return "Finished"
    if any(word in s for word in ("defer", "missed", "overdue", "not done", "not complet", "unfinished", "uncompleted")):
        return "Deferred"
    return "Awaited"


def _employees_and_role(email: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    # SQL-backed employee master; the KPI and employee tables share one SQL connection config.
    from services.employee_service import detect_roles, read_employee_master
    master = read_employee_master() or {}
    role = detect_roles(email, master)
    own = {}
    for key, value in master.items():
        if norm(key) == norm(email) and isinstance(value, dict):
            own = value
            break
    return master, role, own


def _first_value(mapping: dict[str, Any], *keys: str) -> Any:
    low = {str(k).casefold().replace(" ", "").replace("_", ""): v for k, v in mapping.items()}
    for key in keys:
        k = key.casefold().replace(" ", "").replace("_", "")
        if k in low and clean_null(low[k]) not in (None, ""):
            return low[k]
    return None


def _build_team(master: dict[str, Any], email: str) -> tuple[set[str], set[str]]:
    names: set[str] = set()
    codes: set[str] = set()
    visited: set[str] = set()

    def walk(manager_email: str) -> None:
        manager_email = norm(manager_email)
        if not manager_email or manager_email in visited:
            return
        visited.add(manager_email)
        for child_email, emp in master.items():
            if not isinstance(emp, dict):
                continue
            manager = norm(_first_value(emp, "managerEmail", "manager email", "reportingManagerEmail"))
            manager_code = norm(_first_value(emp, "managerCode", "manager code", "reportingManagerCode", "reportingToCode"))
            current_code = norm(_first_value(master.get(manager_email, {}), "employeeCode", "employee code", "empCode", "employeeId", "code"))
            if manager != manager_email and not (current_code and manager_code == current_code):
                continue
            name = _first_value(emp, "employeeName", "employee name", "name")
            code = _first_value(emp, "employeeCode", "employee code", "empCode", "employeeId", "code")
            if name:
                names.add(norm(name))
            if code is not None:
                codes.add(norm(code))
            walk(str(child_email))

    walk(email)
    return names, codes


def _manager_chain_matches(chain: Any, code: Any) -> bool:
    if chain in (None, "") or code in (None, ""):
        return False
    code_s = norm(code)
    # Split on common chain delimiters and compare complete tokens only.
    tokens = {norm(t) for t in re.split(r"[,;/|>\s]+", str(chain).replace("->", ",")) if norm(t)}
    return code_s in tokens


def partition_records(records: list[dict[str, Any]], email: str) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    master, role, own = _employees_and_role(email)
    own_name = norm(_first_value(own, "employeeName", "employee name", "name"))
    own_code = norm(_first_value(own, "employeeCode", "employee code", "empCode", "employeeId", "code"))
    team_names, team_codes = _build_team(master, email)
    if own_name:
        team_names.add(own_name)
    if own_code:
        team_codes.add(own_code)

    me_rows = []
    team_rows = []
    for record in records:
        doer_name = norm(record.get("DoerName"))
        doer_code = norm(record.get("DoerCode"))
        is_me = bool((own_code and doer_code == own_code) or (own_name and doer_name == own_name))
        is_team = (
            bool(doer_name and doer_name in team_names)
            or bool(doer_code and doer_code in team_codes)
            or _manager_chain_matches(record.get("ManagerChain"), own_code)
            or bool(own_code and norm(record.get("ManagerCode")) == own_code)
        )
        if is_me:
            me_rows.append(record)
        if role.get("isManager") and is_team:
            team_rows.append(record)

    partitions = {
        "admin": list(records) if role.get("isAdmin") else [],
        "myTeam": team_rows,
        "me": me_rows,
    }
    role = dict(role)
    role.setdefault("email", email)
    role["employeeName"] = role.get("employeeName") or own_name
    role["nameHints"] = {
        "adminNames": [],
        "managerNames": [],
        "doerNames": [str(_first_value(own, "employeeName", "employee name", "name") or "")] if own_name else [],
    }
    return partitions, role


def _row_id(record: dict[str, Any]) -> Any:
    return clean_null(record.get("RowID"))


def _group_key(record: dict[str, Any]) -> tuple[str, ...]:
    return tuple(norm(record.get(k)) for k in ("DoerCode", "AppID", "StageNo", "ScoreYear", "ScoreMonth"))


def _group_summaries(records: list[dict[str, Any]]) -> dict[tuple[str, ...], dict[str, int]]:
    summaries: dict[tuple[str, ...], dict[str, int]] = {}
    for record in records:
        key = _group_key(record)
        summary = summaries.setdefault(key, {"total": 0, "finished": 0})
        summary["total"] += 1
        if is_finished(record.get("TaskStatus_KPI02")):
            summary["finished"] += 1
    return summaries


def kpi1_row(record: dict[str, Any]) -> list[Any]:
    lead_hours = round(numeric(record.get("LeadTimeMins")) / 60.0, 4)
    delay_hours = round(numeric(record.get("DelayMins")) / 60.0, 4)
    return [
        _row_id(record), record.get("FMSName") or "", record.get("StageName") or "",
        lead_hours, fmt_date(record.get("PLTimeStamp")), record.get("DoerName") or "",
        fmt_date(record.get("ALTimeStamp")), delay_hours, kpi1_status(record),
        record.get("ScoreMonth") or "", record.get("ScoreWeekNo") or "",
        record.get("ScoreDayNo") or "", clean_null(record.get("KPI01_Score")),
        clean_null(record.get("KPI01_ScoreFactored")), clean_null(record.get("PresenceFactor")),
        record.get("AppID") or "", record.get("StageNo") or "",
        record.get("ScoreYear") or "", record.get("DoerCode") or "",
        record.get("ManagerName") or "", record.get("ManagerChain") or "",
        record.get("KPIRecordKey") or "", clean_null(record.get("TaskStatus_KPI01")) or "",
    ]


def kpi2_row(record: dict[str, Any], summaries: dict[tuple[str, ...], dict[str, int]]) -> list[Any]:
    summary = summaries.get(_group_key(record), {"total": 1, "finished": 0})
    total = summary["total"] or 1
    finished = summary["finished"]
    rate = clean_null(record.get("KPI02_Score"))
    if rate in (None, ""):
        rate = round((finished / total) * 100.0, 2)
    return [
        _row_id(record), record.get("FMSName") or "", record.get("StageName") or "",
        fmt_date(record.get("PLTimeStamp")), record.get("DoerName") or "",
        fmt_date(record.get("ALTimeStamp")), kpi2_status(record),
        record.get("ScoreMonth") or "", record.get("ScoreWeekNo") or "",
        record.get("ScoreDayNo") or "", summary["total"], finished, rate,
        clean_null(record.get("PresenceFactor")), clean_null(record.get("KPI02_ScoreFactored")),
        record.get("ScoreYear") or "", record.get("AppID") or "",
        record.get("StageNo") or "", record.get("DoerCode") or "",
        record.get("KPIRecordKey") or "", record.get("ManagerName") or "",
        record.get("ManagerChain") or "", clean_null(record.get("TaskStatus_KPI02")) or "",
    ]


def _filter_dates(records: list[dict[str, Any]], start_date: str | None, end_date: str | None) -> list[dict[str, Any]]:
    if not start_date and not end_date:
        return records
    start = end = None
    try:
        if start_date:
            start = datetime.strptime(start_date, "%Y-%m-%d")
        if end_date:
            end = datetime.strptime(end_date, "%Y-%m-%d").replace(hour=23, minute=59, second=59)
    except ValueError:
        return records
    result = []
    for record in records:
        planned = parse_datetime(record.get("PLTimeStamp"))
        if planned is None:
            continue
        if start and planned < start:
            continue
        if end and planned > end:
            continue
        result.append(record)
    return result


def get_kpi1_payload(email: str, force: bool = False) -> dict[str, Any]:
    all_records = load_records(force=force)
    partitions, role = partition_records(all_records, email)
    return {
        "email": email,
        "headers": KPI1_HEADERS,
        "partitions": {key: [kpi1_row(r) for r in rows] for key, rows in partitions.items()},
        "roleInfo": role,
    }


def get_kpi2_payload(email: str, start_date: str | None = None, end_date: str | None = None, force: bool = False) -> dict[str, Any]:
    all_records = load_records(force=force)
    date_records = _filter_dates(all_records, start_date, end_date)
    partitions, role = partition_records(date_records, email)
    summaries = _group_summaries(date_records)
    return {
        "email": email,
        "headers": KPI2_HEADERS,
        "filterIndexes": dict(KPI2_FILTER_INDEXES),
        "partitions": {key: [kpi2_row(r, summaries) for r in rows] for key, rows in partitions.items()},
        "roleInfo": role,
        "stats": {"totalSystemRecords": len(all_records), "loadedRecords": len(date_records)},
        "faultyData": [],
    }


def query_records(year: str | None = None, month: str | None = None, doer: str | None = None,
                  fms: str | None = None, stage: str | None = None, status: str | None = None,
                  email: str | None = None) -> list[dict[str, Any]]:
    records = load_records()
    if not email:
        return []
    partitions, role = partition_records(records, email)
    if role.get("isAdmin"):
        records = partitions["admin"]
    elif role.get("isManager"):
        records = partitions["myTeam"]
    else:
        records = partitions["me"]
    results = []
    for record in records:
        if year and norm(record.get("ScoreYear")) != norm(year):
            continue
        if month and norm(record.get("ScoreMonth")) != norm(month):
            continue
        if doer and norm(doer) not in {norm(record.get("DoerName")), norm(record.get("DoerCode"))}:
            continue
        if fms and norm(record.get("FMSName")) != norm(fms):
            continue
        if stage and norm(record.get("StageName")) != norm(stage):
            continue
        if status and norm(status) not in {norm(record.get("TaskStatus_KPI01")), norm(record.get("TaskStatus_KPI02"))}:
            continue
        results.append(record)
    return results
