"""Resolve configured stage-form links from FMS_Config using the shared SQL API."""
from __future__ import annotations

import os
import re
import threading
import time
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit, urlunsplit

from services.api_service import fetch_table

_CONFIG_CACHE: dict[str, Any] = {"fetched_at": 0.0, "rows": None}
_CONFIG_LOCK = threading.Lock()


def _norm_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def _pick(row: dict[str, Any], *aliases: str) -> Any:
    lookup = {_norm_key(key): value for key, value in row.items()}
    for alias in aliases:
        value = lookup.get(_norm_key(alias))
        if value is not None and str(value).strip() and str(value).strip().casefold() not in {"null", "none"}:
            return value
    return None


def _normalize_app_id(value: Any) -> str:
    return str(value or "").strip().casefold()


def _normalize_stage(value: Any) -> str:
    stage = str(value or "").strip().casefold()
    stage = re.sub(r"^stage\s*", "", stage)
    stage = re.sub(r"^s\s*", "", stage)
    # Treat S01 and 1 as the same stage while preserving non-numeric stage names.
    if stage.isdigit():
        return str(int(stage))
    return re.sub(r"\s+", "", stage)


def _config_rows(force: bool = False) -> list[dict[str, Any]]:
    ttl = max(0, int(os.getenv("FMS_CONFIG_CACHE_SECONDS", "60")))
    now = time.time()
    with _CONFIG_LOCK:
        cached = _CONFIG_CACHE.get("rows")
        if not force and isinstance(cached, list) and now - float(_CONFIG_CACHE.get("fetched_at", 0)) < ttl:
            return [dict(row) for row in cached]

    table = (os.getenv("FMS_CONFIG_TABLE") or "FMS_Config").strip()
    rows = fetch_table(table)
    with _CONFIG_LOCK:
        _CONFIG_CACHE["rows"] = [dict(row) for row in rows]
        _CONFIG_CACHE["fetched_at"] = now
    return [dict(row) for row in rows]


def _default_template() -> str:
    """Build a fallback URL without silently sending production users to localhost."""
    template = (os.getenv("FMS_STAGE_FORM_LINK_TEMPLATE") or "").strip()
    if template:
        return template

    origin = (os.getenv("FMS_STAGE_FORM_ORIGIN") or "").strip().rstrip("/")
    if origin:
        return f"{origin}/forms/stage/{{TASK_ID}}/{{STAGE_NO}}?app_id={{APP_ID}}"

    environment = (os.getenv("ENVIRONMENT") or "").strip().casefold()
    if environment in {"production", "prod"}:
        raise RuntimeError(
            "Stage form URL is not configured. Add a public StageFormLink in FMS_Config, "
            "or set FMS_STAGE_FORM_ORIGIN / FMS_STAGE_FORM_LINK_TEMPLATE in Render to the "
            "public FMS Portal URL. Localhost URLs cannot be opened from users' browsers."
        )

    # Local-development fallback only. Production must use a public FMS Portal URL.
    return "http://127.0.0.1:8001/forms/stage/{TASK_ID}/{STAGE_NO}?app_id={APP_ID}"


