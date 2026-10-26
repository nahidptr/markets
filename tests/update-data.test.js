import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monthRange, lastCompleteMonth, parseYahooMonthly, splice, ffill, update } from '../scripts/update-data.mjs';

test('monthRange and lastCompleteMonth', () => {
  assert.deepEqual(monthRange('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(lastCompleteMonth(new Date(Date.UTC(2026, 0, 3))), '2025-12');
  assert.equal(lastCompleteMonth(new Date(Date.UTC(2026, 9, 31))), '2026-09');
});

test('parseYahooMonthly uses adjclose and drops the running month', () => {
  const ts = [Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)].map((t) => t / 1000 - 4 * 3600);
  const json = { chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: [1, 2, 3] }], adjclose: [{ adjclose: [10, null, 30] }] } }] } };
  assert.deepEqual(parseYahooMonthly(json, '2026-09'), { '2026-08': 10 });
});

test('splice rescales old history onto the new series', () => {
  const months = ['a1', 'a2', 'a3', 'a4'];
  const out = splice([1, 2, 4, 8], months, { a3: 8, a4: 16 }, months);
  assert.deepEqual(out, [2, 4, 8, 16]);
  // no fresh data: keep old as-is
  assert.deepEqual(splice([1, 2, null], ['x', 'y', 'z'], {}, ['x', 'y', 'z']), [1, 2, null]);
});

test('ffill', () => {
  assert.deepEqual(ffill([null, 2, null, 4, null]), [2, 2, 2, 4, 4]);
});

test('update() with a mocked network extends every series by one month', async () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/prices.json', import.meta.url)));
  const lastIdx = data.months.length - 1;
  const [y, m] = data.end.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // first day of the month after `end`
  const now = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 2)); // so `next` is complete
  const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;

  const yahoo = (series) => {
    const ts = [], vals = [];
    data.months.forEach((mm, i) => { const [yy, mo] = mm.split('-').map(Number); if (series[i] != null) { ts.push(Date.UTC(yy, mo - 1, 1) / 1000); vals.push(series[i] * 2); } });
    ts.push(next.getTime() / 1000); vals.push(series[lastIdx] * 2.2);
    return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: vals }], adjclose: [{ adjclose: vals }] } }] } };
  };
  const byTicker = Object.fromEntries(data.assets.map((a) => [a.ticker, a.prices]));
  const fx = Object.fromEntries(Object.entries(data.fx).map(([c, v]) => [`${c}=X`, v]));
  const fetchImpl = async (url) => {
    if (url.includes('cpi-us')) return { ok: true, text: async () => 'Date,Index\n' + data.months.map((mm, i) => `${mm}-01,${data.cpiUS[i]}`).join('\n') };
    const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    const s = byTicker[sym] || fx[sym];
    if (!s) return { ok: false, status: 404 };
    return { ok: true, json: async () => yahoo(s) };
  };
  const { data: out, failures } = await update(data, { fetchImpl, now, log: () => {} });
  assert.deepEqual(failures, []);
  assert.equal(out.end, nextKey);
  assert.equal(out.months.length, data.months.length + 1);
  const btc = out.assets.find((a) => a.id === 'btc');
  const oldBtc = data.assets.find((a) => a.id === 'btc');
  assert.equal(btc.first, oldBtc.first);
  // every series doubled (mock), the new month is +10%
  for (const a of out.assets) {
    const o = data.assets.find((x) => x.id === a.id);
    assert.ok(Math.abs(a.prices[lastIdx] / o.prices[lastIdx] - 2) < 1e-4, a.id);
    assert.ok(Math.abs(a.prices.at(-1) / a.prices[lastIdx] - 1.1) < 1e-4, a.id);
  }
  assert.equal(out.cpiUS.length, out.months.length);
  for (const v of Object.values(out.fx)) assert.equal(v.length, out.months.length);
});
