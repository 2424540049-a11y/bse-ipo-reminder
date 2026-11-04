"""Public Eastmoney BSE online-IPO calendar adapter (Python standard library).

Source discovery, checked 2026-11-04:
  https://data.eastmoney.com/xg/xg/?mkt=bjs
  https://data.eastmoney.com/newstatic/js/xg/xglist.js (loadBjsTable)

The site's BSE-specific table uses RPT_NEEQ_ISSUEINFO_LIST.  Do not use
LISTING_DATE from the general IPO table: the BSE field is SELECT_LISTING_DATE.
APPLY_NUM_UPPER is already in shares; the website divides it by 10,000 for display.
These are third-party published dates, not an exchange confirmation service.
No listing date is inferred from the subscription date.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
SOURCE_URL = "https://data.eastmoney.com/xg/xg/?mkt=bjs"
SOURCE_NAME = "东方财富·北交所新股"
REPORT_NAME = "RPT_NEEQ_ISSUEINFO_LIST"
_MAX_RESPONSE_BYTES = 5_000_000
_NULL_VALUES = (None, "", "-", "--")


class MarketDataError(RuntimeError):
    """Upstream was unavailable or its schema/data could not be trusted."""


def _date_or_none(value: object, field: str) -> str | None:
    if value in _NULL_VALUES:
        return None
    text = str(value).strip()
    # Eastmoney uses this explicit sentinel for suspended issuance.
    if text.startswith("9999-12-31"):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?", text):
        raise MarketDataError(f"数据源的 {field} 日期格式异常")
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError as exc:
        raise MarketDataError(f"数据源的 {field} 日期无效") from exc


def _number_or_none(value: object, field: str, *, integral: bool = False):
    if value in _NULL_VALUES:
        return None
    if isinstance(value, bool):
        raise MarketDataError(f"数据源的 {field} 数值异常")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise MarketDataError(f"数据源的 {field} 数值异常") from exc
    if not number.is_finite() or number < 0:
        raise MarketDataError(f"数据源的 {field} 数值异常")
    if number == 0:
        return None
    if integral:
        if number != number.to_integral_value():
            raise MarketDataError(f"数据源的 {field} 不是整数股数")
        return int(number)
    result = float(number)
    if not math.isfinite(result):
        raise MarketDataError(f"数据源的 {field} 数值过大")
    return result


def normalize_record(row: dict) -> dict | None:
    """Normalize a BSE online-issuance row; discard other markets/channels.

    Null dates remain null. Invalid required fields fail the refresh so the
    caller can retain its previous good cache instead of showing invented dates.
    """
    if not isinstance(row, dict):
        raise MarketDataError("数据源返回的股票记录格式异常")
    # Use an explicit exchange identifier rather than stock-code prefixes.
    secucode = row.get("SECUCODE")
    if not isinstance(secucode, str):
        raise MarketDataError("数据源缺少交易所标识，无法核实是否为北交所")
    if not secucode.endswith(".BJ"):
        return None
    online_volume = _number_or_none(row.get("ONLINE_ISSUE_NUM"), "ONLINE_ISSUE_NUM", integral=True)
    if online_volume is None:
        return None
    code = str(row.get("SECURITY_CODE") or "").strip()
    name = str(row.get("SECURITY_NAME_ABBR") or "").strip()
    if not re.fullmatch(r"\d{6}", code) or secucode != f"{code}.BJ" or not name:
        raise MarketDataError("数据源的股票代码或名称缺失／不一致")
    if "APPLY_DATE" not in row or "SELECT_LISTING_DATE" not in row:
        raise MarketDataError("数据源日期字段已变化，请检查接口")
    subscription_date = _date_or_none(row["APPLY_DATE"], "APPLY_DATE")
    listing_date = _date_or_none(row["SELECT_LISTING_DATE"], "SELECT_LISTING_DATE")
    if listing_date and subscription_date and listing_date < subscription_date:
        raise MarketDataError(f"{code} 上市日期早于申购日期，请核对数据源")
    subscription_code = row.get("APPLY_CODE")
    if subscription_code in _NULL_VALUES:
        subscription_code = None
    else:
        subscription_code = str(subscription_code).strip()
        if not re.fullmatch(r"\d{6}", subscription_code):
            raise MarketDataError(f"{code} 的网上申购代码格式异常")
    return {
        "code": code,
        "name": name,
        "subscription_code": subscription_code,
        "subscription_date": subscription_date,
        "listing_date": listing_date,
        "issue_price": _number_or_none(row.get("ISSUE_PRICE"), "ISSUE_PRICE"),
        "subscription_limit": _number_or_none(row.get("APPLY_NUM_UPPER"), "APPLY_NUM_UPPER", integral=True),
        "source_url": f"https://data.eastmoney.com/xg/jxc/{code}.html",
        "source_name": SOURCE_NAME,
        "subscription_status": (
            "suspended" if str(row.get("APPLY_DATE", "")).startswith("9999-12-31")
            else "scheduled" if subscription_date else "pending"
        ),
    }


def _read_page(page_number: int, timeout: float) -> dict:
    params = {
        "reportName": REPORT_NAME,
        "columns": "ALL",
        "source": "NEEQSELECT",
        "client": "WEB",
        "sortColumns": "APPLY_DATE",
        "sortTypes": "-1",
        "pageSize": "500",
        "pageNumber": str(page_number),
    }
    request = Request(
        API_URL + "?" + urlencode(params),
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; BSE-IPO-Reminder/1.0)",
            "Accept": "application/json",
            "Referer": SOURCE_URL,
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
        if len(raw) > _MAX_RESPONSE_BYTES:
            raise MarketDataError("数据源响应过大，已停止刷新")
        payload = json.loads(raw.decode("utf-8-sig"))
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise MarketDataError("暂时无法连接东方财富数据源，请稍后重试") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise MarketDataError("东方财富返回的内容不是有效数据，请稍后重试") from exc
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise MarketDataError("东方财富数据接口未成功返回，请稍后重试")
    result = payload.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise MarketDataError("东方财富数据格式已变化，请检查接口")
    return result


def fetch_schedule(timeout: float = 15.0) -> list[dict]:
    """Fetch current published BSE online-IPO records, including recent history.

    Raises MarketDataError on a network/schema/empty-data error. It deliberately
    does not replace failed live data with demo records or fabricate dates.
    Callers should cache a successful result and display its refresh timestamp.
    """
    first_page = _read_page(1, timeout)
    page_count = first_page.get("pages")
    if isinstance(page_count, bool) or not isinstance(page_count, int) or not 1 <= page_count <= 20:
        raise MarketDataError("东方财富返回的分页信息异常")
    rows = list(first_page["data"])
    for page_number in range(2, page_count + 1):
        page = _read_page(page_number, timeout)
        if not page["data"]:
            raise MarketDataError("东方财富返回的数据不完整，请重新刷新")
        rows.extend(page["data"])
    normalized: dict[str, dict] = {}
    for row in rows:
        record = normalize_record(row)
        if record is None:
            continue
        code = record["code"]
        if code in normalized and normalized[code] != record:
            raise MarketDataError(f"{code} 存在冲突日程，请重新刷新")
        normalized[code] = record
    if not normalized:
        raise MarketDataError("数据源未返回北交所网上申购记录，未覆盖已有数据")
    return sorted(
        normalized.values(),
        key=lambda row: (row["subscription_date"] or "", row["code"]),
        reverse=True,
    )


if __name__ == "__main__":
    print(json.dumps(fetch_schedule(), ensure_ascii=False, indent=2))
