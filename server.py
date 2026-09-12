#!/usr/bin/env python3
"""
Xiaomi MiMo Token Statistics
============================
本地 Token 用量统计服务（纯标准库，零第三方依赖）。

数据源：~/.local/share/mimocode/mimocode.db
算法对齐 MiMo Desktop：assistant 消息 tokens =
  input + output + reasoning + cache.read + cache.write
  （优先使用 tokens.total 字段）

用法:
  python server.py
  python server.py --port 8765 --host 127.0.0.1
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ── paths ────────────────────────────────────────────────────────────────────

IS_WINDOWS = sys.platform.startswith("win")
if IS_WINDOWS:
    APP_DATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / "Xiaomi MiMo"
else:
    APP_DATA_DIR = Path.home() / "Library" / "Application Support" / "Xiaomi MiMo"

MIMO_DB_PATH = Path.home() / ".local" / "share" / "mimocode" / "mimocode.db"
COOKIE_CANDIDATES = [
    APP_DATA_DIR / "Partitions" / "xiaomi-account" / "Network" / "Cookies",
    APP_DATA_DIR / "Partitions" / "xiaomi-account" / "Cookies",
]
FRONTEND_ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8765

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
}

# ── cache ────────────────────────────────────────────────────────────────────

_CACHE: Dict[str, Tuple[float, Any]] = {}
_CACHE_LOCK = threading.Lock()
CACHE_TTL = 180.0  # seconds — 与内存 items 缓存一致，范围切换可秒回


def cache_get(key: str) -> Optional[Any]:
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if not hit:
            return None
        ts, val = hit
        if time.time() - ts > CACHE_TTL:
            _CACHE.pop(key, None)
            return None
        return val


def cache_set(key: str, val: Any) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = (time.time(), val)


def cache_clear() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


# ── helpers ──────────────────────────────────────────────────────────────────

def format_token_lx(val: float) -> str:
    """中文单位缩写：万 / 亿"""
    n = int(val or 0)
    if n >= 100_000_000:
        s = f"{n / 100_000_000:.3f}".rstrip("0").rstrip(".")
        return f"{s}亿"
    if n >= 10_000:
        s = f"{n / 10_000:.2f}".rstrip("0").rstrip(".")
        return f"{s}万"
    return f"{n:,}"


def cache_hit_rate(cr: int, cw: int, inp: int) -> int:
    denom = cr + cw + inp
    return round((cr / denom) * 100) if denom > 0 else 0


def open_db() -> sqlite3.Connection:
    if not MIMO_DB_PATH.exists():
        raise FileNotFoundError(f"未找到 mimocode.db: {MIMO_DB_PATH}")
    uri = MIMO_DB_PATH.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=8)
    conn.row_factory = sqlite3.Row
    return conn


def parse_tokens(raw: Optional[str]) -> Optional[Dict[str, int]]:
    """从 message.data 中提取 token 统计；无效消息返回 None。"""
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except Exception:
        return None
    if not isinstance(d, dict) or d.get("role") != "assistant":
        return None
    tok = d.get("tokens") or {}
    if not isinstance(tok, dict):
        return None

    inp = int(tok.get("input") or 0)
    outp = int(tok.get("output") or 0)
    reasoning = int(tok.get("reasoning") or 0)
    cache = tok.get("cache") or {}
    if not isinstance(cache, dict):
        cache = {}
    cr = int(cache.get("read") or 0)
    cw = int(cache.get("write") or 0)
    total = int(tok.get("total") or 0)
    if total <= 0:
        total = inp + outp + reasoning + cr + cw
    if total <= 0 and inp == 0 and outp == 0 and cr == 0 and cw == 0 and reasoning == 0:
        return None

    return {
        "input": inp,
        "output": outp,
        "reasoning": reasoning,
        "cache_read": cr,
        "cache_write": cw,
        "total": total,
        "model": d.get("modelID") or d.get("model") or "unknown",
        "msg_time": int((d.get("time") or {}).get("created") or 0),
    }


def range_days(range_key: str) -> Optional[int]:
    """返回要纳入统计的天数；None = 全部历史。"""
    k = (range_key or "7").lower()
    if k in ("all", "0", "*"):
        return None
    if k == "today":
        return 1
    try:
        n = int(k)
    except ValueError:
        return 7
    if n <= 0:
        return None
    return n


def range_label(range_key: str) -> str:
    k = (range_key or "7").lower()
    mapping = {
        "all": "全部历史",
        "today": "今天",
        "1": "今天",
        "7": "近 7 天",
        "14": "近 14 天",
        "30": "近 30 天",
        "90": "近 90 天",
    }
    if k in mapping:
        return mapping[k]
    days = range_days(k)
    return f"近 {days} 天" if days else "全部历史"


def day_key(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def day_label(ms_or_key) -> str:
    if isinstance(ms_or_key, str):
        return ms_or_key[5:]  # MM-DD
    return datetime.fromtimestamp(ms_or_key / 1000).strftime("%m-%d")


def new_mstat() -> Dict[str, int]:
    return {
        "tokens": 0, "turns": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
    }


def bump_mstat(st: Dict[str, int], it: Dict[str, Any], t: int) -> None:
    st["tokens"] += t
    st["turns"] += 1
    st["input"] += it["input"]
    st["output"] += it["output"]
    st["reasoning"] += it["reasoning"]
    st["cache_read"] += it["cache_read"]
    st["cache_write"] += it["cache_write"]


def pack_mstat(mid: str, st: Dict[str, int], denom_tokens: int = 0) -> Dict[str, Any]:
    cache = st.get("cache_read", 0) + st.get("cache_write", 0)
    outp = st.get("output", 0) + st.get("reasoning", 0)
    turns = st.get("turns", 0) or 0
    return {
        "model": mid,
        "tokens": st.get("tokens", 0),
        "fmt": format_token_lx(st.get("tokens", 0)),
        "share": round(st.get("tokens", 0) / denom_tokens * 100, 1) if denom_tokens else 0,
        "turns": turns,
        "input": st.get("input", 0),
        "output": outp,
        "reasoning": st.get("reasoning", 0),
        "cache": cache,
        "cache_read": st.get("cache_read", 0),
        "cache_write": st.get("cache_write", 0),
        "cache_hit": cache_hit_rate(st.get("cache_read", 0), st.get("cache_write", 0), st.get("input", 0)),
        "avg": round(st.get("tokens", 0) / turns) if turns else 0,
        "avg_fmt": format_token_lx(st.get("tokens", 0) / turns) if turns else "0",
    }


# ── aggregation core ─────────────────────────────────────────────────────────

_FULL_ITEMS: Optional[List[Dict[str, Any]]] = None
_FULL_META: Optional[Dict[str, Any]] = None
_FULL_ITEMS_AT = 0.0
_FULL_ITEMS_TTL = 180.0  # 一次全量扫描后，各时间范围共用内存结果


def _load_session_meta() -> Dict[str, Any]:
    conn = open_db()
    try:
        c = conn.cursor()
        c.execute("SELECT id, title, directory, project_id FROM session")
        sessions = {
            r["id"]: {
                "title": (r["title"] or "").strip(),
                "directory": r["directory"] or "",
                "project_id": r["project_id"] or "",
            }
            for r in c.fetchall()
        }
        c.execute("SELECT id, worktree, name FROM project")
        projects = {
            r["id"]: {"worktree": r["worktree"] or "", "name": (r["name"] or "").strip()}
            for r in c.fetchall()
        }
        return {"sessions": sessions, "projects": projects}
    finally:
        conn.close()


def _parse_message_rows(rows) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for r in rows:
        parsed = parse_tokens(r["data"])
        if not parsed:
            continue
        tc = parsed["msg_time"] or int(r["time_created"] or 0)
        sid = r["session_id"] or ""
        items.append(
            {
                "session_id": sid,
                "title": "",
                "directory": "",
                "project_name": "",
                "time": tc,
                **parsed,
            }
        )
    return items


def load_full_items(force: bool = False) -> List[Dict[str, Any]]:
    """全量 assistant token 行（带内存缓存，供各 range 复用）。"""
    global _FULL_ITEMS, _FULL_META, _FULL_ITEMS_AT
    now = time.time()
    if (
        not force
        and _FULL_ITEMS is not None
        and _FULL_META is not None
        and now - _FULL_ITEMS_AT < _FULL_ITEMS_TTL
    ):
        return _FULL_ITEMS

    conn = open_db()
    try:
        c = conn.cursor()
        # SQL 预过滤：只取 assistant，显著减少 JSON 解析量
        try:
            c.execute(
                """
                SELECT session_id, data, time_created
                FROM message
                WHERE json_extract(data, '$.role') = 'assistant'
                """
            )
            rows = c.fetchall()
            if not rows:
                raise sqlite3.OperationalError("empty json_extract")
        except Exception:
            c.execute("SELECT session_id, data, time_created FROM message")
            rows = c.fetchall()
        meta = _load_session_meta()
    finally:
        conn.close()

    sessions = meta["sessions"]
    items: List[Dict[str, Any]] = []
    for r in rows:
        parsed = parse_tokens(r["data"])
        if not parsed:
            continue
        tc = parsed["msg_time"] or int(r["time_created"] or 0)
        sid = r["session_id"] or ""
        smeta = sessions.get(sid) or {}
        directory = smeta.get("directory") or ""
        if directory:
            pname = os.path.basename(directory.rstrip("/\\")) or directory
        else:
            pname = "(未分配目录)"
        items.append(
            {
                "session_id": sid,
                "title": smeta.get("title") or sid[:16],
                "directory": directory,
                "project_name": pname,
                "time": tc,
                **parsed,
            }
        )
    items.sort(key=lambda x: x["time"])
    _FULL_ITEMS = items
    _FULL_META = meta
    _FULL_ITEMS_AT = now
    return items


def collect_rows(range_key: str, min_days: int = 0) -> List[Dict[str, Any]]:
    """读取范围内所有有效 assistant token 消耗。min_days 会放宽窗口（用于日历热力图）。"""
    days = range_days(range_key)
    now_ms = int(time.time() * 1000)
    if days is None:
        since_ms = 0
    else:
        effective = max(days, min_days) if min_days > 0 else days
        if (range_key or "").lower() in ("today", "1") and min_days <= 0:
            local = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            since_ms = int(local.timestamp() * 1000)
        else:
            since_ms = now_ms - effective * 86400 * 1000

    all_items = load_full_items()
    if since_ms <= 0:
        return all_items
    return [it for it in all_items if it["time"] >= since_ms]


def aggregate(range_key: str) -> Dict[str, Any]:
    """主统计：KPI + 每日序列 + 模型/项目/会话/小时。"""
    cache_key = f"agg:{range_key}"
    hit = cache_get(cache_key)
    if hit is not None:
        return hit

    # 热力图至少铺 26 周，观感接近 GitHub contribution graph
    HEATMAP_MIN_DAYS = 182
    items_all = collect_rows(range_key, min_days=HEATMAP_MIN_DAYS)
    days = range_days(range_key)
    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")

    # range cutoff for KPI / tables / hourly
    if days is None:
        range_since = 0
    elif (range_key or "").lower() in ("today", "1"):
        local = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        range_since = int(local.timestamp() * 1000)
    else:
        range_since = int((time.time() - days * 86400) * 1000)

    items = [it for it in items_all if it["time"] >= range_since] if range_since else list(items_all)

    # chart / heatmap day list
    # 日历热力图始终铺满 HEATMAP_MIN_DAYS，与顶部时间范围解耦（副标题保持「最近 N 天」）
    heat_days = HEATMAP_MIN_DAYS
    if days is None:
        if items_all:
            first = datetime.fromtimestamp(items_all[0]["time"] / 1000)
            span = (now - first).days + 1
            chart_days = max(1, span)
        else:
            chart_days = 7
    elif (range_key or "").lower() in ("today", "1"):
        chart_days = 1
    else:
        chart_days = days

    # heatmap day slots (always wide enough for calendar)
    heat_map: Dict[str, Dict[str, Any]] = {}
    for i in range(heat_days - 1, -1, -1):
        d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        heat_map[d] = {
            "date": d,
            "label": d[5:],
            "weekday": (now - timedelta(days=i)).weekday(),
            "tokens": 0,
            "turns": 0,
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": 0,
            "cache_read": 0,
            "cache_write": 0,
            "is_today": d == today_str,
            "models": defaultdict(int),
        }

    day_map: Dict[str, Dict[str, Any]] = {}
    for i in range(chart_days - 1, -1, -1):
        d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
        day_map[d] = {
            "date": d,
            "label": d[5:],
            "weekday": (now - timedelta(days=i)).weekday(),  # Mon=0
            "tokens": 0,
            "turns": 0,
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache": 0,
            "is_today": d == today_str,
            "models": defaultdict(int),
        }

    model_agg: Dict[str, Dict[str, int]] = defaultdict(
        lambda: {
            "tokens": 0,
            "turns": 0,
            "input": 0,
            "output": 0,
            "reasoning": 0,
            "cache_read": 0,
            "cache_write": 0,
        }
    )
    sess_agg: Dict[str, Dict[str, Any]] = {}
    proj_agg: Dict[str, Dict[str, Any]] = {}
    hour_tokens = [0] * 24
    hour_turns = [0] * 24
    hour_models: List[Dict[str, Dict[str, int]]] = [defaultdict(new_mstat) for _ in range(24)]
    # weekday(0=Mon) × hour
    wd_hour: List[List[int]] = [[0] * 24 for _ in range(7)]
    wd_hour_turns: List[List[int]] = [[0] * 24 for _ in range(7)]
    wd_hour_models: List[List[Dict[str, int]]] = [[defaultdict(int) for _ in range(24)] for _ in range(7)]
    heat_model_stats: Dict[str, Dict[str, Dict[str, int]]] = defaultdict(lambda: defaultdict(new_mstat))

    total = 0
    total_today = 0
    total_turns = 0
    sum_in = sum_out = sum_reason = sum_cr = sum_cw = 0

    # heatmap: always fill from wider window
    for it in items_all:
        t = it["total"]
        dk = day_key(it["time"])
        if dk in heat_map:
            slot = heat_map[dk]
            slot["tokens"] += t
            slot["turns"] += 1
            slot["input"] += it["input"]
            slot["output"] += it["output"] + it["reasoning"]
            slot["cache"] += it["cache_read"] + it["cache_write"]
            slot["cache_read"] += it["cache_read"]
            slot["cache_write"] += it["cache_write"]
            slot["models"][it["model"]] += t
            bump_mstat(heat_model_stats[dk][it["model"]], it, t)

    for it in items:
        t = it["total"]
        total += t
        total_turns += 1
        sum_in += it["input"]
        sum_out += it["output"]
        sum_reason += it["reasoning"]
        sum_cr += it["cache_read"]
        sum_cw += it["cache_write"]

        mid = it["model"]
        dk = day_key(it["time"])
        if dk in day_map:
            slot = day_map[dk]
            slot["tokens"] += t
            slot["turns"] += 1
            slot["input"] += it["input"]
            slot["output"] += it["output"] + it["reasoning"]
            slot["cache"] += it["cache_read"] + it["cache_write"]
            slot["models"][mid] += t
        if dk == today_str:
            total_today += t

        hour = datetime.fromtimestamp(it["time"] / 1000).hour
        hour_tokens[hour] += t
        hour_turns[hour] += 1
        bump_mstat(hour_models[hour][mid], it, t)
        wd = datetime.fromtimestamp(it["time"] / 1000).weekday()
        wd_hour[wd][hour] += t
        wd_hour_turns[wd][hour] += 1
        wd_hour_models[wd][hour][mid] += t

        m = model_agg[mid]
        m["tokens"] += t
        m["turns"] += 1
        m["input"] += it["input"]
        m["output"] += it["output"]
        m["reasoning"] += it["reasoning"]
        m["cache_read"] += it["cache_read"]
        m["cache_write"] += it["cache_write"]
        if it["time"] > m.get("last", 0):
            m["last"] = it["time"]

        sid = it["session_id"]
        if sid:
            s = sess_agg.setdefault(
                sid,
                {
                    "id": sid,
                    "title": it["title"],
                    "directory": it["directory"],
                    "project_name": it["project_name"],
                    "tokens": 0,
                    "turns": 0,
                    "input": 0,
                    "output": 0,
                    "reasoning": 0,
                    "cache_read": 0,
                    "cache_write": 0,
                    "last": 0,
                    "models": defaultdict(int),
                },
            )
            s["tokens"] += t
            s["turns"] += 1
            s["input"] += it["input"]
            s["output"] += it["output"]
            s["reasoning"] += it["reasoning"]
            s["cache_read"] += it["cache_read"]
            s["cache_write"] += it["cache_write"]
            s["last"] = max(s["last"], it["time"])
            s["models"][it["model"]] += t
            if it["title"] and (not s["title"] or len(it["title"]) > len(s["title"])):
                pass

        pkey = it["project_name"] or "(未分配目录)"
        p = proj_agg.setdefault(
            pkey,
            {
                "name": pkey,
                "path": it["directory"] if pkey != "(未分配目录)" else "",
                "tokens": 0,
                "turns": 0,
                "input": 0,
                "output": 0,
                "cache_read": 0,
                "cache_write": 0,
                "sessions": set(),
                "model_stats": defaultdict(lambda: {
                    "tokens": 0, "turns": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
                }),
            },
        )
        p["tokens"] += t
        p["turns"] += 1
        p["input"] += it["input"]
        p["output"] += it["output"] + it["reasoning"]
        p["cache_read"] += it["cache_read"]
        p["cache_write"] += it["cache_write"]
        if it["time"] > p.get("last", 0):
            p["last"] = it["time"]
        if sid:
            p["sessions"].add(sid)
        bump_mstat(p["model_stats"][it["model"]], it, t)

    days_list = []
    max_day = max((d["tokens"] for d in day_map.values()), default=0) or 1
    for d in day_map.values():
        models = [
            {"model": mid, "tokens": mt, "share": round(mt / d["tokens"] * 100, 1) if d["tokens"] else 0}
            for mid, mt in sorted(d["models"].items(), key=lambda x: -x[1])
        ][:6]
        days_list.append(
            {
                "date": d["date"],
                "label": d["label"],
                "weekday": d["weekday"],
                "tokens": d["tokens"],
                "turns": d["turns"],
                "input": d["input"],
                "output": d["output"],
                "cache": d["cache"],
                "is_today": d["is_today"],
                "pct": round(d["tokens"] / max_day * 100),
                "fmt": format_token_lx(d["tokens"]),
                "models": models,
            }
        )
    days_list.sort(key=lambda x: x["date"])

    by_model = []
    for mid, m in sorted(model_agg.items(), key=lambda x: -x[1]["tokens"]):
        top_sess = []
        for sid, s in sess_agg.items():
            mt = s["models"].get(mid, 0)
            if mt > 0:
                top_sess.append(
                    {
                        "id": sid,
                        "title": (s["title"] or sid)[:60],
                        "tokens": mt,
                        "fmt": format_token_lx(mt),
                        "project_name": s["project_name"],
                        "share": round(mt / s["tokens"] * 100, 1) if s["tokens"] else 0,
                    }
                )
        top_sess.sort(key=lambda x: -x["tokens"])
        by_model.append(
            {
                "model": mid,
                "tokens": m["tokens"],
                "fmt": format_token_lx(m["tokens"]),
                "share": round(m["tokens"] / total * 100, 1) if total else 0,
                "turns": m["turns"],
                "avg": round(m["tokens"] / m["turns"]) if m["turns"] else 0,
                "avg_fmt": format_token_lx(m["tokens"] / m["turns"]) if m["turns"] else "0",
                "input": m["input"],
                "output": m["output"],
                "reasoning": m["reasoning"],
                "cache": m["cache_read"] + m["cache_write"],
                "cache_hit": cache_hit_rate(m["cache_read"], m["cache_write"], m["input"]),
                "sessions": len(top_sess),
                "last": m.get("last", 0),
                "last_label": datetime.fromtimestamp(m.get("last", 0) / 1000).strftime("%m-%d %H:%M") if m.get("last") else "",
                "top_sessions": top_sess[:8],
            }
        )

    by_session = []
    for sid, s in sorted(sess_agg.items(), key=lambda x: -x[1]["tokens"])[:50]:
        models = [
            {"model": mid, "tokens": mt, "share": round(mt / s["tokens"] * 100, 1) if s["tokens"] else 0}
            for mid, mt in sorted(s["models"].items(), key=lambda x: -x[1])
        ]
        by_session.append(
            {
                "id": sid,
                "title": (s["title"] or sid)[:80],
                "directory": s["directory"],
                "project_name": s["project_name"],
                "tokens": s["tokens"],
                "fmt": format_token_lx(s["tokens"]),
                "share": round(s["tokens"] / total * 100, 1) if total else 0,
                "turns": s["turns"],
                "last": s["last"],
                "last_label": datetime.fromtimestamp(s["last"] / 1000).strftime("%m-%d %H:%M") if s["last"] else "",
                "input": s.get("input", 0),
                "output": s.get("output", 0) + s.get("reasoning", 0),
                "cache": s.get("cache_read", 0) + s.get("cache_write", 0),
                "avg": round(s["tokens"] / s["turns"]) if s["turns"] else 0,
                "avg_fmt": format_token_lx(s["tokens"] / s["turns"]) if s["turns"] else "0",
                "cache_hit": cache_hit_rate(s["cache_read"], s["cache_write"], s["input"]),
                "models": models[:4],
            }
        )
    max_sess = by_session[0]["tokens"] if by_session else 1
    for s in by_session:
        s["pct"] = round(s["tokens"] / max_sess * 100) if max_sess else 0

    by_project = []
    for pkey, p in sorted(proj_agg.items(), key=lambda x: -x[1]["tokens"])[:30]:
        models = [
            pack_mstat(mid, st, p["tokens"])
            for mid, st in sorted(p["model_stats"].items(), key=lambda x: -x[1]["tokens"])
        ]
        top_sess = []
        for sid, s in sess_agg.items():
            if s["project_name"] == p["name"] or (p["path"] and s["directory"] == p["path"]):
                top_sess.append(
                    {
                        "id": sid,
                        "title": (s["title"] or sid)[:60],
                        "tokens": s["tokens"],
                        "fmt": format_token_lx(s["tokens"]),
                        "turns": s["turns"],
                        "models": [
                            {"model": mid, "tokens": mt, "share": round(mt / s["tokens"] * 100, 1) if s["tokens"] else 0}
                            for mid, mt in sorted(s["models"].items(), key=lambda x: -x[1])[:3]
                        ],
                    }
                )
        top_sess.sort(key=lambda x: -x["tokens"])
        by_project.append(
            {
                "name": p["name"],
                "path": p["path"],
                "tokens": p["tokens"],
                "fmt": format_token_lx(p["tokens"]),
                "share": round(p["tokens"] / total * 100, 1) if total else 0,
                "turns": p["turns"],
                "sessions": len(p["sessions"]),
                "input": p.get("input", 0),
                "output": p.get("output", 0),
                "cache": p.get("cache_read", 0) + p.get("cache_write", 0),
                "avg": round(p["tokens"] / p["turns"]) if p["turns"] else 0,
                "avg_fmt": format_token_lx(p["tokens"] / p["turns"]) if p["turns"] else "0",
                "cache_hit": cache_hit_rate(p["cache_read"], p["cache_write"], p["input"]),
                "last": p.get("last", 0),
                "last_label": datetime.fromtimestamp(p.get("last", 0) / 1000).strftime("%m-%d %H:%M") if p.get("last") else "",
                "models": models,
                "top_sessions": top_sess[:8],
            }
        )
    max_proj = by_project[0]["tokens"] if by_project else 1
    for p in by_project:
        p["pct"] = round(p["tokens"] / max_proj * 100) if max_proj else 0

    max_hour = max(hour_tokens) if hour_tokens else 0
    # top overall models for hourly stacking
    top_models = [m["model"] for m in by_model[:5]]
    hourly = []
    for h in range(24):
        hm = hour_models[h]
        stacks = []
        other = {"tokens": 0, "turns": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0}
        for mid in top_models:
            st = hm.get(mid)
            if st:
                stacks.append(pack_mstat(mid, st, hour_tokens[h]))
        for mid, st in hm.items():
            if mid not in top_models:
                for k in other:
                    other[k] += st.get(k, 0)
        if other["tokens"] > 0 or other["turns"] > 0:
            stacks.append(pack_mstat("其他", other, hour_tokens[h]))
        else:
            stacks.append({"model": "其他", "tokens": 0, "fmt": "0", "share": 0, "turns": 0,
                           "input": 0, "output": 0, "reasoning": 0, "cache": 0, "cache_read": 0,
                           "cache_write": 0, "cache_hit": 0, "avg": 0, "avg_fmt": "0"})
        # hour-level cache/io aggregate
        h_in = h_out = h_cr = h_cw = 0
        for mid, st in hm.items():
            h_in += st.get("input", 0)
            h_out += st.get("output", 0) + st.get("reasoning", 0)
            h_cr += st.get("cache_read", 0)
            h_cw += st.get("cache_write", 0)
        hourly.append(
            {
                "hour": h,
                "tokens": hour_tokens[h],
                "turns": hour_turns[h],
                "fmt": format_token_lx(hour_tokens[h]),
                "pct": round(hour_tokens[h] / max_hour * 100) if max_hour else 0,
                "input": h_in,
                "output": h_out,
                "cache": h_cr + h_cw,
                "cache_read": h_cr,
                "cache_write": h_cw,
                "cache_hit": cache_hit_rate(h_cr, h_cw, h_in),
                "avg": round(hour_tokens[h] / hour_turns[h]) if hour_turns[h] else 0,
                "avg_fmt": format_token_lx(hour_tokens[h] / hour_turns[h]) if hour_turns[h] else "0",
                "stacks": stacks,
            }
        )

    peak_day = max(days_list, key=lambda d: d["tokens"], default=None)
    peak_hour = max(hourly, key=lambda h: h["tokens"], default=None)
    avg_daily = round(total / chart_days) if chart_days else 0

    # calendar weeks for GitHub-style heatmap (pad to full weeks, Mon start)
    heat_list = []
    max_heat = max((d["tokens"] for d in heat_map.values()), default=0) or 1
    for d in heat_map.values():
        hms = heat_model_stats.get(d["date"]) or {}
        models = [pack_mstat(mid, st, d["tokens"]) for mid, st in sorted(hms.items(), key=lambda x: -x[1]["tokens"])][:6]
        heat_list.append(
            {
                "date": d["date"],
                "label": d["label"],
                "weekday": d["weekday"],
                "tokens": d["tokens"],
                "turns": d["turns"],
                "input": d["input"],
                "output": d["output"],
                "cache": d["cache"],
                "cache_read": d.get("cache_read", 0),
                "cache_write": d.get("cache_write", 0),
                "cache_hit": cache_hit_rate(d.get("cache_read", 0), d.get("cache_write", 0), d.get("input", 0)),
                "avg": round(d["tokens"] / d["turns"]) if d["turns"] else 0,
                "avg_fmt": format_token_lx(d["tokens"] / d["turns"]) if d["turns"] else "0",
                "is_today": d["is_today"],
                "pct": round(d["tokens"] / max_heat * 100),
                "fmt": format_token_lx(d["tokens"]),
                "models": models,
            }
        )
    heat_list.sort(key=lambda x: x["date"])

    heatmap_weeks = []
    if heat_list:
        first = datetime.strptime(heat_list[0]["date"], "%Y-%m-%d")
        pad_start = first.weekday()  # Mon=0
        week: List[Optional[Dict[str, Any]]] = [None] * pad_start
        for d in heat_list:
            week.append(d)
            if len(week) == 7:
                heatmap_weeks.append(week)
                week = []
        if week:
            while len(week) < 7:
                week.append(None)
            heatmap_weeks.append(week)

    result = {
        "ok": True,
        "range": range_key or "7",
        "range_label": range_label(range_key),
        "generated_at": int(time.time() * 1000),
        "db_path": str(MIMO_DB_PATH),
        "db_exists": MIMO_DB_PATH.exists(),
        "chart_days": chart_days,
        "heat_days": heat_days,
        "totals": {
            "tokens": total,
            "fmt": format_token_lx(total),
            "today": total_today,
            "today_fmt": format_token_lx(total_today),
            "turns": total_turns,
            "input": sum_in,
            "output": sum_out,
            "reasoning": sum_reason,
            "cache_read": sum_cr,
            "cache_write": sum_cw,
            "cache": sum_cr + sum_cw,
            "cache_hit": cache_hit_rate(sum_cr, sum_cw, sum_in),
            "avg_daily": avg_daily,
            "avg_daily_fmt": format_token_lx(avg_daily),
            "avg_per_turn": round(total / total_turns) if total_turns else 0,
            "avg_per_turn_fmt": format_token_lx(total / total_turns) if total_turns else "0",
            "sessions": len(sess_agg),
            "projects": len(proj_agg),
            "models": len(model_agg),
        },
        "insights": {
            "peak_day": {
                "date": peak_day["date"],
                "label": peak_day["label"],
                "tokens": peak_day["tokens"],
                "fmt": peak_day["fmt"],
            }
            if peak_day and peak_day["tokens"] > 0
            else None,
            "peak_hour": {
                "hour": peak_hour["hour"],
                "tokens": peak_hour["tokens"],
                "fmt": peak_hour["fmt"],
            }
            if peak_hour and peak_hour["tokens"] > 0
            else None,
            "busiest_model": by_model[0] if by_model else None,
            "busiest_project": by_project[0] if by_project else None,
            "busiest_session": by_session[0] if by_session else None,
        },
        "days": days_list,
        "heatmap_weeks": heatmap_weeks,
        "hourly": hourly,
        "hourly_models": top_models + ["其他"],
        "weekday_hour": {
            "labels": ["一", "二", "三", "四", "五", "六", "日"],
            "tokens": wd_hour,
            "turns": wd_hour_turns,
            "max": max(max(row) for row in wd_hour) if wd_hour else 0,
            "models": [
                [
                    [
                        {"model": mid, "tokens": mt}
                        for mid, mt in sorted(wd_hour_models[w][h].items(), key=lambda x: -x[1])
                    ][:6]
                    for h in range(24)
                ]
                for w in range(7)
            ],
        },
        "by_model": by_model,
        "by_project": by_project,
        "by_session": by_session,
        "composition": {
            "input": sum_in,
            "output": sum_out,
            "reasoning": sum_reason,
            "cache": sum_cr + sum_cw,
            "total": total or 1,
            "input_pct": round(sum_in / total * 100, 1) if total else 0,
            "output_pct": round(sum_out / total * 100, 1) if total else 0,
            "reasoning_pct": round(sum_reason / total * 100, 1) if total else 0,
            "cache_pct": round((sum_cr + sum_cw) / total * 100, 1) if total else 0,
        },
    }
    cache_set(cache_key, result)
    return result


def session_detail(session_id: str) -> Dict[str, Any]:
    cache_key = f"sess:{session_id}"
    hit = cache_get(cache_key)
    if hit is not None:
        return hit

    conn = open_db()
    try:
        c = conn.cursor()
        c.execute(
            "SELECT title, directory, time_created, time_updated FROM session WHERE id = ?",
            (session_id,),
        )
        meta = c.fetchone()
        c.execute(
            "SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
            (session_id,),
        )
        rows = c.fetchall()
    finally:
        conn.close()

    turns = []
    totals = {
        "tokens": 0,
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cache_write": 0,
        "turns": 0,
    }
    models: Dict[str, Dict[str, int]] = defaultdict(lambda: {
        "tokens": 0, "turns": 0, "input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
    })

    for raw, tcreated in rows:
        parsed = parse_tokens(raw["data"] if isinstance(raw, sqlite3.Row) else raw)
        if not parsed:
            continue
        tc = parsed["msg_time"] or int(tcreated or 0)
        totals["tokens"] += parsed["total"]
        totals["input"] += parsed["input"]
        totals["output"] += parsed["output"]
        totals["reasoning"] += parsed["reasoning"]
        totals["cache_read"] += parsed["cache_read"]
        totals["cache_write"] += parsed["cache_write"]
        totals["turns"] += 1
        st = models[parsed["model"]]
        st["tokens"] += parsed["total"]
        st["turns"] += 1
        st["input"] += parsed["input"]
        st["output"] += parsed["output"]
        st["reasoning"] += parsed["reasoning"]
        st["cache_read"] += parsed["cache_read"]
        st["cache_write"] += parsed["cache_write"]
        turns.append(
            {
                "time": tc,
                "time_label": datetime.fromtimestamp(tc / 1000).strftime("%m-%d %H:%M:%S") if tc else "",
                "model": parsed["model"],
                **{k: parsed[k] for k in ("input", "output", "reasoning", "cache_read", "cache_write", "total")},
            }
        )

    result = {
        "ok": True,
        "id": session_id,
        "title": (meta["title"] if meta else "") or session_id,
        "directory": meta["directory"] if meta else "",
        "project_name": os.path.basename((meta["directory"] if meta else "").rstrip("/\\")) or "(未分配目录)",
        "created": int(meta["time_created"]) if meta else 0,
        "updated": int(meta["time_updated"]) if meta else 0,
        "totals": {
            **totals,
            "fmt": format_token_lx(totals["tokens"]),
            "cache_hit": cache_hit_rate(totals["cache_read"], totals["cache_write"], totals["input"]),
        },
        "models": [
            pack_mstat(mid, st, totals["tokens"])
            for mid, st in sorted(models.items(), key=lambda x: -x[1]["tokens"])
        ],
        "turns": turns[-200:],
    }
    cache_set(cache_key, result)
    return result


def get_day_hourly(date_str: str) -> Dict[str, Any]:
    """某一天的 24 小时分模型用量（供点选日历后联动时段活跃）。"""
    cache_key = f"dayh:{date_str}"
    hit = cache_get(cache_key)
    if hit is not None:
        return hit
    try:
        day = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return {"ok": False, "error": "bad date"}
    start = int(day.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    end = start + 86400 * 1000
    # 只查当天消息，避免每次全库扫描
    items: List[Dict[str, Any]] = []
    conn = open_db()
    try:
        c = conn.cursor()
        c.execute(
            "SELECT data, time_created FROM message WHERE time_created >= ? AND time_created < ?",
            (start, end),
        )
        for raw, tcreated in c.fetchall():
            parsed = parse_tokens(raw)
            if not parsed:
                continue
            tc = parsed["msg_time"] or int(tcreated or 0)
            if tc < start or tc >= end:
                continue
            items.append({
                "session_id": "",
                "title": "",
                "directory": "",
                "project_name": "",
                "time": tc,
                **parsed,
            })
    finally:
        conn.close()

    hour_tokens = [0] * 24
    hour_turns = [0] * 24
    hour_models: List[Dict[str, Dict[str, int]]] = [defaultdict(new_mstat) for _ in range(24)]
    for it in items:
        h = datetime.fromtimestamp(it["time"] / 1000).hour
        hour_tokens[h] += it["total"]
        hour_turns[h] += 1
        bump_mstat(hour_models[h][it["model"]], it, it["total"])

    # rank models for this day
    model_tot: Dict[str, int] = defaultdict(int)
    for st_list in hour_models:
        for mid, st in st_list.items():
            model_tot[mid] += st.get("tokens", 0)
    top_models = [mid for mid, _ in sorted(model_tot.items(), key=lambda x: -x[1])[:5]]

    max_hour = max(hour_tokens) if hour_tokens else 0
    hourly = []
    total = sum(hour_tokens)
    for h in range(24):
        hm = hour_models[h]
        stacks = []
        for mid in top_models:
            st = hm.get(mid)
            if st:
                stacks.append(pack_mstat(mid, st, hour_tokens[h]))
        o_tok = o_in = o_out = o_cr = o_cw = o_turns = 0
        for mid, st in hm.items():
            if mid not in top_models:
                o_tok += st.get("tokens", 0)
                o_in += st.get("input", 0)
                o_out += st.get("output", 0) + st.get("reasoning", 0)
                o_cr += st.get("cache_read", 0)
                o_cw += st.get("cache_write", 0)
                o_turns += st.get("turns", 0)
        if o_tok or o_turns:
            stacks.append(pack_mstat("其他", {
                "tokens": o_tok, "turns": o_turns, "input": o_in, "output": o_out,
                "reasoning": 0, "cache_read": o_cr, "cache_write": o_cw,
            }, hour_tokens[h]))
        hourly.append({
            "hour": h,
            "tokens": hour_tokens[h],
            "turns": hour_turns[h],
            "fmt": format_token_lx(hour_tokens[h]),
            "pct": round(hour_tokens[h] / max_hour * 100) if max_hour else 0,
            "stacks": stacks,
        })

    result = {
        "ok": True,
        "date": date_str,
        "total": total,
        "total_fmt": format_token_lx(total),
        "turns": sum(hour_turns),
        "input": 0,
        "output": 0,
        "cache": 0,
        "cache_hit": 0,
        "avg": 0,
        "avg_fmt": "0",
        "models": [],
        "hourly": hourly,
        "hourly_models": top_models + ["其他"],
        "peak_hour": max(hourly, key=lambda x: x["tokens"])["hour"] if any(h["tokens"] for h in hourly) else None,
    }
    # 当日合计 IO / 命中
    t_in = t_out = t_cr = t_cw = 0
    day_model_tot: Dict[str, Dict[str, int]] = defaultdict(new_mstat)
    for it in items:
        t_in += it["input"]
        t_out += it["output"] + it["reasoning"]
        t_cr += it["cache_read"]
        t_cw += it["cache_write"]
        bump_mstat(day_model_tot[it["model"]], it, it["total"])
    result["input"] = t_in
    result["output"] = t_out
    result["cache"] = t_cr + t_cw
    result["cache_hit"] = cache_hit_rate(t_cr, t_cw, t_in)
    turns_n = result["turns"]
    result["avg"] = round(total / turns_n) if turns_n else 0
    result["avg_fmt"] = format_token_lx(total / turns_n) if turns_n else "0"
    result["models"] = [
        pack_mstat(mid, st, total)
        for mid, st in sorted(day_model_tot.items(), key=lambda x: -x[1]["tokens"])[:8]
    ]
    cache_set(cache_key, result)
    return result


def get_days_hourly(dates: List[str]) -> Dict[str, Any]:
    """多天合并后的 24 小时分模型用量（Shift 多选日历）。"""
    dates = [d for d in dates if d]
    cache_key = f"days:{','.join(sorted(set(dates)))}"
    hit = cache_get(cache_key)
    if hit is not None:
        return hit
    if not dates:
        return {"ok": False, "error": "no dates"}

    # 合并各日 hourly / models
    hour_tokens = [0] * 24
    hour_turns = [0] * 24
    hour_models: List[Dict[str, Dict[str, int]]] = [defaultdict(new_mstat) for _ in range(24)]
    day_model_tot: Dict[str, Dict[str, int]] = defaultdict(new_mstat)
    total = turns_n = t_in = t_out = t_cr = t_cw = 0

    for ds in dates[:32]:  # 防过多
        try:
            day = datetime.strptime(ds, "%Y-%m-%d")
        except ValueError:
            continue
        start = int(day.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        end = start + 86400 * 1000
        conn = open_db()
        try:
            c = conn.cursor()
            c.execute(
                "SELECT data, time_created FROM message WHERE time_created >= ? AND time_created < ?",
                (start, end),
            )
            for raw, tcreated in c.fetchall():
                parsed = parse_tokens(raw)
                if not parsed:
                    continue
                tc = parsed["msg_time"] or int(tcreated or 0)
                if tc < start or tc >= end:
                    continue
                it = {
                    "time": tc,
                    **parsed,
                }
                h = datetime.fromtimestamp(tc / 1000).hour
                hour_tokens[h] += it["total"]
                hour_turns[h] += 1
                bump_mstat(hour_models[h][it["model"]], it, it["total"])
                bump_mstat(day_model_tot[it["model"]], it, it["total"])
                total += it["total"]
                turns_n += 1
                t_in += it["input"]
                t_out += it["output"] + it["reasoning"]
                t_cr += it["cache_read"]
                t_cw += it["cache_write"]
        finally:
            conn.close()

    model_tot: Dict[str, int] = defaultdict(int)
    for st_list in hour_models:
        for mid, st in st_list.items():
            model_tot[mid] += st.get("tokens", 0)
    top_models = [mid for mid, _ in sorted(model_tot.items(), key=lambda x: -x[1])[:5]]
    max_hour = max(hour_tokens) if hour_tokens else 0
    hourly = []
    for h in range(24):
        hm = hour_models[h]
        stacks = []
        for mid in top_models:
            st = hm.get(mid)
            if st:
                stacks.append(pack_mstat(mid, st, hour_tokens[h]))
        o_tok = o_in = o_out = o_cr = o_cw = o_turns = 0
        for mid, st in hm.items():
            if mid not in top_models:
                o_tok += st.get("tokens", 0)
                o_in += st.get("input", 0)
                o_out += st.get("output", 0) + st.get("reasoning", 0)
                o_cr += st.get("cache_read", 0)
                o_cw += st.get("cache_write", 0)
                o_turns += st.get("turns", 0)
        if o_tok or o_turns:
            stacks.append(pack_mstat("其他", {
                "tokens": o_tok, "turns": o_turns, "input": o_in, "output": o_out,
                "reasoning": 0, "cache_read": o_cr, "cache_write": o_cw,
            }, hour_tokens[h]))
        hourly.append({
            "hour": h,
            "tokens": hour_tokens[h],
            "turns": hour_turns[h],
            "fmt": format_token_lx(hour_tokens[h]),
            "pct": round(hour_tokens[h] / max_hour * 100) if max_hour else 0,
            "stacks": stacks,
        })

    result = {
        "ok": True,
        "dates": dates[:32],
        "day_count": len(dates[:32]),
        "total": total,
        "total_fmt": format_token_lx(total),
        "turns": turns_n,
        "input": t_in,
        "output": t_out,
        "cache": t_cr + t_cw,
        "cache_hit": cache_hit_rate(t_cr, t_cw, t_in),
        "avg": round(total / turns_n) if turns_n else 0,
        "avg_fmt": format_token_lx(total / turns_n) if turns_n else "0",
        "models": [
            pack_mstat(mid, st, total)
            for mid, st in sorted(day_model_tot.items(), key=lambda x: -x[1]["tokens"])[:8]
        ],
        "hourly": hourly,
        "hourly_models": top_models + ["其他"],
        "peak_hour": max(hourly, key=lambda x: x["tokens"])["hour"] if any(h["tokens"] for h in hourly) else None,
    }
    cache_set(cache_key, result)
    return result


def export_csv(range_key: str) -> str:
    items = collect_rows(range_key)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "time",
            "session_id",
            "title",
            "project",
            "directory",
            "model",
            "input",
            "output",
            "reasoning",
            "cache_read",
            "cache_write",
            "total",
        ]
    )
    for it in items:
        ts = datetime.fromtimestamp(it["time"] / 1000).isoformat(sep=" ", timespec="seconds")
        w.writerow(
            [
                ts,
                it["session_id"],
                it["title"],
                it["project_name"],
                it["directory"],
                it["model"],
                it["input"],
                it["output"],
                it["reasoning"],
                it["cache_read"],
                it["cache_write"],
                it["total"],
            ]
        )
    return buf.getvalue()


def get_user_quota() -> Dict[str, Any]:
    """通过小米 SSO cookie 查询官方周配额（可选能力）。"""
    import shutil
    import tempfile
    import urllib.error
    import urllib.request

    cookie_path = next((p for p in COOKIE_CANDIDATES if p.exists()), None)
    if not cookie_path:
        return {"ok": False, "reason": "no-cookie-db", "percent": None, "resetDate": None}

    pass_token = user_id = None
    try:
        tmp = tempfile.mktemp(suffix=".db")
        shutil.copy2(str(cookie_path), tmp)
        conn = sqlite3.connect(tmp, timeout=3)
        c = conn.cursor()
        try:
            c.execute("SELECT name, value FROM cookies WHERE name IN ('passToken','userId','cUserId')")
            for name, val in c.fetchall():
                if name == "passToken":
                    pass_token = val
                elif name == "userId":
                    user_id = val
        except Exception:
            pass
        conn.close()
        os.unlink(tmp)
    except Exception:
        return {"ok": False, "reason": "cookie-read-failed", "percent": None, "resetDate": None}

    if not pass_token or not user_id:
        return {"ok": False, "reason": "no-sso", "percent": None, "resetDate": None}

    for url in (
        "https://api.xiaomimimo.com/user/usage",
        "https://api.xiaomimimo.com/v1/user/usage",
    ):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Cookie": f"passToken={pass_token}; userId={user_id}",
                    "User-Agent": "MiMo Token Stats/1.0",
                    "Accept": "application/json",
                },
            )
            resp = urllib.request.urlopen(req, timeout=6)
            data = json.loads(resp.read().decode())
            if isinstance(data, dict) and data.get("code") == 0:
                d = data.get("data") or {}
                return {
                    "ok": True,
                    "percent": d.get("percent"),
                    "resetDate": d.get("resetDate"),
                    "period": "1 周",
                }
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return {"ok": False, "reason": "auth-expired", "percent": None, "resetDate": None}
        except Exception:
            continue

    return {"ok": False, "reason": "failed", "percent": None, "resetDate": None}


def health_status() -> Dict[str, Any]:
    exists = MIMO_DB_PATH.exists()
    size = MIMO_DB_PATH.stat().st_size if exists else 0
    msg_count = None
    sess_count = None
    err = None
    if exists:
        try:
            conn = open_db()
            try:
                c = conn.cursor()
                c.execute("SELECT COUNT(*) FROM message")
                msg_count = c.fetchone()[0]
                c.execute("SELECT COUNT(*) FROM session")
                sess_count = c.fetchone()[0]
            finally:
                conn.close()
        except Exception as e:
            err = str(e)
    return {
        "ok": exists and err is None,
        "db_path": str(MIMO_DB_PATH),
        "db_exists": exists,
        "db_size": size,
        "db_size_fmt": format_token_lx(size) if size else "0",
        "messages": msg_count,
        "sessions": sess_count,
        "error": err,
        "time": int(time.time() * 1000),
    }


# ── HTTP ─────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MiMoTokenStats/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, text: str, content_type: str = "text/plain; charset=utf-8", status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self._json({"ok": False, "error": "not found"}, 404)
            return
        data = path.read_bytes()
        ext = path.suffix.lower()
        ctype = MIME.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = dict(urllib.parse.parse_qsl(parsed.query))

        try:
            if path in ("/", "/index.html"):
                self._file(FRONTEND_ROOT / "index.html")
                return
            if path.startswith("/assets/") or path.startswith("/css/") or path.startswith("/js/"):
                rel = path.lstrip("/")
                # prevent path traversal
                target = (FRONTEND_ROOT / rel).resolve()
                if not str(target).startswith(str(FRONTEND_ROOT.resolve())):
                    self._json({"ok": False, "error": "forbidden"}, 403)
                    return
                self._file(target)
                return

            if path == "/api/health" or path == "/api/status":
                self._json(health_status())
                return

            if path == "/api/overview" or path == "/api/usage":
                rk = qs.get("range", "7")
                try:
                    self._json(aggregate(rk))
                except FileNotFoundError as e:
                    self._json({"ok": False, "error": str(e)}, 503)
                except Exception as e:
                    self._json({"ok": False, "error": str(e)}, 500)
                return

            if path == "/api/session":
                sid = qs.get("id", "")
                if not sid:
                    self._json({"ok": False, "error": "missing id"}, 400)
                    return
                try:
                    self._json(session_detail(sid))
                except Exception as e:
                    self._json({"ok": False, "error": str(e)}, 500)
                return

            if path == "/api/day-hourly":
                date_s = qs.get("date", "")
                if not date_s:
                    self._json({"ok": False, "error": "missing date"}, 400)
                    return
                try:
                    self._json(get_day_hourly(date_s))
                except Exception as e:
                    self._json({"ok": False, "error": str(e)}, 500)
                return

            if path == "/api/days-hourly":
                dates = qs.get("dates", "")
                date_list = [x.strip() for x in dates.split(",") if x.strip()]
                if not date_list:
                    self._json({"ok": False, "error": "missing dates"}, 400)
                    return
                try:
                    self._json(get_days_hourly(date_list))
                except Exception as e:
                    self._json({"ok": False, "error": str(e)}, 500)
                return

            if path == "/api/quota":
                self._json(get_user_quota())
                return

            if path == "/api/export.csv":
                rk = qs.get("range", "7")
                try:
                    csv_text = export_csv(rk)
                except Exception as e:
                    self._json({"ok": False, "error": str(e)}, 500)
                    return
                fname = f"mimo-token-{rk}-{datetime.now().strftime('%Y%m%d-%H%M')}.csv"
                body = csv_text.encode("utf-8-sig")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if path == "/api/refresh":
                cache_clear()
                global _FULL_ITEMS, _FULL_META, _FULL_ITEMS_AT
                _FULL_ITEMS = None
                _FULL_META = None
                _FULL_ITEMS_AT = 0.0
                self._json({"ok": True, "cleared": True})
                return

            self._json({"ok": False, "error": "not found", "path": path}, 404)
        except BrokenPipeError:
            pass
        except ConnectionResetError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Xiaomi MiMo Token Statistics")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--db", type=str, default=None, help="自定义 mimocode.db 路径")
    args = parser.parse_args()

    global MIMO_DB_PATH
    if args.db:
        MIMO_DB_PATH = Path(args.db).expanduser().resolve()

    print("=" * 56)
    print("  Xiaomi MiMo Token Statistics")
    print("=" * 56)
    print(f"  数据库 : {MIMO_DB_PATH}")
    print(f"  状态   : {'已找到' if MIMO_DB_PATH.exists() else '未找到（请确认 MiMo Desktop 已使用过）'}")
    print(f"  前端   : {FRONTEND_ROOT / 'index.html'}")
    print(f"  地址   : http://{args.host}:{args.port}/")
    if args.host in ("0.0.0.0", "::"):
        try:
            import socket

            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            print(f"  局域网 : http://{ip}:{args.port}/")
        except Exception:
            pass
    print("  按 Ctrl+C 停止")
    print("=" * 56)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
