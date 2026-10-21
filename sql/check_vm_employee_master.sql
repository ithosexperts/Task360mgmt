/* Confirm the SQL employee view/table and inspect its column names. */
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'VM_EmployeeMaster'
ORDER BY TABLE_SCHEMA, ORDINAL_POSITION;

/* Optional: verify the view is queryable and count available employee rows. */
SELECT COUNT_BIG(1) AS EmployeeRowCount
FROM dbo.VM_EmployeeMaster;
