"""Offline regression tests for calendar integrity and local state handling."""

import copy
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import app
import market_data


def record(**changes):
    result = {
        "code": "920309", "name": "测试股份", "subscription_code": "920309",
        "subscription_date": "2026-11-04", "listing_date": None,
        "issue_price": 31.92, "subscription_limit": 499700,
        "source_url": "https://www.bse.cn/example", "source_name": "测试来源",
    }
    result.update(changes)
    return result


def upstream(**changes):
    result = {
        "SECUCODE": "920309.BJ", "SECURITY_CODE": "920309",
        "SECURITY_NAME_ABBR": "测试股份", "ONLINE_ISSUE_NUM": 8230400,
        "APPLY_CODE": "920309", "APPLY_DATE": "2026-11-04 00:00:00",
        "SELECT_LISTING_DATE": None, "ISSUE_PRICE": 31.92,
        "APPLY_NUM_UPPER": 499700,
    }
    result.update(changes)
    return result


class MarketDataTests(unittest.TestCase):
    def test_missing_listing_date_is_not_inferred(self):
        result = market_data.normalize_record(upstream())
        self.assertIsNone(result["listing_date"])
        self.assertEqual(result["subscription_date"], "2026-11-04")
        self.assertEqual(result["subscription_limit"], 499700)

    def test_suspended_sentinel_is_not_a_future_date(self):
        result = market_data.normalize_record(upstream(APPLY_DATE="9999-12-31 00:00:00"))
        self.assertIsNone(result["subscription_date"])
        self.assertEqual(result["subscription_status"], "suspended")

    def test_other_markets_and_non_online_issues_are_filtered(self):
        for row in [upstream(SECUCODE="600001.SH"), upstream(SECUCODE="001001.SZ"),
                    upstream(ONLINE_ISSUE_NUM=0), upstream(ONLINE_ISSUE_NUM=None)]:
            with self.subTest(row=row):
                self.assertIsNone(market_data.normalize_record(row))

    def test_old_bse_code_uses_exchange_field(self):
        result = market_data.normalize_record(upstream(
            SECUCODE="830001.BJ", SECURITY_CODE="830001", APPLY_CODE="889001"))
        self.assertEqual(result["code"], "830001")
        self.assertEqual(result["subscription_code"], "889001")

    def test_bad_or_backwards_dates_are_rejected(self):
        for changes in [{"APPLY_DATE": "2026-02-30"},
                        {"APPLY_DATE": "2026/11/04"},
                        {"SELECT_LISTING_DATE": "2026-11-03"}]:
            with self.subTest(changes=changes), self.assertRaises(market_data.MarketDataError):
                market_data.normalize_record(upstream(**changes))

    def test_fetch_uses_market_filter_and_preserves_missing_dates(self):
        payload = {"pages": 1, "data": [upstream(), upstream(SECUCODE="600001.SH")]}
        with patch.object(market_data, "_read_page", return_value=payload) as reader:
            result = market_data.fetch_schedule()
        reader.assert_called_once_with(1, 15.0)
        self.assertEqual(len(result), 1)
        self.assertIsNone(result[0]["listing_date"])

    def test_conflicting_duplicate_schedules_are_rejected(self):
        payload = {"pages": 1, "data": [upstream(), upstream(APPLY_DATE="2026-11-05")]}
        with patch.object(market_data, "_read_page", return_value=payload):
            with self.assertRaises(market_data.MarketDataError):
                market_data.fetch_schedule()


