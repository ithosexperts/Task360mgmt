import os
import traceback
from typing import Optional
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env", override=True)

from services.api_service import api_configuration
from services.sql_service import load_records, sql_status
from services.employee_service import employee_sql_status
from services.unified_service import get_kpi1_payload, get_kpi2_payload, query_records
from services.stage_form_service import resolve_stage_form_link
from sso_auth import Task360SsoMiddleware, launch_from_one_portal

app = FastAPI(title="Task 360 — KPI 360 1 & 2", version="1.0.0")
app.add_middleware(Task360SsoMiddleware)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.head("/")
async def health_head():
    return HTMLResponse(status_code=200, content="")


@app.post("/auth/launch")
async def auth_launch(request: Request):
    return await launch_from_one_portal(request)


@app.get("/", response_class=HTMLResponse)
async def kpi2_dashboard(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/kpi2", response_class=HTMLResponse)
async def kpi2_alias():
    return RedirectResponse(url="/", status_code=307)


@app.get("/kpi1", response_class=HTMLResponse)
async def kpi1_dashboard(request: Request):
    return templates.TemplateResponse("kpi1.html", {"request": request})


@app.get("/api/health")
async def api_health():
    return {
        "ok": True,
        "application": "Task 360 KPI 360 1 & 2",
        "taskTable": (os.getenv("KPI_SQL_TABLE") or "").strip(),
        "taskTableConfigured": bool((os.getenv("KPI_SQL_TABLE") or "").strip()) and "REPLACE_WITH" not in (os.getenv("KPI_SQL_TABLE") or "").upper(),
        "employeeTable": os.getenv("VM_EMPLOYEE_TABLE", "VM_EmployeeMaster"),
        "api": api_configuration(),
    }


@app.get("/api/db-test")
def api_db_test():
    try:
        task_table = sql_status()
        employee_table = employee_sql_status()
        return {
            "ok": True,
            "accessMethod": "HTTP SQL API (no direct SQL connection)",
            "taskTable": task_table,
            "employeeTable": employee_table,
        }
    except Exception as exc:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(exc)})


@app.get("/api/data")
def get_kpi1_data(request: Request, force: bool = Query(False)):
    try:
        return get_kpi1_payload(str(request.state.employee_code), force=force)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse(status_code=503, content={"error": str(exc), "headers": [], "partitions": {"admin": [], "myTeam": [], "me": []}})


@app.get("/api/payload")
def get_kpi2_data(
    request: Request,
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    force: bool = Query(False),
):
    try:
        return get_kpi2_payload(str(request.state.employee_code), start_date, end_date, force=force)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse(status_code=503, content={"error": str(exc), "headers": [], "partitions": {"admin": [], "myTeam": [], "me": []}, "faultyData": []})


@app.get("/api/stage-link")
def api_stage_form_link(
    record_id: str = Query(..., min_length=1),
    app_id: str = Query(..., min_length=1),
    stage_no: str = Query(..., min_length=1),
):
    """Resolve the configured stage form URL from FMS_Config for one task row."""
    try:
        return resolve_stage_form_link(record_id=record_id, app_id=app_id, stage_no=stage_no)
    except Exception as exc:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(exc)})


@app.get("/api/query")
def query_kpi_data(
    request: Request,
    year: Optional[str] = Query(None),
    month: Optional[str] = Query(None),
    doer: Optional[str] = Query(None),
    fms: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
):
    try:
        rows = query_records(year=year, month=month, doer=doer, fms=fms, stage=stage, status=status, identifier=str(request.state.employee_code))
        return {"total": len(rows), "data": rows}
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse(status_code=503, content={"error": str(exc), "total": 0, "data": []})


@app.get("/api/debug")
def debug_system():
    try:
        return {
            "application": app.title,
            "accessMethod": "HTTP SQL API (no direct SQL connection)",
            "api": api_configuration(),
            "taskTable": sql_status(),
            "employeeTable": employee_sql_status(),
        }
    except Exception as exc:
        return JSONResponse(status_code=503, content={
            "application": app.title,
            "accessMethod": "HTTP SQL API (no direct SQL connection)",
            "api": {"configured": False},
            "error": str(exc),
        })


@app.post("/api/cache/clear")
def clear_cache():
    try:
        # Force a refresh through the shared service cache.
        load_records(force=True)
        return {"ok": True, "message": "Shared SQL API data cache refreshed."}
    except Exception as exc:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(exc)})
