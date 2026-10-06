#!/usr/bin/env python3
"""Refresh data/prices.json from Yahoo Finance (via yfinance) and the US CPI dataset.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/update_data.py            # update in place
    python scripts/update_data.py --dry-run  # print a summary, write nothing

How it merges:
- Each asset is downloaded as month-end, dividend-adjusted closes in USD.
- Months before the new download starts (e.g. Bitcoin before Sep 2014 on Yahoo)
  are kept from the existing file, rescaled so the series joins without a jump.
- FX rates are month-end closes of "<CUR>=X" (units of currency per 1 USD).
- US CPI comes from https://github.com/datasets/cpi-us. A missing latest month
  carries the previous value forward.

To add an asset, add an entry to ASSETS below and a colour token
(--a-<id>) in assets/styles.css for both light and dark themes.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "prices.json"
START = "2009-12"
CPI_URL = "https://raw.githubusercontent.com/datasets/cpi-us/main/data/cpiai.csv"

# id -> Yahoo symbol. Names, notes and order live in prices.json; new ids get defaults.
ASSETS = {
    "spx": "SPY",
    "smallcap": "IWM",
    "nifty": "INDY",
    "ftse": "EWU",
    "swiss": "EWL",
    "omx": "EWD",
    "taiwan": "EWT",
    "gold": "GLD",
    "silver": "SLV",
    "btc": "BTC-USD",
}
CURRENCIES = ["EUR", "GBP", "CHF", "SEK", "INR", "AUD", "TWD", "JPY", "CAD", "SGD", "NOK", "DKK",
              "CNY", "HKD", "KRW", "NZD", "ZAR", "MXN", "BRL", "THB", "MYR"]


def month_range(start: str, end: str) -> list[str]:
    y, m = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def last_complete_month(today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    first = today.replace(day=1)
    prev = first - dt.timedelta(days=1)
    return f"{prev.year:04d}-{prev.month:02d}"


def download_monthly(symbols: list[str], start: str) -> dict[str, dict[str, float]]:
    """Return {symbol: {YYYY-MM: month-end adjusted close}}."""
    import yfinance as yf  # imported lazily so tests can run without it

    df = yf.download(symbols, start=f"{start}-01", interval="1d", auto_adjust=True,
                     progress=False, group_by="column", threads=True)
    close = df["Close"] if "Close" in df else df
    if hasattr(close, "to_frame") and len(symbols) == 1:
        close = close.to_frame(symbols[0])
    monthly = close.resample("ME").last()
    out: dict[str, dict[str, float]] = {}
    for sym in symbols:
        if sym not in monthly:
            continue
        s = monthly[sym].dropna()
        out[sym] = {d.strftime("%Y-%m"): float(v) for d, v in s.items() if v and math.isfinite(v)}
    return out


def splice(old: list[float | None], old_months: list[str], new: dict[str, float], months: list[str]) -> list[float | None]:
    """Prefer new values; fill earlier months from old, rescaled at the first overlap."""
    old_map = {m: v for m, v in zip(old_months, old) if v is not None}
    overlap = [m for m in months if m in new and m in old_map]
    scale = new[overlap[0]] / old_map[overlap[0]] if overlap else 1.0
    out: list[float | None] = []
    last = None
    for m in months:
        v = new.get(m)
        if v is None and m in old_map and (not new or m < min(new)):
            v = old_map[m] * scale
        if v is None and last is not None and new and m > min(new):
            v = last  # gap inside the new series: carry forward
        out.append(None if v is None else round(v, 6 if v < 1 else 2))
        if v is not None:
            last = v
    return out


def fetch_cpi(months: list[str]) -> list[float]:
    with urllib.request.urlopen(CPI_URL, timeout=60) as r:
        text = r.read().decode()
    cpi = {}
    for line in io.StringIO(text).read().splitlines()[1:]:
        parts = line.split(",")
        if len(parts) >= 2 and parts[1]:
            cpi[parts[0][:7]] = float(parts[1])
    out, last = [], None
    for m in months:
        last = cpi.get(m, last)
        out.append(last)
    if out[0] is None:
        raise SystemExit("CPI data does not cover the start month")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--end", default=last_complete_month(), help="last month to include, YYYY-MM")
    args = ap.parse_args()

    data = json.loads(DATA_FILE.read_text())
    months = month_range(START, args.end)

    symbols = list(ASSETS.values()) + [f"{c}=X" for c in CURRENCIES]
    print(f"Downloading {len(symbols)} symbols from Yahoo Finance…", file=sys.stderr)
    dl = download_monthly(symbols, START)

    by_id = {a["id"]: a for a in data["assets"]}
    for aid, sym in ASSETS.items():
        new = dl.get(sym, {})
        if not new:
            print(f"  ! no data for {sym}; keeping old series", file=sys.stderr)
        a = by_id.setdefault(aid, {"id": aid, "name": aid, "ticker": sym, "kind": "stocks", "note": sym})
        a["prices"] = splice(a.get("prices", []), data["months"], new, months)
        first = next((m for m, p in zip(months, a["prices"]) if p is not None), None)
        a["first"] = first
        print(f"  {aid:9s} {sym:8s} {first} … {months[-1]} last={a['prices'][-1]}", file=sys.stderr)
    data["assets"] = [by_id[a["id"]] for a in data["assets"]] + [by_id[i] for i in ASSETS if i not in {a["id"] for a in data["assets"]}]

    fx = {}
    for c in CURRENCIES:
        new = dl.get(f"{c}=X", {})
        old = data.get("fx", {}).get(c, [])
        fx[c] = splice(old, data["months"], new, months)
        if fx[c][0] is None:  # fall back to the first known value
            first = next(v for v in fx[c] if v is not None)
            fx[c] = [first if v is None else v for v in fx[c]]
    data["fx"] = fx
    data["fxNote"] = "Month-end exchange rates from Yahoo Finance (<CUR>=X), units of currency per 1 USD; older months may be Federal Reserve monthly averages."
    data["cpiUS"] = fetch_cpi(months)
    data["months"] = months
    data["start"], data["end"] = months[0], months[-1]
    data["updated"] = dt.date.today().isoformat()

    if args.dry_run:
        print("Dry run: not writing.", file=sys.stderr)
        return 0
    DATA_FILE.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Wrote {DATA_FILE.relative_to(ROOT)} ({len(months)} months)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
