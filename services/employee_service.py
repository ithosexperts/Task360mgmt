"""Employee and role lookup via the existing SQL API's VM_EmployeeMaster table."""
from __future__ import annotations

import os
import re
import threading
import time
from typing import Any

from services.api_service import fetch_table, api_configuration, current_api_base_name

_EMPLOYEE_CACHE: dict[str, Any] = {"entries": {}}
_EMPLOYEE_CACHE_LOCK = threading.Lock()


def _table_name() -> str:
    return (os.getenv("VM_EMPLOYEE_TABLE") or "VM_EmployeeMaster").strip()


def _canonical(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def _value(row: dict[str, Any], *names: str) -> Any:
    lookup = {_canonical(key): value for key, value in row.items()}
    for name in names:
        value = lookup.get(_canonical(name))
        if value is not None and str(value).strip() != "":
            return value
    return None


def _role_id_set(env_name: str, default: str = "") -> set[str]:
    return {
        token.strip().casefold()
        for token in os.getenv(env_name, default).split(",")
        if token.strip()
    }


def read_employee_master(force: bool = False) -> dict[str, dict[str, Any]]:
    """Read employee rows via the shared API and normalize role fields."""
    ttl = max(0, int(os.getenv("VM_EMPLOYEE_CACHE_SECONDS", "300")))
    now = time.time()
    cache_key = current_api_base_name()
    with _EMPLOYEE_CACHE_LOCK:
        entry = (_EMPLOYEE_CACHE.get("entries") or {}).get(cache_key) or {}
        cached = entry.get("rows") or {}
        if not force and cached and now - entry.get("fetched_at", 0.0) < ttl:
            return {key: dict(value) for key, value in cached.items()}

    table = _table_name()
    raw_rows = fetch_table(table)
    result: dict[str, dict[str, Any]] = {}
    admin_ids = _role_id_set("EMPLOYEE_ADMIN_ROLE_IDS", "1")
    manager_ids = _role_id_set("EMPLOYEE_MANAGER_ROLE_IDS")

    for raw in raw_rows:
        email_value = _value(
            raw, "OffEmail", "EmailID", "EmailId", "Email", "EmailAddress",
            "EmployeeEmail", "EmployeeEmailID", "OfficialEmail", "WorkEmail", "LoginEmail",
        )
        email = str(email_value or "").strip().casefold()

        name = _value(raw, "EmployeeName", "Employee Name", "Name", "FullName", "EmployeeFullName", "EmpName")
        code = _value(raw, "EmployeeCode", "Employee Code", "EmpCode", "Employee ID", "EmployeeID", "EmpID", "Code")
        manager_email = _value(raw, "ManagerEmail", "Manager Email", "ReportingManagerEmail", "ReportingToEmail", "ReportToEmail", "ManagerEmailID")
        manager_code = _value(raw, "ManagerCode", "Manager Code", "ReportingManagerCode", "ReportingToCode", "ManagerEmployeeCode", "ReportingToEmployeeCode")
        manager_name = _value(raw, "ManagerName", "Manager Name", "ReportingManagerName", "ReportingToName", "Manager")
        role_name = _value(raw, "RoleName", "Role Name", "Role", "UserRole", "User Type", "UserType", "AccessLevel", "EmployeeRole", "Designation")
        role_id = _value(raw, "RoleID", "RoleId", "UserRoleID", "UserRoleId")
        is_manager_flag = _value(raw, "IsManager", "Is Manager", "ManagerFlag")
        rights = str(role_name or "").strip()
        role_id_string = str(role_id or "").strip().casefold()
        if role_id_string in admin_ids:
            rights = "Admin"
        elif role_id_string in manager_ids and rights.casefold() not in {"admin", "administrator", "superadmin", "super admin"}:
            rights = "Manager"

        employee_code = str(code or "").strip()
        if not email and not employee_code:
            continue
        key = email or ("__code__:" + _canonical(employee_code))
        result[key] = {
            "email": email,
            "employeeName": str(name or "").strip(),
            "employeeCode": str(code or "").strip(),
            "rights": rights,
            "role": str(role_name or rights).strip(),
            "roleId": role_id,
            "isManagerFlag": is_manager_flag,
            "position": str(_value(raw, "Position", "Designation", "JobTitle") or "").strip(),
            "department": str(_value(raw, "Department", "Dept") or "").strip(),
            "mobile": str(_value(raw, "OffMobile", "OfficialMobile", "Mobile", "MobileNo") or "").strip(),
            "managerEmail": str(manager_email or "").strip().casefold(),
            "managerCode": str(manager_code or "").strip(),
            "manager": str(manager_name or "").strip(),
        }

    with _EMPLOYEE_CACHE_LOCK:
        _EMPLOYEE_CACHE.setdefault("entries", {})[cache_key] = {"rows": result, "fetched_at": now}
    return {key: dict(value) for key, value in result.items()}


def employee_sql_status() -> dict[str, Any]:
    """Legacy-named employee check; verifies API access to VM_EmployeeMaster."""
    table = _table_name()
    rows = fetch_table(table)
    return {
        "connected": True,
        "accessMethod": "HTTP SQL API",
        "table": table,
        "rowCount": len(rows),
        **api_configuration(),
    }


def find_employee(identifier: str, employee_master: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Resolve an employee by trusted email or EmployeeCode (case/space insensitive)."""
    needle = str(identifier or "").strip().casefold()
    if not needle or not isinstance(employee_master, dict):
        return None
    direct = employee_master.get(needle)
    if isinstance(direct, dict):
        return dict(direct)
    for key, emp in employee_master.items():
        if not isinstance(emp, dict):
            continue
        if str(key or "").strip().casefold() == needle or str(emp.get("email") or "").strip().casefold() == needle:
            return dict(emp)
        if str(emp.get("employeeCode") or "").strip().casefold() == needle:
            return dict(emp)
    return None


def detect_roles(identifier: str, employee_master: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Derive permissions from VM_EmployeeMaster; never from browser-supplied email."""
    emp = find_employee(identifier, employee_master) or {}
    rights = str(emp.get("rights", emp.get("role", "")) or "").casefold().strip()
    department_key = re.sub(r"[^a-z0-9]", "", str(emp.get("department", "") or "").casefold())
    # Task 360's explicit all-record access rule is department-based.
    is_admin = department_key in {"mdo", "management"}
    manager_flag = re.sub(r"[^a-z0-9]", "", str(emp.get("isManagerFlag", "") or "").casefold())
    # The VM_EmployeeMaster flag is authoritative. Do not infer manager access
    # just because rows happen to point at this employee.
    is_manager = manager_flag in {"1", "y", "yes", "true", "t", "manager"}
    return {
        "isAdmin": is_admin,
        "isManager": is_manager,
        "isDoer": True,
        "email": str(emp.get("email") or ""),
        "employeeName": emp.get("employeeName", ""),
        "managerName": emp.get("manager", ""),
        "employeeCode": emp.get("employeeCode", ""),
        "department": emp.get("department", ""),
    }