class RecordValidationTests(unittest.TestCase):
    def test_invalid_manual_dates_are_rejected(self):
        for changes in [{"subscription_date": None}, {"subscription_date": "2026-02-30"},
                        {"listing_date": "2026-11-03"}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                app.validate_record(record(**changes))

    def test_source_url_rejects_script_schemes(self):
        for url in ["javascript:alert(1)", "data:text/html,hello", "https:", "file:///tmp/test"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                app.validate_record(record(source_url=url))
        self.assertEqual(app.validate_record(record())["source_url"], "https://www.bse.cn/example")

    def test_exported_chinese_csv_round_trips(self):
        original = app.validate_record(record(name="测试，股份", source_name="公告、申购日程"))
        exported = app.export_csv([original])
        self.assertTrue(exported.startswith("\ufeff股票代码,股票名称"))
        imported = app.parse_csv(exported)
        self.assertEqual(imported, [original])

    def test_csv_round_trip_preserves_suspended_and_pending_without_dates(self):
        originals = [app.validate_record(record(
            code=code, subscription_code=code, subscription_date=None,
            listing_date=None, subscription_status=status,
        ), require_subscription=False) for code, status in
            [("920310", "suspended"), ("920311", "pending")]]
        imported = app.parse_csv(app.export_csv(originals))
        self.assertEqual(imported, originals)
        self.assertTrue(all(r["subscription_date"] is None and r["listing_date"] is None
                            for r in imported))

    def test_formula_text_is_escaped_on_csv_export(self):
        exported = app.export_csv([record(name="=HYPERLINK(\"https://example.com\")")])
        self.assertIn("'=HYPERLINK", exported)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "state.json"
        self.store = app.Store(self.path)
        self.fixed_time = datetime(2026, 11, 4, 10, 0, tzinfo=app.BEIJING)
        self.clock = patch.object(app, "now", return_value=self.fixed_time)
        self.clock.start()
        self.store.refresh(lambda: [record()])

    def tearDown(self):
        self.clock.stop()
        self.directory.cleanup()

    def test_failed_or_empty_refresh_preserves_cache_and_timestamp(self):
        baseline = self.store.snapshot()

        def unavailable():
            raise market_data.MarketDataError("offline")

        for fetcher in [unavailable, lambda: []]:
            with self.subTest(fetcher=fetcher):
                result = self.store.refresh(fetcher)
                self.assertEqual(result["records"], baseline["records"])
                self.assertEqual(result["last_refresh"], baseline["last_refresh"])
                self.assertIn("刷新失败", result["refresh_error"])
                self.assertFalse(result["refreshing"])
                self.assertEqual(app.Store(self.path).snapshot()["records"], baseline["records"])

    def test_bad_success_response_preserves_cache(self):
        baseline = copy.deepcopy(self.store.snapshot()["records"])
        self.store.refresh(lambda: [record(listing_date="2026-11-03")])
        self.assertEqual(self.store.snapshot()["records"], baseline)
        self.assertIsNotNone(self.store.snapshot()["refresh_error"])

    def test_manual_override_survives_refresh_and_can_be_reverted(self):
        self.store.mutate("/api/record", record(listing_date="2026-11-12"))
        refreshed = self.store.refresh(lambda: [record(listing_date="2026-11-13")])
        self.assertEqual(refreshed["records"][0]["listing_date"], "2026-11-12")
        self.assertTrue(refreshed["records"][0]["manual"])
        reverted = self.store.mutate("/api/record/delete", {"code": "920309"})
        self.assertEqual(reverted["records"][0]["listing_date"], "2026-11-13")
        self.assertFalse(reverted["records"][0]["manual"])

    def test_date_change_does_not_mark_new_event_handled(self):
        old_id = "920309:subscription:2026-11-04"
        self.store.mutate("/api/handled", {"id": old_id, "handled": True})
        updated = self.store.refresh(lambda: [record(subscription_date="2026-11-05")])
        self.assertNotIn("920309:subscription:2026-11-05", updated["handled"])
        with self.assertRaises(ValueError):
            self.store.mutate("/api/handled", {"id": old_id, "handled": False})
        self.store.mutate("/api/handled", {"id": "920309:subscription:2026-11-05", "handled": True})

    def test_no_listing_event_exists_without_listing_date(self):
        with self.assertRaises(ValueError):
            self.store.mutate("/api/handled", {"id": "920309:listing:2026-11-12", "handled": True})
        suspended = market_data.normalize_record(upstream(APPLY_DATE="9999-12-31"))
        result = self.store.refresh(lambda: [suspended])
        self.assertIsNone(result["records"][0]["subscription_date"])
        with self.assertRaises(ValueError):
            self.store.mutate("/api/handled", {"id": "920309:subscription:9999-12-31", "handled": True})

    def test_csv_import_failure_is_atomic(self):
        self.store.mutate("/api/record", record())
        before_data = copy.deepcopy(self.store.data)
        before_file = self.path.read_bytes()
        bad_csv = app.export_csv([record(code="920310"), record(code="920311", subscription_date="2026-02-30")])
        with self.assertRaisesRegex(ValueError, "第 3 行"):
            self.store.mutate("/api/import", {"csv": bad_csv})
        self.assertEqual(self.store.data, before_data)
        self.assertEqual(self.path.read_bytes(), before_file)

    def test_demo_records_and_handled_state_are_isolated(self):
        live_id = "920309:subscription:2026-11-04"
        self.store.mutate("/api/handled", {"id": live_id, "handled": True})
        live_records = self.store.snapshot()["records"]
        demo = self.store.mutate("/api/mode", {"mode": "demo"})
        self.assertNotIn(live_id, demo["handled"])
        self.assertTrue(all(r["source_name"] == "虚构演示数据" for r in demo["records"]))
        demo_id = "920001:subscription:2026-11-04"
        self.store.mutate("/api/handled", {"id": demo_id, "handled": True})
        with self.assertRaises(ValueError):
            self.store.mutate("/api/record", record())
        live = self.store.mutate("/api/mode", {"mode": "live"})
        self.assertEqual(live["records"], live_records)
        self.assertEqual(live["handled"], [live_id])
        self.assertNotIn(demo_id, live["handled"])

    def test_shanghai_date_does_not_follow_brisbane_midnight(self):
        # At 00:30 in Brisbane it is still the preceding day in Shanghai.
        brisbane = datetime(2026, 11, 5, 0, 30, tzinfo=ZoneInfo("Australia/Brisbane"))
        shanghai = brisbane.astimezone(app.BEIJING)
        with patch.object(app, "now", return_value=shanghai):
            state = self.store.snapshot()
        self.assertEqual(state["today"], "2026-11-04")
        self.assertEqual(state["timezone"], "Asia/Shanghai")
        self.assertTrue(state["now"].endswith("+08:00"))


if __name__ == "__main__":
    unittest.main()