def build_stage_form_url(template: str, record_id: str, app_id: str, stage_no: str) -> str:
    """Fill configured placeholders and make stage/app query values match the task row."""
    template = str(template or "").strip() or _default_template()
    record = quote(str(record_id).strip(), safe="")
    app = str(app_id).strip()
    stage = quote(str(stage_no).strip(), safe="")

    replacements = {
        "TASK_ID": record, "TASKID": record, "RECORD_ID": record, "RECORDID": record, "ROW_ID": record, "ROWID": record,
        "APP_ID": quote(app, safe=""), "APPID": quote(app, safe=""),
        "STAGE_NO": stage, "STAGENO": stage, "STAGE": stage,
    }

    def replace_token(match: re.Match[str]) -> str:
        token = re.sub(r"[^A-Z0-9]", "", match.group(1).upper())
        return replacements.get(token, match.group(0))

    expanded = re.sub(r"\{\s*([A-Za-z0-9_ ]+)\s*\}", replace_token, template)
    parts = urlsplit(expanded)
    if not parts.scheme or not parts.netloc:
        origin = (os.getenv("FMS_STAGE_FORM_ORIGIN") or "http://127.0.0.1:8001").strip().rstrip("/") + "/"
        expanded = urljoin(origin, expanded.lstrip("/"))
        parts = urlsplit(expanded)

    path = parts.path or "/"
    stage_path = re.search(r"(?i)/forms/stage(?:/|$)", path)
    if stage_path:
        prefix = path[:stage_path.start()]
        path = f"{prefix}/forms/stage/{record}/{stage}"

    query_items = parse_qsl(parts.query, keep_blank_values=True)
    has_app_id = False
    has_stage_no = False
    normalized_query: list[tuple[str, str]] = []
    for key, value in query_items:
        nk = _norm_key(key)
        if nk in {"appid", "applicationid"}:
            normalized_query.append((key, app))
            has_app_id = True
        elif nk in {"stageno", "stage"}:
            normalized_query.append((key, str(stage_no).strip()))
            has_stage_no = True
        elif nk in {"taskid", "recordid", "rowid"}:
            normalized_query.append((key, str(record_id).strip()))
        else:
            normalized_query.append((key, value))
    if not has_app_id:
        normalized_query.append(("app_id", app))
    # Keep stage_no in the URL only if the configured link already expects it;
    # the user's route pattern identifies the stage in the path.
    query = urlencode(normalized_query, doseq=True)
    final_url = urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    if parts.scheme.casefold() not in {"http", "https"}:
        raise ValueError("StageFormLink must use HTTP or HTTPS.")

    environment = (os.getenv("ENVIRONMENT") or "").strip().casefold()
    hostname = (urlsplit(final_url).hostname or "").casefold()
    if environment in {"production", "prod"} and hostname in {"localhost", "127.0.0.1", "0.0.0.0"}:
        raise RuntimeError(
            "The resolved StageFormLink points to localhost. Configure StageFormLink in FMS_Config "
            "or set FMS_STAGE_FORM_ORIGIN / FMS_STAGE_FORM_LINK_TEMPLATE to the public FMS Portal URL."
        )
    return final_url


def resolve_stage_form_link(record_id: str, app_id: str, stage_no: str) -> dict[str, Any]:
    """Find the matching FMS_Config row and return its resolved StageFormLink."""
    record_id = str(record_id or "").strip()
    app_id = str(app_id or "").strip()
    stage_no = str(stage_no or "").strip()
    if not record_id or not app_id or not stage_no:
        raise ValueError("Record #, App ID, and Stage No are required to open the stage form.")

    rows = _config_rows()
    app_matches: list[dict[str, Any]] = []
    exact_matches: list[dict[str, Any]] = []
    for row in rows:
        config_app = _pick(row, "App_ID", "AppID", "App Id", "Application_ID", "ApplicationID", "FMS_AppID")
        if _normalize_app_id(config_app) != _normalize_app_id(app_id):
            continue
        app_matches.append(row)
        config_stage = _pick(row, "Stage_No", "StageNo", "Stage No", "Stage_Number", "StageNumber", "Stage")
        if config_stage is not None and _normalize_stage(config_stage) == _normalize_stage(stage_no):
            exact_matches.append(row)

    selected: dict[str, Any] | None = exact_matches[0] if len(exact_matches) == 1 else None
    if len(exact_matches) > 1:
        links = {str(_pick(r, "StageFormLink", "Stage_Form_Link", "Stage Form Link", "StageFormURL", "StageFormUrl") or "").strip() for r in exact_matches}
        if len(links) == 1:
            selected = exact_matches[0]
        else:
            raise RuntimeError(f"FMS_Config has multiple conflicting StageFormLink rows for App ID {app_id}, Stage No {stage_no}.")
    if selected is None and not exact_matches:
        # Some installations configure one application-level link; accept it only when unambiguous.
        stage_unspecified = [r for r in app_matches if _pick(r, "Stage_No", "StageNo", "Stage No", "Stage_Number", "StageNumber", "Stage") is None]
        if len(stage_unspecified) == 1:
            selected = stage_unspecified[0]

    if selected is None:
        raise RuntimeError(f"No matching FMS_Config row found for App ID {app_id} and Stage No {stage_no}.")

    link = _pick(selected, "StageFormLink", "Stage_Form_Link", "Stage Form Link", "StageFormURL", "StageFormUrl", "Stage_Form_URL", "FormLink")
    link = str(link or _default_template()).strip()
    url = build_stage_form_url(link, record_id, app_id, stage_no)
    return {
        "ok": True,
        "url": url,
        "recordId": record_id,
        "appId": app_id,
        "stageNo": stage_no,
        "configTable": (os.getenv("FMS_CONFIG_TABLE") or "FMS_Config").strip(),
    }
