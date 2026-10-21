/*
Find the merged SQL table from DD1.xlsx by its shared and KPI-specific columns.
Run this in the target SQL Server database. Set KPI_SQL_TABLE to the returned
schema/table pair, e.g. dbo.KPIRecord360.
*/
SELECT
    c.TABLE_SCHEMA AS SchemaName,
    c.TABLE_NAME AS TableName,
    COUNT(DISTINCT c.COLUMN_NAME) AS MatchedColumns
FROM INFORMATION_SCHEMA.COLUMNS AS c
WHERE c.COLUMN_NAME IN (
    'KPIRecordKey',
    'AppID',
    'DoerCode',
    'DoerName',
    'TaskStatus_KPI01',
    'KPI01_Score',
    'KPI01_ScoreFactored',
    'TaskStatus_KPI02',
    'KPI02_Score',
    'KPI02_ScoreFactored',
    'KPIApplicable',
    'ManagerCode',
    'ManagerChain'
)
GROUP BY c.TABLE_SCHEMA, c.TABLE_NAME
HAVING
    MAX(CASE WHEN c.COLUMN_NAME = 'KPIRecordKey' THEN 1 ELSE 0 END) = 1
    AND MAX(CASE WHEN c.COLUMN_NAME = 'TaskStatus_KPI01' THEN 1 ELSE 0 END) = 1
    AND MAX(CASE WHEN c.COLUMN_NAME = 'TaskStatus_KPI02' THEN 1 ELSE 0 END) = 1
ORDER BY MatchedColumns DESC, c.TABLE_SCHEMA, c.TABLE_NAME;

/* After identifying the table, inspect its full column list using:

SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'YourMergedKpiTable'
ORDER BY ORDINAL_POSITION;
*/
