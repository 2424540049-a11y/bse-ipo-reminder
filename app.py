#!/usr/bin/env python3
"""Local BSE online IPO calendar. Python 3.9+, standard library only."""
import argparse
import csv
import io
import json
import math
import re
import threading
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen
from zoneinfo import ZoneInfo

from market_data import fetch_schedule

ROOT = Path(__file__).resolve().parent
BEIJING = ZoneInfo("Asia/Shanghai")
APP_ID = "bse-ipo-reminder"
MAX_BODY = 2_000_000


def now():
    return datetime.now(BEIJING)


def iso_now():
    return now().isoformat(timespec="seconds")


def valid_date(value, field):
    if value in (None, ""):
        return None
    value = str(value).strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError(field + "请使用 YYYY-MM-DD 格式")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError(field + "不是有效日期")
    return value


def number(value, field, integer=False):
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ValueError(field + "必须是数字")
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise ValueError(field + "必须是数字")
    if not math.isfinite(result) or result <= 0:
        raise ValueError(field + "必须大于 0")
    if integer:
        if result != int(result):
            raise ValueError(field + "必须是整数股数")
        return int(result)
    return result


def validate_record(raw, require_subscription=True):
    if not isinstance(raw, dict):
        raise ValueError("记录格式不正确")
    code = str(raw.get("code", "")).strip()
    if not re.fullmatch(r"\d{6}", code):
        raise ValueError("股票代码须为 6 位数字，请仅录入北交所网上发行股票")
    name = str(raw.get("name", "")).strip()
    if not name or len(name) > 80:
        raise ValueError("请填写不超过 80 字的股票名称")
    sub_code = str(raw.get("subscription_code") or "").strip() or None
    if sub_code and not re.fullmatch(r"\d{6}", sub_code):
        raise ValueError("申购代码须为 6 位数字")
    sub_date = valid_date(raw.get("subscription_date"), "申购日期")
    listing = valid_date(raw.get("listing_date"), "上市日期")
    if not sub_date and require_subscription:
        raise ValueError("请填写网上申购日期；上市日期可留空待公告")
    if listing and sub_date and listing < sub_date:
        raise ValueError("上市日期不能早于申购日期")
    source = str(raw.get("source_url") or "").strip()
    if source:
        parsed = urlparse(source)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or len(source) > 2000:
            raise ValueError("来源链接须为有效的 http 或 https 链接")
    return {
        "code": code, "name": name, "subscription_code": sub_code,
        "subscription_date": sub_date, "listing_date": listing,
        "issue_price": number(raw.get("issue_price"), "发行价格"),
        "subscription_limit": number(raw.get("subscription_limit"), "网上申购上限", integer=True),
        "source_url": source,
        "source_name": str(raw.get("source_name") or "手工录入，请核对公告")[:120],
        "subscription_status": "scheduled" if sub_date else raw.get("subscription_status", "pending"),
        "manual": True,
    }


CSV_FIELDS = ["code", "name", "subscription_code", "subscription_date", "listing_date", "issue_price", "subscription_limit", "source_url", "source_name", "subscription_status"]
CSV_LABELS = ["股票代码", "股票名称", "申购代码", "申购日期", "上市日期", "发行价", "网上申购上限（股）", "来源链接", "来源名称", "申购状态"]


