import os
import unittest
from unittest.mock import MagicMock, patch

from services.api_service import _extract_rows, fetch_table


class ApiServiceTests(unittest.TestCase):
    def test_extract_rows_from_standard_wrapper(self):
        self.assertEqual(_extract_rows({"success": True, "data": [{"EmployeeCode": "E01"}]}), [{"EmployeeCode": "E01"}])

    def test_extract_rows_from_nested_wrapper(self):
        self.assertEqual(_extract_rows([{"rows": [{"RowID": 1}, {"RowID": 2}]}]), [{"RowID": 1}, {"RowID": 2}])

    @patch.dict(os.environ, {
        "API_1_URL": "https://api.example.test/apiv2.php",
        "API_2_URL": "https://api.example.test/apiv3.php",
        "KPI_API_BASE": "API_1",
        "API_AUTH_TOKEN": "test-token",
        "REQUEST_TIMEOUT": "15",
    })
    @patch("services.api_service.httpx.Client")
    def test_fetch_table_uses_existing_gateway_contract(self, client_class):
        client = MagicMock()
        client_class.return_value.__enter__.return_value = client
        response = MagicMock()
        response.json.return_value = {"data": [{"RowID": 7, "AppID": "APP000007"}]}
        response.text = ""
        client.get.return_value = response

        rows = fetch_table("KPI_Merged")

        self.assertEqual(rows, [{"RowID": 7, "AppID": "APP000007"}])
        client.get.assert_called_once_with(
            "https://api.example.test/apiv2.php",
            params={"action": "select", "table": "KPI_Merged", "fetchAll": "true"},
            headers={"Accept": "application/json", "Authorization": "Bearer test-token"},
        )

    @patch.dict(os.environ, {
        "API_1_URL": "https://api.example.test/apiv2.php",
        "KPI_API_BASE": "API_1",
        "REQUEST_TIMEOUT": "15",
        "API_AUTH_TOKEN": "",
    })
    @patch("services.api_service.httpx.Client")
    def test_fetch_table_propagates_http_failure(self, client_class):
        client = MagicMock()
        client_class.return_value.__enter__.return_value = client
        response = MagicMock()
        response.status_code = 500
        response.text = "upstream failed"
        import httpx
        client.get.return_value = response
        response.raise_for_status.side_effect = httpx.HTTPStatusError("bad", request=MagicMock(), response=response)

        with self.assertRaisesRegex(RuntimeError, "HTTP 500"):
            fetch_table("KPI_Merged")


if __name__ == "__main__":
    unittest.main()
