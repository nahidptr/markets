import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rng, xirr, schedule, runInvestor, firstBuyIdx, localPrices, cpiIndex, parseCustomPrices, quantile, monthsSince,
} from '../src/sim.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('rng is deterministic per seed', () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  xs.forEach((x) => assert.ok(x >= 0 && x < 1));
});

test('xirr: single cash flow equals compound growth', () => {
  close(xirr([0], [100], 1, 110), 0.1);
  close(xirr([0], [100], 2, 121), 0.1);
  close(xirr([0], [100], 1, 50), -0.5);
});

test('xirr: two flows at 10% a year', () => {
  // 100 at t=0 and 100 at t=1, both growing at 10% until t=2
  const fv = 100 * 1.1 ** 2 + 100 * 1.1;
  close(xirr([0, 1], [100, 100], 2, fv), 0.1);
});

test('xirr: handles huge returns (Bitcoin-like)', () => {
  const r = xirr([0], [1], 10, 1e6);
  close(r, Math.pow(1e6, 0.1) - 1, 1e-6);
});

test('firstBuyIdx needs a previous month-end', () => {
  assert.equal(firstBuyIdx([1, 2, 3]), 1);
  assert.equal(firstBuyIdx([null, null, 5, 6]), 3);
  assert.equal(firstBuyIdx([null, null]), Infinity);
});

test('localPrices converts with FX and keeps nulls', () => {
  assert.deepEqual(localPrices([null, 2, 4], [10, 10, 0.5]), [null, 20, 2]);
  assert.deepEqual(localPrices([1, 2], null), [1, 2]);
});

test('cpiIndex compounds a yearly rate for non-USD', () => {
  const c = cpiIndex(new Array(13).fill(0).map((_, i) => i), 'EUR', null, 10);
  close(c[12] / c[0], 1.1);
});

test('schedule: monthly and lump sum', () => {
  const m = schedule(1, { s: 3, e: 8, mode: 'monthly', amt: 50 });
  assert.equal(m.length, 6);
  assert.ok(m.every((b) => b.amt === 50 && b.u === 0.5));
  const l = schedule(1, { s: 3, e: 8, mode: 'lump', amt: 999 });
  assert.equal(l.length, 1); assert.equal(l[0].i, 3); assert.equal(l[0].u, 0);
});

test('schedule: random respects bounds and is reproducible', () => {
  const opts = { s: 1, e: 120, mode: 'random', p: 0.5, lo: 100, hi: 2000 };
  const a = schedule(42, opts), b = schedule(42, opts);
  assert.deepEqual(a, b);
  assert.ok(a.length > 30 && a.length < 90);
  assert.ok(a.every((x) => x.amt >= 100 && x.amt <= 2000 && x.u >= 0 && x.u < 1));
});

test('runInvestor: flat price returns 0%, doubling returns 100% for a lump sum', () => {
  const flat = { id: 'f', local: new Array(13).fill(10) };
  const dbl = { id: 'd', local: [10, ...new Array(11).fill(15), 20] };
  const cpi = new Array(13).fill(100);
  const buys = schedule(1, { s: 1, e: 12, mode: 'lump', amt: 1000 });
  const R = runInvestor(buys, [flat, dbl], { e: 12, cpi, detail: true });
  close(R.a.f.fv, 1000); close(R.a.f.irr, 0);
  close(R.a.d.fv, 2000); close(R.a.d.irr, 1, 1e-6);
  close(R.inflNeeded, 1000); close(R.a.d.real, 1, 1e-6);
  assert.equal(R.a.d.path.length, 13);
  close(R.a.d.path.at(-1), 2000);
});

test('runInvestor: inflation benchmark grows with CPI', () => {
  const asset = { id: 'a', local: new Array(13).fill(1) };
  const cpi = Array.from({ length: 13 }, (_, i) => 100 * 1.1 ** (i / 12));
  const R = runInvestor(schedule(1, { s: 1, e: 12, mode: 'lump', amt: 100 }), [asset], { e: 12, cpi, detail: true });
  close(R.inflNeeded, 110, 1e-6);
  close(R.a.a.real, 1 / 1.1 - 1, 1e-6);
});

test('parseCustomPrices reads common formats and forward-fills gaps', () => {
  const months = ['2020-01', '2020-02', '2020-03', '2020-04'];
  const { prices, count } = parseCustomPrices('2020-02-28,10\n2020/04 ; $1,200.5\njunk', months);
  assert.equal(count, 2);
  assert.deepEqual(prices, [null, 10, 10, 1200.5]);
});

test('quantile and monthsSince', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(monthsSince('2026-09', new Date(2026, 11, 15)), 3);
});

test('bundled data file is consistent', () => {
  const d = JSON.parse(readFileSync(new URL('../public/data/prices.json', import.meta.url)));
  const n = d.months.length;
  assert.ok(n > 100);
  assert.equal(d.cpiUS.length, n);
  for (const [c, v] of Object.entries(d.fx)) assert.equal(v.length, n, `fx ${c}`);
  const ids = new Set();
  for (const a of d.assets) {
    assert.ok(!ids.has(a.id), `duplicate ${a.id}`); ids.add(a.id);
    assert.equal(a.prices.length, n, a.id);
    const first = a.prices.findIndex((p) => p != null);
    assert.ok(first >= 0, a.id);
    for (let i = first + 1; i < n; i++) {
      assert.ok(a.prices[i] > 0, `${a.id} ${d.months[i]}`);
      const ch = a.prices[i] / a.prices[i - 1];
      const [lo, hi] = a.group === 'crypto' ? [0.2, 6] : [0.3, 3.5];
      assert.ok(ch > lo && ch < hi, `${a.id} jump at ${d.months[i]}: ${ch}`);
    }
  }
  assert.ok(!ids.has('nifty'), 'Nifty 50 was removed');
});
