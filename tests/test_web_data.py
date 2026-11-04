import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from scripts import build_web_data as web


def record(code="920309", **changes):
    value = {
        "code": code, "name": "测试股票", "subscription_code": code,
        "subscription_date": "2026-11-04", "listing_date": None,
        "issue_price": 31.92, "subscription_limit": 499700,
        "source_url": "https://data.eastmoney.com/xg/jxc/%s.html" % code,
        "source_name": "东方财富·北交所新股", "subscription_status": "scheduled",
    }
    value.update(changes)
    return value


class WebDataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "schedule.json"
        self.now = datetime(2026, 11, 4, 10, 0, tzinfo=web.BEIJING)

    def tearDown(self):
        self.directory.cleanup()

    def build(self, records=None, **kwargs):
        return web.build(self.path, fetcher=lambda: [record()] if records is None else records, clock=self.now, **kwargs)

    def test_filters_old_complete_history_and_preserves_unknown_and_future_dates(self):
        data = [record(), record("920310", subscription_date="2026-06-01", listing_date="2026-06-12"),
                record("920311", subscription_date="2026-06-01"),
                record("920312", subscription_date="2026-12-01", listing_date="2026-12-10"),
                record("920313", subscription_date=None, subscription_status="suspended")]
        result = self.build(data)
        self.assertEqual({r["code"] for r in result["records"]}, {"920309", "920311", "920312", "920313"})
        self.assertIsNone(next(r for r in result["records"] if r["code"] == "920309")["listing_date"])

    def test_public_payload_never_contains_local_metadata(self):
        result = self.build([record(handled=True, manual=True, client_account="private", notes="private")])
        self.assertEqual(set(result["records"][0]), set(web.PUBLIC_FIELDS))
        self.assertNotIn("private", self.path.read_text())
        self.assertEqual(result["generated_at"], "2026-11-04T10:00:00+08:00")

    def test_empty_refresh_preserves_last_good_timestamp(self):
        old = self.build()
        self.now = self.now.replace(hour=11)
        failed = self.build([])
        self.assertEqual(failed["records"], old["records"])
        self.assertEqual(failed["generated_at"], old["generated_at"])
        self.assertEqual(failed["last_attempt"], "2026-11-04T11:00:00+08:00")
        self.assertTrue(failed["refresh_error"])

    def test_first_failure_without_cache_does_not_publish_empty_file(self):
        with self.assertRaises(RuntimeError):
            self.build([])
        self.assertFalse(self.path.exists())

    def test_prior_deployment_restores_more_recent_cache_without_git_write(self):
        old = self.build()
        remote = dict(old, generated_at="2026-11-04T10:30:00+08:00", records=[record(listing_date="2026-11-10")], handled=["private"])
        self.now = self.now.replace(hour=11)
        result = self.build([], fallback_url="https://example.github.io/app/data/schedule.json", downloader=lambda _: remote)
        self.assertEqual(result["generated_at"], remote["generated_at"])
        self.assertEqual(result["records"][0]["listing_date"], "2026-11-10")
        self.assertNotIn("handled", result)
        self.assertTrue(result["refresh_error"])

    def test_corrupt_or_unavailable_remote_keeps_local_cache(self):
        old = self.build()
        result = self.build([], fallback_url="https://example.github.io/invalid", downloader=lambda _: {"records": []})
        self.assertEqual(result["generated_at"], old["generated_at"])
        self.assertEqual(result["records"], old["records"])

    def test_fresh_success_clears_error_and_does_not_fetch_fallback(self):
        self.build()
        self.build([])
        with patch.object(web, "download_previous", side_effect=AssertionError("not needed")):
            result = self.build(fallback_url="https://example.github.io/data.json")
        self.assertIsNone(result["refresh_error"])

    def test_invalid_source_response_does_not_replace_good_cache(self):
        old = self.build()
        for bad in [record(listing_date="2026-11-03"), record(issue_price=float("nan")), record(source_url="javascript:alert(1)")]:
            with self.subTest(bad=bad):
                result = self.build([bad])
                self.assertEqual(result["records"], old["records"])
                self.assertTrue(result["refresh_error"])

    def test_recent_cutoff_is_inclusive(self):
        cutoff = "2026-07-07"
        records = [record(listing_date=cutoff, subscription_date="2026-07-01"),
                   record("920310", listing_date="2026-07-06", subscription_date="2026-07-01")]
        selected = web.select_records(records, self.now.date())
        self.assertEqual([r["code"] for r in selected], ["920309"])


if __name__ == "__main__":
    unittest.main()
