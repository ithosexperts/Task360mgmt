import os
import unittest
from unittest.mock import patch

from services.sql_service import load_records


class ApiKpiServiceTests(unittest.TestCase):
    @patch.dict(os.environ, {"KPI_SQL_TABLE": "KPI_Merged", "KPI_SQL_CACHE_SECONDS": "0", "KPI_SQL_MAX_ROWS": "100"})
    @patch("services.sql_service.fetch_table")
    def test_load_records_uses_api_and_filters_inapplicable_rows(self, fetch_table_mock):
        fetch_table_mock.return_value = [
            {"RowID": 1, "KPIApplicable": "Y", "TaskStatus_KPI01": "Done"},
            {"RowID": 2, "KPIApplicable": "N", "TaskStatus_KPI01": "Done"},
        ]
        rows = load_records(force=True)
        fetch_table_mock.assert_called_once_with("KPI_Merged")
        self.assertEqual([row["RowID"] for row in rows], [1])


if __name__ == "__main__":
    unittest.main()
