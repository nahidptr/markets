// Pure simulation logic. No DOM access, so it can be unit-tested with `node --test`.

/** Seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Money-weighted annual return.
 * Buys of `amts[i]` at times `ts[i]` (years), portfolio worth `fv` at `tEnd`.
 * Solves  fv - Σ a_i (1+r)^(tEnd - t_i) = 0.
 */
export function xirr(ts, amts, tEnd, fv, guess) {
  const n = ts.length;
  if (!n) return NaN;
  if (!(fv > 0)) return -1;
  let inv = 0, wt = 0;
  for (let i = 0; i < n; i++) { inv += amts[i]; wt += amts[i] * (tEnd - ts[i]); }
  const dur = Math.max(wt / inv, 1 / 365);
  let r = guess ?? Math.pow(fv / inv, 1 / dur) - 1;
  if (!Number.isFinite(r)) r = 0.1;
  r = Math.max(r, -0.95);
  for (let k = 0; k < 40; k++) {
    const l = Math.log1p(r);
    let f = fv, df = 0;
    for (let i = 0; i < n; i++) {
      const d = tEnd - ts[i];
      const g = amts[i] * Math.exp(l * d);
      f -= g;
      df -= (g * d) / (1 + r);
    }
    let nr = r - f / df;
    if (!Number.isFinite(nr)) break;
    if (nr <= -0.999) nr = (r - 0.999) / 2;
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  // Fallback: bisection on log(1 + r).
  const F = (rr) => {
    const l = Math.log1p(rr);
    let f = fv;
    for (let i = 0; i < n; i++) f -= amts[i] * Math.exp(l * (tEnd - ts[i]));
    return f;
  };
  let lo = Math.log1p(-0.999), hi = Math.log1p(1000);
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (F(Math.expm1(mid)) > 0) lo = mid; else hi = mid;
  }
  return Math.expm1((lo + hi) / 2);
}

/** Earliest month index an asset can be bought in (needs the previous month-end price). */
export function firstBuyIdx(prices) {
  const f = prices.findIndex((p) => p != null);
  return f < 0 ? Infinity : Math.max(1, f + 1);
}

/** Price series converted into the chosen currency. `fx` is units per USD, or null for USD. */
export function localPrices(prices, fx) {
  return fx ? prices.map((p, i) => (p == null ? null : p * fx[i])) : prices.slice();
}

/** CPI-like index for a currency. USD uses the real CPI; others compound a yearly rate. */
export function cpiIndex(months, cur, cpiUS, ratePct) {
  if (cur === 'USD') return cpiUS;
  const g = Math.log1p(ratePct / 100) / 12;
  return months.map((_, i) => Math.exp(g * i));
}

/**
 * Generate the purchase schedule.
 * mode: 'random' | 'monthly' | 'lump'
 * Purchase in month i happens at fraction u of the way from month-end i-1 to month-end i.
 */
export function schedule(seed, { s, e, mode, p = 0.6, lo = 100, hi = 2000, amt = 500 }) {
  const r = rng(seed);
  const buys = [];
  for (let i = s; i <= e; i++) {
    let a, u;
    if (mode === 'random') {
      const roll = r(), x = r(), y = r(); // always draw 3 so schedules stay aligned
      if (roll >= p) continue;
      a = Math.exp(Math.log(lo) + x * (Math.log(hi) - Math.log(lo)));
      u = y;
    } else if (mode === 'monthly') { a = amt; u = 0.5; }
    else { if (i !== s) break; a = amt; u = 0; }
    buys.push({ i, u, t: (i - 1 + u) / 12, amt: a, day: Math.max(1, Math.min(28, Math.round(u * 27) + 1)) });
  }
  return buys;
}

const interp = (p0, p1, u) => Math.pow(p0, 1 - u) * Math.pow(p1, u);

/**
 * Run one investor.
 * assets: [{ id, local: number[] }]  (prices already in the chosen currency)
 * cpi: index per month (same currency)
 * detail: also return month-end paths and per-buy prices
 */
export function runInvestor(buys, assets, { e, cpi, detail = false }) {
  const tEnd = e / 12;
  const ts = buys.map((b) => b.t);
  const amts = buys.map((b) => b.amt);
  const invested = amts.reduce((x, y) => x + y, 0);
  const cpiE = cpi[e];
  const realAmts = buys.map((b) => (b.amt * cpiE) / interp(cpi[b.i - 1], cpi[b.i], b.u));
  const inflNeeded = realAmts.reduce((x, y) => x + y, 0);
  const out = { buys, invested, inflNeeded, realAmts, tEnd, a: {} };

  for (const a of assets) {
    let units = 0;
    const px = detail ? new Array(buys.length) : null;
    for (let k = 0; k < buys.length; k++) {
      const b = buys[k];
      const price = interp(a.local[b.i - 1], a.local[b.i], b.u);
      units += b.amt / price;
      if (px) px[k] = price;
    }
    const fv = units * a.local[e];
    const irr = xirr(ts, amts, tEnd, fv);
    out.a[a.id] = { units, fv, irr };
    if (detail) {
      out.a[a.id].px = px;
      out.a[a.id].real = xirr(ts, realAmts, tEnd, fv, irr);
    }
  }

  if (detail && buys.length) {
    const s = buys[0].i;
    const idx = [];
    for (let j = s - 1; j <= e; j++) idx.push(j);
    out.idx = idx;
    out.cash = []; out.infl = [];
    let k = 0, cash = 0, realBase = 0;
    for (const j of idx) {
      while (k < buys.length && buys[k].i <= j) { cash += buys[k].amt; realBase += realAmts[k] / cpiE; k++; }
      out.cash.push(cash);
      out.infl.push(realBase * cpi[j]);
    }
    for (const a of assets) {
      const path = [];
      let u = 0, kk = 0;
      for (const j of idx) {
        while (kk < buys.length && buys[kk].i <= j) { u += buys[kk].amt / out.a[a.id].px[kk]; kk++; }
        path.push(u * a.local[j]);
      }
      out.a[a.id].path = path;
    }
  }
  return out;
}

/** Quantile of a sorted array. */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** Parse pasted "YYYY-MM,price" lines into a series aligned with `months`. */
export function parseCustomPrices(text, months) {
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?\s*[,;\t ]\s*\$?([\d.,]+)/);
    if (!m) continue;
    const key = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
    const v = parseFloat(m[3].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) map[key] = v;
  }
  const prices = months.map((k) => map[k] ?? null);
  let last = null;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i] != null) last = prices[i];
    else if (last != null) prices[i] = last;
  }
  return { prices, count: Object.keys(map).length };
}

/** Months between a "YYYY-MM" label and a Date (whole months, ignoring days). */
export function monthsSince(label, now = new Date()) {
  const [y, m] = label.split('-').map(Number);
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}
