#!/usr/bin/env python3
"""Publish only public BSE calendar data for a static GitHub Pages app.

The previous deployed JSON can be used as a fallback without repository write
permissions. Personal records, handled events, and local app state are never read.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from market_data import SOURCE_NAME, SOURCE_URL, fetch_schedule  # noqa: E402

BEIJING = ZoneInfo("Asia/Shanghai")
MAX_BYTES = 2_000_000
PUBLIC_FIELDS = (
    "code", "name", "subscription_code", "subscription_date", "listing_date",
    "issue_price", "subscription_limit", "source_url", "source_name", "subscription_status",
)


def parse_date(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("无效日程日期")
    return date.fromisoformat(value)


def parse_timestamp(value):
    if not isinstance(value, str):
        raise ValueError("缺少成功更新时间")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("更新时间缺少时区")
    return stamp.astimezone(BEIJING)


def public_record(raw):
    if not isinstance(raw, dict):
        raise ValueError("日程记录格式异常")
    record = {key: raw.get(key) for key in PUBLIC_FIELDS}
    if not isinstance(record["code"], str) or not re.fullmatch(r"\d{6}", record["code"]):
        raise ValueError("股票代码格式异常")
    if not isinstance(record["name"], str) or not record["name"].strip() or len(record["name"]) > 80:
        raise ValueError("股票名称格式异常")
    if record["subscription_code"] is not None and not re.fullmatch(r"\d{6}", str(record["subscription_code"])):
        raise ValueError("申购代码格式异常")
    sub, listing = parse_date(record["subscription_date"]), parse_date(record["listing_date"])
    if sub and listing and listing < sub:
        raise ValueError("上市日期早于申购日期")
    for key in ("issue_price", "subscription_limit"):
        val = record[key]
        if val is not None and (isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val <= 0):
            raise ValueError("发行数字格式异常")
    if record["subscription_limit"] is not None and int(record["subscription_limit"]) != record["subscription_limit"]:
        raise ValueError("申购上限须为整数股数")
    if record["subscription_status"] not in ("scheduled", "pending", "suspended"):
        raise ValueError("申购状态格式异常")
    source = urlparse(record["source_url"] or "")
    if source.scheme not in ("https", "http") or not source.netloc:
        raise ValueError("数据来源链接格式异常")
    record["source_name"] = str(record["source_name"] or SOURCE_NAME)[:120]
    return record


def select_records(records, today, days=120):
    if not isinstance(records, list) or not records:
        raise ValueError("未取得公开日程，不覆盖已有数据")
    cutoff = today - timedelta(days=days)
    result, seen = [], set()
    for raw in records:
        record = public_record(raw)
        if record["code"] in seen:
            raise ValueError("存在重复股票记录")
        seen.add(record["code"])
        dates = [parse_date(record[k]) for k in ("subscription_date", "listing_date")]
        # Keep unresolved dates, recent history, and every future announced date.
        if any(value is None for value in dates) or any(value >= cutoff for value in dates if value):
            result.append(record)
    if not result:
        raise ValueError("未取得近期或待公告日程，不覆盖已有数据")
    return sorted(result, key=lambda r: (r["subscription_date"] or "", r["code"]), reverse=True)


def clean_cache(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list) or not payload["records"]:
        raise ValueError("缓存没有可用日程")
    generated = parse_timestamp(payload.get("generated_at"))
    records = [public_record(r) for r in payload["records"]]
    if len({r["code"] for r in records}) != len(records):
        raise ValueError("缓存股票代码重复")
    return {
        "records": records, "generated_at": generated.isoformat(timespec="seconds"),
        "last_attempt": payload.get("last_attempt"), "refresh_error": payload.get("refresh_error"),
        "source_name": SOURCE_NAME, "source_url": SOURCE_URL,
    }


def load_local(path):
    try:
        return clean_cache(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return None


def download_previous(url, timeout=15):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("已部署数据地址须为公开 HTTPS 地址")
    request = Request(url, headers={"User-Agent": "BSE-IPO-Reminder/1.0", "Accept": "application/json", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=timeout) as response:
        content = response.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError("已部署数据文件过大")
    return clean_cache(json.loads(content.decode("utf-8-sig")))


def build(output, fallback_url=None, fetcher=fetch_schedule, clock=None, downloader=download_previous):
    output = Path(output)
    stamp = (clock or datetime.now(BEIJING)).astimezone(BEIJING)
    timestamp = stamp.isoformat(timespec="seconds")
    try:
        records = select_records(fetcher(), stamp.date())
        result = {
            "records": records, "generated_at": timestamp, "last_attempt": timestamp,
            "refresh_error": None, "source_name": SOURCE_NAME, "source_url": SOURCE_URL,
        }
    except Exception as exc:
        candidates = [cache for cache in [load_local(output)] if cache]
        if fallback_url:
            try:
                candidates.append(clean_cache(downloader(fallback_url)))
            except Exception:
                pass  # First publication may not have a deployed endpoint yet.
        if not candidates:
            raise RuntimeError("更新失败且没有可用缓存，停止发布，保留现有网站") from exc
        result = max(candidates, key=lambda p: parse_timestamp(p["generated_at"]))
        result["last_attempt"] = timestamp
        # Do not publish arbitrary exception text, URLs, or environment values.
        result["refresh_error"] = "公开数据源更新失败；当前为上次成功获取的日程，请核对更新时间及发行公告。"
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    return result


def main():
    parser = argparse.ArgumentParser(description="构建 GitHub Pages 北交所公开日程")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/data/schedule.json")
    parser.add_argument("--fallback-url", default=None)
    args = parser.parse_args()
    try:
        result = build(args.output, args.fallback_url)
    except RuntimeError as exc:
        parser.exit(1, str(exc) + "\n")
    status = "使用缓存（刷新失败）" if result["refresh_error"] else "数据更新成功"
    print("%s；%d 条公开日程；最近成功时间 %s" % (status, len(result["records"]), result["generated_at"]))


if __name__ == "__main__":
    main()
