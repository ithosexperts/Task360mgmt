# Task 360 — KPI 360 1 & KPI 360 2 (combined)

This is one FastAPI application serving both dashboard views from a single merged KPI table. **All data access goes through the existing HoseXperts PHP SQL API**; this app does not connect to SQL Server directly.

- `/` or `/kpi2` — KPI 360 2 (task completion)
- `/kpi1` — KPI 360 1 (delay / lead-time dashboard)
- `/api/health` — application and API configuration check
- `/api/db-test` — checks whether the configured API can read the merged KPI table and `VM_EmployeeMaster`
- `/api/debug` — API connectivity and table row-count diagnostics
- `/api/cache/clear` — refreshes shared KPI API data

## API integration

The app uses the same generic table API contract as the existing portals:

```http
GET {API_1_URL or API_2_URL}?action=select&table={TABLE_NAME}&fetchAll=true
Accept: application/json
Authorization: Bearer {API_AUTH_TOKEN}  # sent only when configured
```

Configuration comes from the same environment variable names as the supplied FMS Portal `.env`:

- `API_1_URL`
- `API_2_URL`
- `API_AUTH_TOKEN` (optional)
- `REQUEST_TIMEOUT`
- `ENVIRONMENT`

The supplied `.env` currently points both `API_1_URL` and `API_2_URL` to `apiv2.php`. The code preserves those values in `.env.example`; the active API is separately selected using `KPI_API_BASE`.

`KPI_API_BASE=API_1` is the default and follows the existing portal convention for the `apiv2.php` / Test_OperationsDB path. Set `KPI_API_BASE=API_2` only when `API_2_URL` is configured for the target database that you intend to use. The environment variable `ENVIRONMENT` describes the application deployment and does not automatically override `KPI_API_BASE`.

## Table names

Set `KPI_SQL_TABLE` to the actual merged KPI table name as recognized by the PHP API. The provided workbook lists its column structure but does not identify the table name, so the package intentionally does not guess it. Existing portal table calls commonly pass table names without the `dbo.` prefix; use the naming format expected by your API gateway.

Employee identity is read through the same API from `VM_EmployeeMaster`, using the confirmed columns:

- `OffEmail` — email identity
- `EmployeeCode` — employee code
- `EmployeeName` — display name
- `RoleID` / `RoleName` — role permissions
- `IsManager` — manager flag
- `OffMobile`, `Department`, `Position` — employee details when present

No `EmployeeMaster.json`, Google Drive service-account file, SQL host credentials, `pyodbc`, or SQL Server ODBC driver is required.

## KPI data fields

The merged table is expected to contain the common task columns once (for example `AppID`, `RowID`, `StageNo`, `FMSName`, `StageName`, `DoerCode`, `DoerName`, planned/actual timestamps, and `ManagerCode` / `ManagerChain`) plus KPI-specific columns:

- KPI 360 1: `TaskStatus_KPI01`, `KPI01_Score`, `KPI01_ScoreFactored`
- KPI 360 2: `TaskStatus_KPI02`, `KPI02_Score`, `KPI02_ScoreFactored`

Rows where `KPIApplicable` is `N`, `No`, `0`, or `False` are excluded from both dashboards. Both views share one brief in-process data cache.

## Configuration

For local use, copy `.env.example` to `.env`, set `KPI_SQL_TABLE`, and verify `KPI_API_BASE`. For Render, set the same variables under **Environment**. Do not copy any real tokens/passwords into source control.

Important variables:

```dotenv
API_1_URL=https://api.hosexperts.com:85/apiv2.php
API_2_URL=https://api.hosexperts.com:85/apiv2.php
API_AUTH_TOKEN=
REQUEST_TIMEOUT=15
KPI_API_BASE=API_1
KPI_SQL_TABLE=REPLACE_WITH_MERGED_KPI_TABLE
VM_EMPLOYEE_TABLE=VM_EmployeeMaster
KPI_SQL_CACHE_SECONDS=30
KPI_SQL_MAX_ROWS=100000
VM_EMPLOYEE_CACHE_SECONDS=300
EMPLOYEE_ADMIN_ROLE_IDS=1
EMPLOYEE_MANAGER_ROLE_IDS=
```

`EMPLOYEE_ADMIN_ROLE_IDS` defaults to `1` to match the current package configuration. Confirm that RoleID 1 represents Admin/Superadmin in the API's target database. If the role mapping differs, change the variable. The app resolves a viewer's email against `OffEmail` in `VM_EmployeeMaster`.

## Run locally (Windows PowerShell)

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

Open `http://127.0.0.1:8000/?email=your.employee@company.com` for KPI 360 2 or `http://127.0.0.1:8000/kpi1?email=your.employee@company.com` for KPI 360 1.

## Deployment and security notes

- `render.yaml` and `Dockerfile` deploy the API-consuming app; no direct SQL/ODBC connection setup is present.
- The dashboard still accepts viewer email in a query parameter. A query-string email is not proof of identity. Put this app behind the existing One Portal/SSO flow before exposing staff KPI data publicly.
- `/api/db-test` reads both configured tables via the API so it can confirm connectivity after Render variables and `KPI_SQL_TABLE` are set. Automated tests use mocked API responses; live API/database connectivity must be tested in your deployment.
- `sql/find_merged_kpi_table.sql` is an optional one-time query to run manually in SSMS if you still need to identify the merged table name. The running app does not execute that script or query SQL Server directly.