def parse_csv(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("CSV 文件为空")
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    aliases = dict(zip(CSV_LABELS, CSV_FIELDS))
    aliases.update({"网上申购上限(股)": "subscription_limit", "网上申购上限": "subscription_limit"})
    records, seen = [], set()
    for row_number, raw in enumerate(reader, start=2):
        if not any(str(v or "").strip() for v in raw.values()):
            continue
        cleaned = {aliases.get(str(k).strip(), str(k).strip()): v for k, v in raw.items() if k is not None}
        try:
            allow_pending = cleaned.get("subscription_status") in ("pending", "suspended")
            record = validate_record(cleaned, require_subscription=not allow_pending)
        except ValueError as exc:
            raise ValueError("CSV 第 %d 行：%s" % (row_number, exc))
        if record["code"] in seen:
            raise ValueError("CSV 中股票代码 %s 重复，请先合并" % record["code"])
        seen.add(record["code"])
        records.append(record)
        if len(records) > 2000:
            raise ValueError("单次最多导入 2,000 条记录")
    if not records:
        raise ValueError("未找到记录；请使用页面下载的 CSV 模板和 UTF-8 编码")
    return records


def export_csv(records):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(CSV_LABELS)
    for record in records:
        row = []
        for field in CSV_FIELDS:
            val = record.get(field)
            val = "" if val is None else str(val)
            # Prevent formula execution when exported text is opened in Excel.
            if val.startswith(("=", "+", "-", "@", "\t", "\r")):
                val = "'" + val
            row.append(val)
        writer.writerow(row)
    return "\ufeff" + stream.getvalue()


def demo_records(today):
    def record(code, name, sub_delta, list_delta=None):
        return {
            "code": code, "name": name,
            "subscription_code": code,
            "subscription_date": (today + timedelta(days=sub_delta)).isoformat(),
            "listing_date": None if list_delta is None else (today + timedelta(days=list_delta)).isoformat(),
            "issue_price": 12.50, "subscription_limit": 200000,
            "source_name": "虚构演示数据", "source_url": "", "manual": False,
        }
    return [record("920001", "示例·今日申购", 0), record("920002", "示例·即将申购", 2), record("920003", "示例·今日上市", -9, 0), record("920004", "示例·即将上市", -7, 3), record("920005", "示例·上市待公告", -5)]


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.data = {"records": [], "overrides": {}, "handled": [], "demo_handled": [], "last_refresh": None, "last_attempt": None, "refresh_error": None, "mode": "live"}
        if self.path.exists():
            try:
                saved = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(saved, dict) or not isinstance(saved.get("records"), list):
                    raise ValueError("数据结构不正确")
                self.data.update(saved)
            except (ValueError, OSError) as exc:
                raise RuntimeError("无法读取本地数据文件 %s；请保留该文件后修复：%s" % (self.path, exc))

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    def snapshot(self):
        with self.lock:
            is_demo = self.data["mode"] == "demo"
            records = demo_records(now().date()) if is_demo else self.data["records"]
            merged = {r["code"]: dict(r) for r in records}
            if not is_demo:
                merged.update(self.data["overrides"])
            records = sorted(merged.values(), key=lambda r: (r.get("subscription_date") or "", r["code"]), reverse=True)
            return {
                "now": iso_now(), "today": now().date().isoformat(), "timezone": "Asia/Shanghai",
                "records": records,
                "handled": list(self.data["demo_handled" if is_demo else "handled"]),
                "last_refresh": self.data["last_refresh"], "last_attempt": self.data["last_attempt"],
                "refresh_error": self.data["refresh_error"], "mode": self.data["mode"],
                "refreshing": self.refresh_lock.locked(),
            }

    def refresh(self, fetcher=fetch_schedule):
        if not self.refresh_lock.acquire(blocking=False):
            return self.snapshot()
        try:
            with self.lock:
                self.data["last_attempt"] = iso_now()
            try:
                records = fetcher()
                if not records:
                    raise ValueError("数据源未返回北交所网上申购记录")
                # Reject malformed successful responses instead of destroying a good cache.
                for r in records:
                    validate_record(r, require_subscription=False)
                with self.lock:
                    self.data["records"] = [dict(r, manual=False) for r in records]
                    self.data["last_refresh"] = iso_now()
                    self.data["refresh_error"] = None
                    self.save()
            except Exception as exc:
                with self.lock:
                    self.data["refresh_error"] = "刷新失败，已保留上次数据：" + str(exc)[:300]
                    self.save()
        finally:
            self.refresh_lock.release()
        return self.snapshot()

    def mutate(self, endpoint, payload):
        with self.lock:
            if not isinstance(payload, dict):
                raise ValueError("请求内容须为对象")
            if endpoint == "/api/mode":
                if payload.get("mode") not in ("live", "demo"):
                    raise ValueError("模式不正确")
                self.data["mode"] = payload["mode"]
            elif endpoint == "/api/handled":
                event_id = payload.get("id", "")
                valid_ids = {"%s:%s:%s" % (r["code"], kind, r[key]) for r in self.snapshot()["records"] for kind, key in (("subscription", "subscription_date"), ("listing", "listing_date")) if r.get(key)}
                if event_id not in valid_ids or not isinstance(payload.get("handled"), bool):
                    raise ValueError("事件已变更，请刷新后重试")
                key = "demo_handled" if self.data["mode"] == "demo" else "handled"
                handled = set(self.data[key])
                if payload["handled"]:
                    handled.add(event_id)
                else:
                    handled.discard(event_id)
                self.data[key] = sorted(handled)
            elif endpoint in ("/api/record", "/api/record/delete", "/api/import"):
                if self.data["mode"] == "demo":
                    raise ValueError("请先退出演示模式，再编辑真实日程")
                if endpoint == "/api/record":
                    record = validate_record(payload)
                    self.data["overrides"][record["code"]] = record
                elif endpoint == "/api/record/delete":
                    code = payload.get("code")
                    if code not in self.data["overrides"]:
                        raise ValueError("仅可移除手工记录；来源记录会在刷新时保持同步")
                    del self.data["overrides"][code]
                else:
                    records = parse_csv(payload.get("csv"))
                    # Atomic import: every row is checked before changing any record.
                    self.data["overrides"].update({r["code"]: r for r in records})
            else:
                raise ValueError("未知操作")
            self.save()
        return self.snapshot()


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        def send(self, content, content_type="application/json; charset=utf-8", status=200):
            if isinstance(content, (dict, list)):
                content = json.dumps(content, ensure_ascii=False)
            if isinstance(content, str):
                content = content.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/favicon.ico":
                return self.send(b"", "image/x-icon", status=204)
            if path == "/api/health":
                return self.send({"app": APP_ID})
            if path == "/api/state":
                return self.send(store.snapshot())
            if path == "/api/export.csv":
                return self.send(export_csv(store.snapshot()["records"]), "text/csv; charset=utf-8")
            if path == "/api/template.csv":
                return self.send(export_csv([]), "text/csv; charset=utf-8")
            static = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8"), "/styles.css": ("styles.css", "text/css; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8")}
            if path.startswith("/static/"):
                path = path[len("/static"):]
            if path in static:
                filename, content_type = static[path]
                try:
                    return self.send((ROOT / "static" / filename).read_bytes(), content_type)
                except OSError:
                    return self.send({"error": "页面资源尚未就绪"}, status=503)
            return self.send({"error": "页面不存在"}, status=404)

        def do_POST(self):
            # This local app accepts same-origin JSON only; unrelated websites cannot mutate it.
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                return self.send({"error": "不允许跨站请求"}, status=403)
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self.send({"error": "请使用 JSON 请求"}, status=415)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > MAX_BODY:
                    return self.send({"error": "请求内容过大"}, status=413)
                payload = json.loads(self.rfile.read(length) or b"{}")
                endpoint = urlparse(self.path).path
                result = store.refresh() if endpoint == "/api/refresh" else store.mutate(endpoint, payload)
                return self.send(result)
            except (ValueError, UnicodeError) as exc:
                return self.send({"error": str(exc)}, status=400)
            except OSError as exc:
                return self.send({"error": "本地保存失败：" + str(exc)}, status=500)

        def log_message(self, fmt, *args):
            if args and str(args[1] if len(args) > 1 else "") not in ("200", "304"):
                super().log_message(fmt, *args)
    return Handler


def main():
    parser = argparse.ArgumentParser(description="北交所网上申购提醒 · 本地工作台")
    parser.add_argument("--port", type=int, default=8891)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-refresh", action="store_true")
    parser.add_argument("--data-file", type=Path, default=ROOT / "data" / "state.json")
    args = parser.parse_args()
    url = "http://127.0.0.1:%d" % args.port
    store = Store(args.data_file)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store))
    except OSError:
        try:
            with urlopen(url + "/api/health", timeout=2) as response:
                if json.load(response).get("app") != APP_ID:
                    raise ValueError("other app")
            print("工作台已在运行：" + url)
            if not args.no_browser:
                webbrowser.open(url)
            return
        except Exception:
            parser.exit(1, "端口被占用，请使用 --port 8892 换一个端口。\n")
    if not args.no_refresh:
        threading.Thread(target=store.refresh, daemon=True).start()
    print("北交所网上申购提醒已启动：" + url, flush=True)
    print("时间采用北京时间；仅在页面查看提醒。按 Ctrl+C 关闭服务。", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n工作台已关闭。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
