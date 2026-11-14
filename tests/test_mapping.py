import sys
from unittest.mock import MagicMock
if "httpx" not in sys.modules:
    sys.modules["httpx"] = MagicMock()

from datetime import date, datetime
import unittest

from services.unified_service import (
    KPI1_HEADERS,
    KPI2_HEADERS,
    _group_summaries,
    fmt_effective_timestamp,
    get_effective_timestamp,
    is_task_current_or_pending,
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
            "ReleaseTS": None,
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
        self.assertEqual(row[3], "01:00:00")
        self.assertEqual(row[4], "21-Oct-2026 10:00")
        self.assertEqual(row[7], 0.5)
        self.assertEqual(row[8], "Done-Delayed")
        self.assertEqual(row[12], 75)
        self.assertEqual(row[13], 0.75)

    def test_kpi2_output_shape_and_score_fields(self):
        summary = _group_summaries([self.sample])
        row = kpi2_row(self.sample, summary)
        self.assertEqual(len(row), len(KPI2_HEADERS))
        self.assertEqual(row[3], "21-Oct-2026 10:00")
        self.assertEqual(row[6], "Finished")
        self.assertEqual(row[10:13], [1, 1, 80])
        self.assertEqual(row[14], 0.8)

    def test_kpi2_combined_payload_appends_kpi1_and_manager_fields(self):
        record = dict(self.sample, ManagerCode="0017")
        row = kpi2_row(record, _group_summaries([record]))
        self.assertEqual(len(row), len(KPI2_HEADERS))
        self.assertEqual(row[23], "01:00:00")
        self.assertEqual(row[24], "0017")
        self.assertEqual(row[25], 75)
        self.assertEqual(row[26], 0.75)
        self.assertEqual(row[27], "Done-Delayed")

    def test_kpi_status_mapping(self):
        self.assertEqual(kpi1_status(self.sample), "Done-Delayed")
        self.assertEqual(kpi2_status(self.sample), "Finished")
        row = dict(self.sample, TaskStatus_KPI01="Planned", TaskStatus_KPI02="Planned")
        self.assertEqual(kpi1_status(row), "Planned")
        self.assertEqual(kpi2_status(row), "Awaited")
        row["TaskStatus_KPI02"] = "Not Done"
        self.assertEqual(kpi2_status(row), "Deferred")

    def test_effective_timestamp_precedence(self):
        # Case 1: ReleaseTS is null and PLTimeStamp is not null -> uses PLTimeStamp
        row1 = {"PLTimeStamp": "2026-11-14 10:00:00", "ReleaseTS": None}
        self.assertEqual(get_effective_timestamp(row1), datetime(2026, 11, 14, 10, 0, 0))
        self.assertEqual(fmt_effective_timestamp(row1), "14-Nov-2026 10:00")

        # Case 2: ReleaseTS is populated -> uses ReleaseTS (even if PLTimeStamp differs)
        row2 = {"PLTimeStamp": "2026-11-20 10:00:00", "ReleaseTS": "2026-11-14 11:30:00"}
        self.assertEqual(get_effective_timestamp(row2), datetime(2026, 11, 14, 11, 30, 0))
        self.assertEqual(fmt_effective_timestamp(row2), "14-Nov-2026 11:30")

        # Case 3: ReleaseTS is "NULL" string or empty -> falls back to PLTimeStamp
        row3 = {"PLTimeStamp": "2026-11-14 09:00:00", "ReleaseTS": "NULL"}
        self.assertEqual(get_effective_timestamp(row3), datetime(2026, 11, 14, 9, 0, 0))
        self.assertEqual(fmt_effective_timestamp(row3), "14-Nov-2026 09:00")

        # Case 4: Both are null -> returns None
        row4 = {"PLTimeStamp": None, "ReleaseTS": None}
        self.assertIsNone(get_effective_timestamp(row4))
        self.assertEqual(fmt_effective_timestamp(row4), "")

    def test_kpi_rows_display_effective_timestamp(self):
        # When ReleaseTS is populated, both kpi1_row and kpi2_row show ReleaseTS in Planned column
        rec = dict(self.sample, PLTimeStamp="2026-10-21 10:00:00", ReleaseTS="2026-10-21 14:00:00")
        row1 = kpi1_row(rec)
        self.assertEqual(row1[4], "21-Oct-2026 14:00")
        row2 = kpi2_row(rec, _group_summaries([rec]))
        self.assertEqual(row2[3], "21-Oct-2026 14:00")

    def test_current_and_pending_tasks_filtering(self):
        today = date(2026, 11, 14)

        # 1. Today's task by PLTimeStamp (ReleaseTS is null) -> SHOWN
        task_today_pl = {"PLTimeStamp": "2026-11-14 16:00:00", "ReleaseTS": None}
        self.assertTrue(is_task_current_or_pending(task_today_pl, today=today))

        # 2. Pending/past task by PLTimeStamp (ReleaseTS is null) -> SHOWN
        task_past_pl = {"PLTimeStamp": "2026-11-10 10:00:00", "ReleaseTS": None}
        self.assertTrue(is_task_current_or_pending(task_past_pl, today=today))

        # 3. Future task by PLTimeStamp (ReleaseTS is null) -> EXCLUDED
        task_future_pl = {"PLTimeStamp": "2026-11-15 09:00:00", "ReleaseTS": None}
        self.assertFalse(is_task_current_or_pending(task_future_pl, today=today))

        # 4. Today's task by ReleaseTS (PLTimeStamp in future) -> SHOWN (evaluated per ReleaseTS)
        task_today_rel = {"PLTimeStamp": "2026-11-20 10:00:00", "ReleaseTS": "2026-11-14 11:00:00"}
        self.assertTrue(is_task_current_or_pending(task_today_rel, today=today))

        # 5. Pending/past task by ReleaseTS (PLTimeStamp in future) -> SHOWN (evaluated per ReleaseTS)
        task_past_rel = {"PLTimeStamp": "2026-11-20 10:00:00", "ReleaseTS": "2026-11-12 11:00:00"}
        self.assertTrue(is_task_current_or_pending(task_past_rel, today=today))

        # 6. Future task by ReleaseTS (PLTimeStamp today) -> EXCLUDED (evaluated per ReleaseTS)
        task_future_rel = {"PLTimeStamp": "2026-11-14 10:00:00", "ReleaseTS": "2026-11-16 11:00:00"}
        self.assertFalse(is_task_current_or_pending(task_future_rel, today=today))

        # 7. No timestamp -> not treated as future -> SHOWN
        task_no_ts = {"PLTimeStamp": None, "ReleaseTS": None}
        self.assertTrue(is_task_current_or_pending(task_no_ts, today=today))


if __name__ == "__main__":
    unittest.main()
