import unittest

from services.unified_service import (
    KPI1_HEADERS,
    KPI2_HEADERS,
    _group_summaries,
    kpi1_row,
    kpi1_status,
    kpi2_row,
    kpi2_status,
)


class SqlRowMappingTests(unittest.TestCase):
    def setUp(self):
        self.sample = {
            "KPIRecordKey": "APP000001_1_S1",
            "InsertTS": "2026-10-21 09:00:00",
            "AppID": "APP000001",
            "RowID": 1,
            "StageNo": "S1",
            "FMSName": "Pack to Dispatch Details",
            "StageName": "S1_Pick N Pack",
            "DoerCode": 17,
            "DoerName": "Bhupal Singh",
            "ScoreYear": 2026,
            "ScoreMonth": 10,
            "ScoreWeekNo": 41,
            "ScoreDayNo": 2,
            "PLTimeStamp": "2026-10-21 10:00:00",
            "LeadTimeMins": 60,
            "ALTimeStamp": "2026-10-21 11:30:00",
            "DelayMins": 30,
            "PresenceFactor": 1,
            "TaskStatus_KPI01": "Completed",
            "KPI01_Score": 75,
            "KPI01_ScoreFactored": 0.75,
            "TaskStatus_KPI02": "Completed",
            "KPI02_Score": 80,
            "KPI02_ScoreFactored": 0.8,
            "LastSyncTS": None,
            "KPIApplicable": "Y",
            "TaskGroupID": 26,
            "ManagerCode": None,
            "ManagerName": None,
            "ManagerChain": None,
        }

    def test_kpi1_output_shape_and_hours(self):
        row = kpi1_row(self.sample)
        self.assertEqual(len(row), len(KPI1_HEADERS))
        self.assertEqual(row[3], 1.0)
        self.assertEqual(row[7], 0.5)
        self.assertEqual(row[8], "Done-Delayed")
        self.assertEqual(row[12], 75)
        self.assertEqual(row[13], 0.75)

    def test_kpi2_output_shape_and_score_fields(self):
        summary = _group_summaries([self.sample])
        row = kpi2_row(self.sample, summary)
        self.assertEqual(len(row), len(KPI2_HEADERS))
        self.assertEqual(row[6], "Finished")
        self.assertEqual(row[10:13], [1, 1, 80])
        self.assertEqual(row[14], 0.8)

    def test_kpi2_combined_payload_appends_kpi1_and_manager_fields(self):
        record = dict(self.sample, ManagerCode="0017")
        row = kpi2_row(record, _group_summaries([record]))
        self.assertEqual(len(row), len(KPI2_HEADERS))
        appended = row[-6:]
        self.assertEqual(appended, [1.0, "0017", 75, 0.75, "Done-Delayed", 1])
        self.assertEqual(KPI2_HEADERS[-6:], [
            "Lead Time", "Manager Code", "KPI01 Score", "KPI 1 Factored Score",
            "KPI 1 Task Status", "Task Completion Rate KPI Weightage",
        ])

    def test_kpi_status_mapping(self):
        self.assertEqual(kpi1_status(self.sample), "Done-Delayed")
        self.assertEqual(kpi2_status(self.sample), "Finished")
        row = dict(self.sample, TaskStatus_KPI01="Planned", TaskStatus_KPI02="Planned")
        self.assertEqual(kpi1_status(row), "Planned")
        self.assertEqual(kpi2_status(row), "Awaited")
        row["TaskStatus_KPI02"] = "Not Done"
        self.assertEqual(kpi2_status(row), "Deferred")


if __name__ == "__main__":
    unittest.main()
