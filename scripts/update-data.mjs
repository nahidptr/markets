#!/usr/bin/env node
/**
 * Refresh public/data/prices.json.
 *
 *   npm run update-data            download and rewrite the file
 *   npm run update-data -- --dry   download, print a summary, write nothing
 *   npm run check-data             exit 1 if the data is more than 2 months old
 *
 * Sources (no API keys):
 *   - Yahoo Finance chart API: month-end, dividend-adjusted closes for each asset's `ticker`,
 *     and month-end FX closes for "<CUR>=X" (units of currency per 1 USD).
 *   - US CPI-U from https://github.com/datasets/cpi-us
 *
 * Months a new download doesn't cover (e.g. Bitcoin before Sep 2014 on Yahoo) are kept from the
 * existing file and rescaled so the series joins smoothly. The file only extends to the last month
 * for which every asset has a price, so nothing is invented.
 *
 * To add an asset: append an entry to `assets` in prices.json with id, name, short, ticker, group,
 * flag and note, plus "prices": []. The next run fills it in.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'public', 'data', 'prices.json');
const START = '2009-12';
const CPI_URL = 'https://raw.githubusercontent.com/datasets/cpi-us/main/data/cpiai.csv';
const UA = 'Mozilla/5.0 (compatible; gold-vs-markets data updater)';

export function monthRange(start, end) {
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m === 13) { y++; m = 1; }
  }
  return out;
}

export function lastCompleteMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Parse a Yahoo chart API response into { 'YYYY-MM': close } for completed months. */
export function parseYahooMonthly(json, lastMonth) {
  const r = json?.chart?.result?.[0];
  if (!r || !r.timestamp) return {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const close = r.indicators?.quote?.[0]?.close;
  const vals = adj && adj.some((v) => v != null) ? adj : close;
  const out = {};
  r.timestamp.forEach((ts, i) => {
    const v = vals?.[i];
    if (v == null || !Number.isFinite(v) || v <= 0) return;
    const d = new Date(ts * 1000);
    // Yahoo stamps monthly bars at the start of the month (exchange time); shift by 12 h to be safe.
    const dd = new Date(d.getTime() + 12 * 3600 * 1000);
    const key = `${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, '0')}`;
    if (key <= lastMonth) out[key] = v;
  });
  return out;
}

export async function fetchYahoo(symbol, lastMonth, fetchImpl = fetch) {
  const p1 = Math.floor(Date.UTC(2009, 10, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1mo&events=div%2Csplit&includeAdjustedClose=true`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseYahooMonthly(await res.json(), lastMonth);
    } catch (e) {
      if (attempt === 3) throw new Error(`${symbol}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return {};
}

/** Prefer new values; fill months before the new series from the old one, rescaled at the first overlap. */
export function splice(oldPrices, oldMonths, fresh, months) {
  const oldMap = {};
  oldMonths.forEach((m, i) => { if (oldPrices?.[i] != null) oldMap[m] = oldPrices[i]; });
  const freshKeys = Object.keys(fresh).sort();
  const firstFresh = freshKeys[0];
  const overlap = months.find((m) => fresh[m] != null && oldMap[m] != null);
  const scale = overlap ? fresh[overlap] / oldMap[overlap] : 1;
  return months.map((m) => {
    let v = fresh[m];
    if (v == null && oldMap[m] != null && (!firstFresh || m < firstFresh)) v = oldMap[m] * scale;
    if (v == null && !firstFresh && oldMap[m] != null) v = oldMap[m];
    return v == null ? null : +v.toPrecision(7);
  });
}

/** Forward-fill gaps after the first value (used for FX and CPI). */
export function ffill(arr) {
  let last = null;
  const out = arr.map((v) => { if (v != null) last = v; return v ?? last; });
  const first = out.find((v) => v != null);
  return out.map((v) => v ?? first);
}

export async function fetchCpi(fetchImpl = fetch) {
  const res = await fetchImpl(CPI_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CPI HTTP ${res.status}`);
  const map = {};
  for (const line of (await res.text()).split(/\r?\n/).slice(1)) {
    const [date, idx] = line.split(',');
    if (date && idx) map[date.slice(0, 7)] = parseFloat(idx);
  }
  return map;
}

export async function update(data, { fetchImpl = fetch, now = new Date(), log = console.error } = {}) {
  const target = lastCompleteMonth(now);
  const allMonths = monthRange(START, target);
  const failures = [];

  const fresh = {};
  for (const a of data.assets) {
    try { fresh[a.id] = await fetchYahoo(a.ticker, target, fetchImpl); }
    catch (e) { failures.push(e.message); fresh[a.id] = {}; }
  }
  const fxFresh = {};
  for (const c of Object.keys(data.fx)) {
    try { fxFresh[c] = await fetchYahoo(`${c}=X`, target, fetchImpl); }
    catch (e) { failures.push(e.message); fxFresh[c] = {}; }
  }

  // Splice every asset over the full target range, then cut at the last month all assets share.
  const spliced = Object.fromEntries(data.assets.map((a) => [a.id, splice(a.prices, data.months, fresh[a.id], allMonths)]));
  let endIdx = allMonths.length - 1;
  for (const a of data.assets) {
    const p = spliced[a.id];
    let last = p.length - 1;
    while (last >= 0 && p[last] == null) last--;
    endIdx = Math.min(endIdx, last);
  }
  const months = allMonths.slice(0, endIdx + 1);
  if (months.length < data.months.length) throw new Error(`Refusing to shrink data: new end ${months.at(-1)} is before ${data.end}`);

  const assets = data.assets.map((a) => {
    const prices = spliced[a.id].slice(0, months.length);
    const fi = prices.findIndex((v) => v != null);
    return { ...a, first: months[fi], prices };
  });
  const fx = Object.fromEntries(Object.keys(data.fx).map((c) => [c, ffill(splice(data.fx[c], data.months, fxFresh[c], months))]));

  let cpiUS = data.cpiUS;
  try {
    const cpi = await fetchCpi(fetchImpl);
    const oldMap = Object.fromEntries(data.months.map((m, i) => [m, data.cpiUS[i]]));
    cpiUS = ffill(months.map((m) => cpi[m] ?? oldMap[m] ?? null));
  } catch (e) {
    failures.push(e.message);
    cpiUS = ffill(months.map((m, i) => data.cpiUS[i] ?? null));
  }

  for (const a of assets) log(`  ${a.id.padEnd(10)} ${a.ticker.padEnd(8)} ${a.first} → ${months.at(-1)}  ${a.prices.at(-1)}`);
  if (failures.length) log(`\n${failures.length} download(s) failed:\n  ${failures.join('\n  ')}`);

  return {
    failures,
    data: {
      ...data,
      updated: now.toISOString().slice(0, 10),
      start: months[0], end: months.at(-1), months, assets, fx, cpiUS,
      fxNote: 'Units of currency per 1 USD. Month-end closes from Yahoo Finance where available; older months may be Federal Reserve monthly averages.',
    },
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const lastMonth = data.end;
  const [y, m] = lastMonth.split('-').map(Number);
  const now = new Date();
  const age = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);

  if (args.has('--check')) {
    console.log(`Data ends ${lastMonth} (${age} month(s) ago). Last updated ${data.updated}.`);
    process.exit(age > 2 ? 1 : 0);
  }

  console.error(`Updating ${data.assets.length} assets and ${Object.keys(data.fx).length} currencies (data currently ends ${lastMonth})…`);
  const { data: next, failures } = await update(data);
  const tooMany = failures.length > Math.max(3, (data.assets.length + Object.keys(data.fx).length) / 4);
  if (args.has('--dry')) { console.error('\nDry run, nothing written.'); return; }
  await writeFile(DATA_FILE, JSON.stringify(next));
  console.error(`\nWrote ${path.relative(ROOT, DATA_FILE)}: ${next.start} → ${next.end}`);
  if (tooMany) { console.error('Too many downloads failed. Kept what we had, but failing so you notice.'); process.exit(1); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
