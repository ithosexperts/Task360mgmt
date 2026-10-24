import os
import unittest
from unittest.mock import patch

from services.employee_service import _value, detect_roles, read_employee_master


class EmployeeServiceTests(unittest.TestCase):
    def test_column_name_variants_are_normalized(self):
        row = {"Employee Code": " E017 ", "Email_ID": "worker@example.com", "OffEmail": "off@example.com"}
        self.assertEqual(_value(row, "EmployeeCode"), " E017 ")
        self.assertEqual(_value(row, "EmailID"), "worker@example.com")
        self.assertEqual(_value(row, "OffEmail"), "off@example.com")

    def test_manager_detected_from_employee_hierarchy(self):
        master = {
            "manager@example.com": {
                "employeeName": "Manager Name", "employeeCode": "M01", "rights": "User",
                "managerEmail": "", "managerCode": "", "manager": "", "isManagerFlag": "Y",
            },
            "worker@example.com": {
                "employeeName": "Worker Name", "employeeCode": "E01", "rights": "User",
                "managerEmail": "manager@example.com", "managerCode": "M01", "manager": "Manager Name",
            },
        }
        role = detect_roles("manager@example.com", master)
        self.assertTrue(role["isManager"])
        self.assertFalse(role["isAdmin"])
        self.assertEqual(role["employeeName"], "Manager Name")

    def test_role_id_one_gets_admin_access(self):
        master = {
            "admin@example.com": {
                "employeeName": "Admin", "employeeCode": "A01", "roleId": 1,
                "department": "SCM", "isManagerFlag": "N",
            }
        }
        self.assertTrue(detect_roles("admin@example.com", master)["isAdmin"])

    def test_mdo_and_management_departments_get_admin_access(self):
        for department in ("MDO", "Management"):
            with self.subTest(department=department):
                master = {"admin@example.com": {
                    "employeeName": "Admin", "employeeCode": "A01", "roleId": 4,
                    "department": department, "isManagerFlag": "N",
                }}
                self.assertTrue(detect_roles("admin@example.com", master)["isAdmin"])

    def test_regular_user_gets_me_access_without_matching_task_rows(self):
        master = {"user@example.com": {
            "employeeName": "User", "employeeCode": "U01", "roleId": 4,
            "department": "SCM", "isManagerFlag": "N",
        }}
        role = detect_roles("user@example.com", master)
        self.assertFalse(role["isAdmin"])
        self.assertFalse(role["isManager"])
        self.assertTrue(role["isDoer"])

    @patch.dict(os.environ, {
        "VM_EMPLOYEE_TABLE": "VM_EmployeeMaster",
        "VM_EMPLOYEE_CACHE_SECONDS": "0",
        "EMPLOYEE_ADMIN_ROLE_IDS": "1",
    })
    @patch("services.employee_service.fetch_table")
    def test_employee_master_is_loaded_through_api(self, fetch_table_mock):
        fetch_table_mock.return_value = [{
            "OffEmail": "admin@example.com",
            "EmployeeName": "Admin Name",
            "EmployeeCode": "A01",
            "RoleID": 1,
            "RoleName": "Super Admin",
            "IsManager": "N",
            "Position": "Admin",
        }]

        master = read_employee_master(force=True)

        fetch_table_mock.assert_called_once_with("VM_EmployeeMaster")
        self.assertEqual(master["admin@example.com"]["employeeCode"], "A01")
        self.assertEqual(master["admin@example.com"]["rights"], "Admin")
        self.assertEqual(master["admin@example.com"]["position"], "Admin")
        self.assertEqual(master["admin@example.com"]["isManagerFlag"], "N")

    def test_is_manager_flag_from_vm_employee_master(self):
        master = {
            "manager@example.com": {
                "employeeName": "Manager Name", "employeeCode": "M01", "rights": "User",
                "managerEmail": "", "managerCode": "", "manager": "", "isManagerFlag": "Y",
            }
        }
        role = detect_roles("manager@example.com", master)
        self.assertTrue(role["isManager"])
        self.assertFalse(role["isAdmin"])


if __name__ == "__main__":
    unittest.main()
