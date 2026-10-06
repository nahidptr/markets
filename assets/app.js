// Gold vs Markets — client-side backtest. No dependencies.
// Data: data/prices.json (month-end USD prices, FX per USD, US CPI).

const $ = (id) => document.getElementById(id);
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Approximate average CPI inflation 2010–2025, % a year. Editable in the UI.
const INFL_DEFAULT = {
  USD: 2.7, EUR: 2.2, GBP: 2.9, CHF: 0.4, SEK: 1.9, INR: 6.2, AUD: 2.7, TWD: 1.3, JPY: 0.9, CAD: 2.5,
  SGD: 2.2, NOK: 2.7, DKK: 1.8, CNY: 2.0, HKD: 2.4, KRW: 2.2, NZD: 2.6, ZAR: 5.3, MXN: 4.4, BRL: 6.0, THB: 1.4, MYR: 2.0,
};
const CUR_NAMES = {
  USD: 'US dollar', EUR: 'Euro', GBP: 'British pound', CHF: 'Swiss franc', SEK: 'Swedish krona', INR: 'Indian rupee',
  AUD: 'Australian dollar', TWD: 'Taiwan dollar', JPY: 'Japanese yen', CAD: 'Canadian dollar', SGD: 'Singapore dollar',
  NOK: 'Norwegian krone', DKK: 'Danish krone', CNY: 'Chinese yuan', HKD: 'Hong Kong dollar', KRW: 'South Korean won',
  NZD: 'New Zealand dollar', ZAR: 'South African rand', MXN: 'Mexican peso', BRL: 'Brazilian real', THB: 'Thai baht', MYR: 'Malaysian ringgit',
};
const DEFAULT_START = '2010-08';
const MC_RUNS = 1000;
const CUSTOM_KEY = 'gvm.custom.v1';

let DATA, M, N;              // raw data, month labels, count
let ASSETS = [];             // [{id,name,ticker,prices,first,custom?}]
let state = {};
let lastRun = null;
let mcToken = 0;

/* ---------------- utilities ---------------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lab = (i) => { const [y, m] = M[i].split('-'); return `${MN[+m - 1]} ${y}`; };
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');
const signPct = (x) => (x >= 0 ? '+' : '') + pct(x);
let moneyFmt, moneyFmtCompact;
function setMoneyFormat(cur) {
  moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 });
  moneyFmtCompact = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 });
}
const money = (x) => (Math.abs(x) >= 1e9 ? moneyFmtCompact.format(x) : moneyFmt.format(x));
const priceFmt = (x) => (x >= 1000 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- XIRR ---------------- */
// cashflows: buys at times ts (years) with amounts amts (>0 invested); final value fv at tEnd.
// Solves sum(-a_i (1+r)^(tEnd - t_i)) + fv = 0.
function xirr(ts, amts, tEnd, fv, guess) {
  const n = ts.length;
  if (!n) return NaN;
  let inv = 0, wt = 0;
  for (let i = 0; i < n; i++) { inv += amts[i]; wt += amts[i] * (tEnd - ts[i]); }
  if (fv <= 0) return -1;
  const dur = Math.max(wt / inv, 1 / 365);
  let r = guess ?? Math.pow(fv / inv, 1 / dur) - 1;
  if (!Number.isFinite(r)) r = 0.1;
  r = Math.max(r, -0.95);
  for (let k = 0; k < 30; k++) {
    const l = Math.log1p(r);
    let f = fv, df = 0;
    for (let i = 0; i < n; i++) {
      const d = tEnd - ts[i];
      const g = amts[i] * Math.exp(l * d);
      f -= g; df -= g * d / (1 + r);
    }
    const step = f / df;
    let nr = r - step;
    if (!Number.isFinite(nr)) break;
    if (nr <= -0.999) nr = (r - 0.999) / 2;
    if (Math.abs(nr - r) < 1e-9) return nr;
    r = nr;
  }
  // fallback: bisection on log(1+r)
  let lo = -0.999, hi = 1000;
  const F = (rr) => { const l = Math.log1p(rr); let f = fv; for (let i = 0; i < n; i++) f -= amts[i] * Math.exp(l * (tEnd - ts[i])); return f; };
  for (let k = 0; k < 200; k++) { const mid = Math.expm1((Math.log1p(lo) + Math.log1p(hi)) / 2); if (F(mid) > 0) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/* ---------------- data helpers ---------------- */
function fxSeries(cur) { return cur === 'USD' ? null : DATA.fx[cur]; }
function priceIn(a, i, fx) { const p = a.prices[i]; return p == null ? null : (fx ? p * fx[i] : p); }
function cpiSeries(cur, rate) {
  if (cur === 'USD') return DATA.cpiUS;
  const g = Math.log1p(rate / 100) / 12;
  return M.map((_, i) => Math.exp(g * i));
}
// Earliest month index at which asset `a` can be bought (needs previous month-end price).
function firstBuyIdx(a) { const f = a.prices.findIndex((p) => p != null); return Math.max(1, f + 1); }

/* ---------------- simulation ---------------- */
function simulate(seed, cfg, keepDetail) {
  const { s, e, mode, p, lo, hi, amt, assets, fx, cpi } = cfg;
  const r = rng(seed);
  const buys = [];
  for (let i = s; i <= e; i++) {
    let a, u;
    if (mode === 'random') {
      if (r() >= p) { r(); r(); continue; }
      a = Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo)));
      u = r();
    } else if (mode === 'monthly') { a = amt; u = 0.5; }
    else { if (i !== s) break; a = amt; u = 0; }
    buys.push({ i, u, t: (i - 1 + u) / 12, amt: a, day: Math.max(1, Math.min(28, Math.round(u * 27) + 1)) });
  }
  const tEnd = e / 12;
  const ts = buys.map((b) => b.t), amts = buys.map((b) => b.amt);
  const invested = amts.reduce((x, y) => x + y, 0);
  // inflation: restate each buy in end-month money
  const cpiE = cpi[e];
  const realAmts = buys.map((b) => b.amt * cpiE / (Math.pow(cpi[b.i - 1], 1 - b.u) * Math.pow(cpi[b.i], b.u)));
  const inflNeeded = realAmts.reduce((x, y) => x + y, 0);
  const res = { buys, invested, inflNeeded, realAmts, tEnd, a: {} };
  for (const a of assets) {
    let units = 0;
    const px = keepDetail ? [] : null;
    for (const b of buys) {
      const p0 = priceIn(a, b.i - 1, fx), p1 = priceIn(a, b.i, fx);
      const price = Math.pow(p0, 1 - b.u) * Math.pow(p1, b.u);
      units += b.amt / price;
      if (px) px.push(price);
    }
    const fv = units * priceIn(a, e, fx);
    const irr = xirr(ts, amts, tEnd, fv);
    const out = { units, fv, irr };
    if (keepDetail) {
      out.px = px;
      out.real = xirr(ts, realAmts, tEnd, fv, irr);
    }
    res.a[a.id] = out;
  }
  if (keepDetail) {
    // month-end paths from s-1 .. e
    const idx = [];
    for (let j = s - 1; j <= e; j++) idx.push(j);
    res.idx = idx;
    res.cash = []; res.infl = [];
    let k = 0, cash = 0, realBase = 0;
    for (const j of idx) {
      while (k < buys.length && buys[k].i <= j) { cash += buys[k].amt; realBase += realAmts[k] / cpiE; k++; }
      res.cash.push(cash); res.infl.push(realBase * cpi[j]);
    }
    for (const a of assets) {
      const path = []; let u2 = 0, kk = 0;
      for (const j of idx) {
        while (kk < buys.length && buys[kk].i <= j) { u2 += buys[kk].amt / res.a[a.id].px[kk]; kk++; }
        path.push(u2 * priceIn(a, j, fx));
      }
      res.a[a.id].path = path;
    }
  }
  return res;
}

/* ---------------- state & URL ---------------- */
function readState() {
  const q = new URLSearchParams(location.search);
  const ids = ASSETS.map((a) => a.id);
  const st = {
    cur: q.get('cur') && (q.get('cur') === 'USD' || DATA.fx[q.get('cur')]) ? q.get('cur') : 'USD',
    start: M.includes(q.get('from')) ? q.get('from') : DEFAULT_START,
    end: M.includes(q.get('to')) ? q.get('to') : M[N - 1],
    mode: ['random', 'monthly', 'lump'].includes(q.get('mode')) ? q.get('mode') : 'random',
    p: clampNum(q.get('p'), 10, 100, 60),
    lo: clampNum(q.get('min'), 1, 1e9, 100),
    hi: clampNum(q.get('max'), 1, 1e9, 2000),
    amt: clampNum(q.get('amt'), 1, 1e12, 500),
    seed: clampNum(q.get('seed'), 1, 1e9, 42) | 0,
    log: q.get('log') !== '0',
    infl: q.get('infl') != null ? clampNum(q.get('infl'), -20, 200, 2.5) : null,
  };
  const qa = q.get('assets');
  st.assets = new Set(qa ? qa.split(',').filter((x) => ids.includes(x)) : ids);
  if (!st.assets.size) ids.forEach((x) => st.assets.add(x));
  if (st.infl == null) st.infl = INFL_DEFAULT[st.cur] ?? 2.5;
  if (M.indexOf(st.start) < 1) st.start = M[1];
  if (M.indexOf(st.end) < M.indexOf(st.start)) st.end = M[N - 1];
  return st;
}
function clampNum(v, lo, hi, d) { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function writeState() {
  const q = new URLSearchParams();
  q.set('cur', state.cur); q.set('from', state.start); q.set('to', state.end); q.set('mode', state.mode);
  if (state.mode === 'random') { q.set('p', state.p); q.set('min', state.lo); q.set('max', state.hi); q.set('seed', state.seed); }
  else q.set('amt', state.amt);
  if (state.cur !== 'USD') q.set('infl', state.infl);
  const builtIn = [...state.assets].filter((id) => !id.startsWith('c_'));
  if (builtIn.length !== DATA.assets.length || ASSETS.some((a) => a.custom && !state.assets.has(a.id))) q.set('assets', [...state.assets].join(','));
  if (!state.log) q.set('log', '0');
  history.replaceState(null, '', '?' + q.toString());
}

/* ---------------- custom assets ---------------- */
function loadCustom() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list) { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* storage blocked */ } }
function parseCustom(text) {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?\s*[,;\t ]\s*\$?([\d.,]+)/);
    if (!m) continue;
    const key = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
    const v = parseFloat(m[3].replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) map[key] = v;
  }
  const prices = M.map((k) => map[k] ?? null);
  // forward-fill internal gaps after the first price
  let last = null;
  for (let i = 0; i < prices.length; i++) { if (prices[i] != null) last = prices[i]; else if (last != null) prices[i] = last; }
  return { prices, count: Object.keys(map).length };
}
function buildAssets() {
  ASSETS = DATA.assets.map((a) => ({ ...a }));
  for (const c of loadCustom()) ASSETS.push({ id: c.id, name: c.name, ticker: 'yours', prices: c.prices, custom: true, note: 'Your own price data' });
  for (const a of ASSETS) a.firstBuy = firstBuyIdx(a);
}
const colorOf = (a) => (a.custom ? 'var(--a-custom)' : `var(--a-${a.id})`);

/* ---------------- UI setup ---------------- */
function initControls() {
  const cur = $('cur');
  cur.innerHTML = ['USD', ...Object.keys(DATA.fx)].map((c) => `<option value="${c}">${c} · ${CUR_NAMES[c] || c}</option>`).join('');
  const opts = M.map((m, i) => (i === 0 ? '' : `<option value="${m}">${lab(i)}</option>`)).join('');
  $('startM').innerHTML = opts; $('endM').innerHTML = opts;
  renderChips();

  cur.addEventListener('change', () => { state.cur = cur.value; state.infl = INFL_DEFAULT[state.cur] ?? 2.5; syncControls(); run(); });
  $('startM').addEventListener('change', (e) => { state.start = e.target.value; if (M.indexOf(state.end) < M.indexOf(state.start)) state.end = state.start; syncControls(); run(); });
  $('endM').addEventListener('change', (e) => { state.end = e.target.value; if (M.indexOf(state.end) < M.indexOf(state.start)) state.start = state.end; syncControls(); run(); });
  document.querySelectorAll('input[name=mode]').forEach((el) => el.addEventListener('change', () => { state.mode = el.value; syncControls(); run(); }));
  $('freq').addEventListener('input', (e) => { $('freqV').textContent = e.target.value + '%'; });
  $('freq').addEventListener('change', (e) => { state.p = +e.target.value; run(); });
  const numBind = (id, key) => $(id).addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v) && v > 0) { state[key] = v; run(); } else syncControls(); });
  numBind('minA', 'lo'); numBind('maxA', 'hi'); numBind('amt', 'amt');
  $('infl').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { state.infl = v; run(); } });
  $('runBtn').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 999999) + 1; run(); });
  $('allBtn').addEventListener('click', () => { ASSETS.forEach((a) => state.assets.add(a.id)); renderChips(); run(); });
  $('noneBtn').addEventListener('click', () => { state.assets.clear(); renderChips(); run(); });
  $('logS').addEventListener('change', (e) => { state.log = e.target.checked; writeState(); if (lastRun) drawChart(lastRun); });
  $('shareBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied'); }
    catch { prompt('Copy this link', location.href); }
  });
  $('cAdd').addEventListener('click', addCustom);
  if (matchMedia('(max-width: 900px)').matches) $('settingsBox').open = false;
}
function renderChips() {
  $('assetChips').innerHTML = ASSETS.map((a) => `<button type="button" class="chip" data-id="${a.id}" aria-pressed="${state.assets.has(a.id)}" title="${esc(a.note || '')}"><span class="dot" style="background:${colorOf(a)}"></span>${esc(a.name)}${a.custom ? `<span class="x" data-del="${a.id}" aria-label="Remove ${esc(a.name)}">×</span>` : ''}</button>`).join('');
  $('assetChips').querySelectorAll('.chip').forEach((el) => el.addEventListener('click', (ev) => {
    const id = el.dataset.id;
    if (ev.target.dataset.del) { removeCustom(id); return; }
    if (state.assets.has(id)) state.assets.delete(id); else state.assets.add(id);
    el.setAttribute('aria-pressed', state.assets.has(id));
    run();
  }));
}
function addCustom() {
  const name = $('cName').value.trim() || 'My stock';
  const { prices, count } = parseCustom($('cData').value);
  if (count < 3) { $('cMsg').textContent = 'Could not read at least 3 monthly prices. Use lines like 2015-06,42.10'; return; }
  const list = loadCustom();
  const id = 'c_' + Date.now().toString(36);
  list.push({ id, name: name.slice(0, 24), prices });
  saveCustom(list);
  buildAssets(); state.assets.add(id); renderChips();
  $('cMsg').textContent = `Added ${name} with ${count} monthly prices.`;
  $('cData').value = ''; $('cName').value = '';
  run();
}
function removeCustom(id) {
  saveCustom(loadCustom().filter((c) => c.id !== id));
  state.assets.delete(id); buildAssets(); renderChips(); run();
}
function syncControls() {
  $('cur').value = state.cur; $('startM').value = state.start; $('endM').value = state.end;
  document.querySelectorAll('input[name=mode]').forEach((el) => { el.checked = el.value === state.mode; });
  $('freq').value = state.p; $('freqV').textContent = state.p + '%';
  $('minA').value = state.lo; $('maxA').value = state.hi; $('amt').value = state.amt;
  $('amtLabel').textContent = state.mode === 'lump' ? 'Amount invested once' : 'Amount each month';
  $('infl').value = state.infl; $('inflField').hidden = state.cur === 'USD';
  $('logS').checked = state.log;
  document.querySelectorAll('.mode-random').forEach((el) => { el.hidden = state.mode !== 'random'; });
  document.querySelectorAll('.mode-monthly.mode-lump').forEach((el) => { el.hidden = state.mode === 'random'; });
  const modeTxt = { random: 'random buys', monthly: 'monthly', lump: 'lump sum' }[state.mode];
  $('settingsHint').textContent = `${state.cur} · ${state.start.slice(0, 4)}–${state.end.slice(0, 4)} · ${modeTxt} · ${state.assets.size} assets`;
}

/* ---------------- main run ---------------- */
function config() {
  const sel = ASSETS.filter((a) => state.assets.has(a.id));
  let s = M.indexOf(state.start);
  const e = M.indexOf(state.end);
  const need = sel.length ? Math.max(...sel.map((a) => a.firstBuy)) : 1;
  const late = sel.filter((a) => a.firstBuy > s);
  if (need > s) s = Math.min(need, e);
  let lo = state.lo, hi = state.hi; if (hi < lo) [lo, hi] = [hi, lo];
  return {
    s, e, late, mode: state.mode, p: state.p / 100, lo, hi, amt: state.amt, assets: sel,
    fx: fxSeries(state.cur), cpi: cpiSeries(state.cur, state.infl),
  };
}
function run() {
  setMoneyFormat(state.cur);
  syncControls(); writeState();
  const cfg = config();
  const warn = $('startWarn');
  if (cfg.late.length && cfg.assets.length) {
    warn.hidden = false;
    warn.textContent = `${cfg.late.map((a) => a.name).join(', ')} ${cfg.late.length > 1 ? 'have' : 'has'} no prices before ${lab(cfg.s - 1)}, so every asset starts in ${lab(cfg.s)}. Deselect ${cfg.late.length > 1 ? 'them' : 'it'} to start earlier.`;
  } else warn.hidden = true;
  if (!cfg.assets.length) {
    $('board').innerHTML = '<li class="sub">Pick at least one asset in Settings.</li>';
    $('chart').innerHTML = ''; $('legend').innerHTML = ''; $('dist').innerHTML = ''; $('axis').innerHTML = ''; $('ledger').innerHTML = '';
    $('runSum').textContent = '';
    return;
  }
  const R = simulate(state.seed, cfg, true);
  R.cfg = cfg; lastRun = R;
  renderSummary(R); renderBoard(R); drawChart(R); renderLedger(R);
  if (state.mode === 'random') runMC(cfg); else { mcToken++; }
}

function renderSummary(R) {
  const n = R.buys.length, cfg = R.cfg;
  const months = cfg.e - cfg.s + 1;
  let txt;
  if (!n) txt = 'No purchases in this window. Raise the buying chance or widen the dates.';
  else if (cfg.mode === 'random') txt = `Investor #${state.seed} bought in ${n} of ${months} months, ${money(R.invested)} in total, ${lab(R.buys[0].i)} to ${lab(R.buys[n - 1].i)}. Valued at the end of ${lab(cfg.e)}.`;
  else if (cfg.mode === 'monthly') txt = `${money(cfg.amt)} every month for ${n} months, ${money(R.invested)} in total. Valued at the end of ${lab(cfg.e)}.`;
  else txt = `${money(cfg.amt)} invested at the start of ${lab(cfg.s)}, valued at the end of ${lab(cfg.e)}.`;
  $('runSum').textContent = txt;
  $('seedL').textContent = `Investor #${state.seed}`;
}

function renderBoard(R) {
  const assets = [...R.cfg.assets].sort((x, y) => R.a[y.id].fv - R.a[x.id].fv);
  const maxM = Math.max(...assets.map((a) => R.a[a.id].fv / R.invested), R.inflNeeded / R.invested, 1);
  const lm = (v) => Math.log(Math.max(v, 0.01));
  const lo = Math.min(0, ...assets.map((a) => lm(R.a[a.id].fv / R.invested)));
  const w = (mult) => Math.max(1.5, ((lm(mult) - lo) / (lm(maxM) - lo || 1)) * 100);
  const head = `<li class="row head"><span></span><span>Asset</span><span>Multiple of money in</span><span class="num">Value now</span><span class="num">Profit</span><span class="num">Per year</span><span class="num">After inflation</span></li>`;
  const row = (rank, name, small, color, fv, irr, real, cls = '') => {
    const mult = fv / R.invested, gain = fv - R.invested;
    return `<li class="row ${cls}"><span class="rk">${rank}</span>
      <span class="nm"><span class="dot" style="background:${color}"></span><span class="t">${esc(name)} <small>${esc(small)}</small></span></span>
      <span class="bar" title="${mult.toFixed(2)}× your money"><i style="width:${w(mult)}%;background:${color}"></i></span>
      <span class="num big c-val">${money(fv)}</span>
      <span class="metrics">
        <span class="num ${gain >= 0 ? 'pos' : 'neg'}"><span class="lbl">Profit</span>${gain >= 0 ? '+' : ''}${money(gain)}</span>
        <span class="num"><span class="lbl">Per year</span>${pct(irr)}</span>
        <span class="num ${real >= 0 ? 'pos' : 'neg'}"><span class="lbl">After inflation</span>${Number.isFinite(real) ? signPct(real) : '–'}</span>
      </span></li>`;
  };
  let html = head + assets.map((a, ix) => row(ix + 1, a.name, a.ticker, colorOf(a), R.a[a.id].fv, R.a[a.id].irr, R.a[a.id].real)).join('');
  if (R.invested > 0) {
    const ts = R.buys.map((b) => b.t), amts = R.buys.map((b) => b.amt);
    const inflIrr = xirr(ts, amts, R.tEnd, R.inflNeeded);
    html += row('', 'Keeping up with inflation', 'benchmark', 'var(--infl)', R.inflNeeded, inflIrr, 0, 'base');
    html += row('', 'Cash under the mattress', '0%', 'var(--cash)', R.invested, 0, xirr(ts, R.realAmts, R.tEnd, R.invested), 'base');
  }
  $('board').innerHTML = html;
}

/* ---------------- chart ---------------- */
const hiddenSeries = new Set();
function drawChart(R) {
  const cw0 = Math.max(280, $('chart').clientWidth || 800);
  const wide = cw0 > 640;
  const W = 1000, sc = W / cw0;
  const H = Math.round(wide ? Math.min(460, W * 0.46) : W * 0.8);
  const fs = 11.5 * sc, L = 56 * sc, Rm = 8 * sc, Tp = 8 * sc, B = 26 * sc;
  const idx = R.idx, T = idx.length - 1;
  const series = R.cfg.assets.map((a) => ({ id: a.id, name: a.name, color: colorOf(a), v: R.a[a.id].path }));
  const extra = [{ id: '_cash', name: 'Cash put in', color: 'var(--cash)', v: R.cash, dash: '6 5' }, { id: '_infl', name: 'Cash + inflation', color: 'var(--infl)', v: R.infl, dash: '2 4' }];
  const visible = [...series, ...extra].filter((s) => !hiddenSeries.has(s.id));
  const maxV = Math.max(1, ...visible.flatMap((s) => s.v));
  const LOG = state.log;
  const x = (k) => L + (W - L - Rm) * (T ? k / T : 0.5);
  let y, ticks = [];
  if (LOG) {
    const pos = visible.flatMap((s) => s.v).filter((v) => v > 0);
    const minPos = pos.length ? Math.min(...pos) : 1;
    const lo = Math.pow(10, Math.floor(Math.log10(Math.max(minPos, maxV / 1e7))));
    const top = Math.pow(10, Math.ceil(Math.log10(maxV)));
    const span = Math.log10(top) - Math.log10(lo) || 1;
    y = (v) => Tp + (H - Tp - B) * (1 - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / span);
    const stepE = span > 6 ? 2 : 1;
    for (let e = Math.log10(lo); e <= Math.log10(top) + 1e-9; e += stepE) ticks.push(Math.pow(10, e));
  } else {
    const step = niceStep(maxV / 5), top = Math.ceil(maxV / step) * step;
    y = (v) => Tp + (H - Tp - B) * (1 - v / top);
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  }
  let g = '';
  const mono = `font-family="IBM Plex Mono, ui-monospace, monospace" font-size="${fs}" fill="var(--muted)"`;
  for (const v of ticks) {
    g += `<line x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="${sc}"/>`;
    g += `<text x="${L - 8}" y="${(y(v) + fs / 3).toFixed(1)}" text-anchor="end" ${mono}>${moneyFmtCompact.format(v)}</text>`;
  }
  const years = idx.length / 12;
  const every = years > 12 ? (wide ? 2 : 4) : years > 6 ? (wide ? 1 : 2) : 1;
  idx.forEach((j, k) => {
    if (M[j].endsWith('-12') && k > 0 && k < T) {
      const yr = +M[j].slice(0, 4) + 1;
      if (yr % every === 0) g += `<text x="${x(k).toFixed(1)}" y="${(H - 8 * sc).toFixed(1)}" text-anchor="middle" ${mono}>${yr}</text><line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${H - B}" y2="${H - B + 5}" stroke="var(--muted)" stroke-width="${sc}"/>`;
    }
  });
  const pathOf = (v) => v.map((val, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(val).toFixed(1)).join(' ');
  const sw = 2 * sc;
  for (const s of extra) if (!hiddenSeries.has(s.id)) g += `<path d="${pathOf(s.v)}" fill="none" stroke="${s.color}" stroke-width="${sw * 0.8}" stroke-dasharray="${s.dash}"/>`;
  for (const s of series) if (!hiddenSeries.has(s.id)) {
    g += `<path d="${pathOf(s.v)}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    g += `<circle cx="${x(T)}" cy="${y(s.v[T]).toFixed(1)}" r="${(3.5 * sc).toFixed(1)}" fill="${s.color}"/>`;
  }
  g += `<line id="hov" x1="0" x2="0" y1="${Tp}" y2="${H - B}" stroke="var(--muted)" stroke-width="${sc}" visibility="hidden"/>`;
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio value over time">${g}<rect x="${L}" y="${Tp}" width="${W - L - Rm}" height="${H - Tp - B}" fill="transparent"/></svg><div class="tip" id="tip" hidden></div>`;

  $('legend').innerHTML = [...series, ...extra].map((s) => `<button type="button" class="lg" data-id="${s.id}" aria-pressed="${!hiddenSeries.has(s.id)}"><i class="sw" style="background:${s.dash ? `repeating-linear-gradient(90deg,${s.color} 0 4px,transparent 4px 7px)` : s.color}"></i>${esc(s.name)}</button>`).join('');
  $('legend').querySelectorAll('.lg').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.id; if (hiddenSeries.has(id)) hiddenSeries.delete(id); else hiddenSeries.add(id); drawChart(R);
  }));

  const svg = $('chart').querySelector('svg'), tip = $('tip'), hov = $('hov');
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * W / rect.width;
    const k = Math.max(0, Math.min(T, Math.round((px - L) / (W - L - Rm) * T)));
    hov.setAttribute('x1', x(k)); hov.setAttribute('x2', x(k)); hov.setAttribute('visibility', 'visible');
    const rows = visible.slice().sort((p, q) => q.v[k] - p.v[k]);
    tip.innerHTML = `<b>${lab(idx[k])}</b><br>` + rows.map((s) => `<span style="color:${s.color}">●</span> ${esc(s.name)}: ${money(s.v[k])}`).join('<br>');
    tip.hidden = false;
    const cw = $('chart').clientWidth, left = x(k) * rect.width / W;
    const tw = tip.offsetWidth;
    tip.style.left = (left + 14 + tw > cw ? Math.max(0, left - 14 - tw) : left + 14) + 'px';
    tip.style.top = '6px';
  };
  const hide = () => { tip.hidden = true; hov.setAttribute('visibility', 'hidden'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

/* ---------------- Monte Carlo ---------------- */
function runMC(cfg) {
  const token = ++mcToken;
  const res = Object.fromEntries(cfg.assets.map((a) => [a.id, []]));
  const wins = Object.fromEntries(cfg.assets.map((a) => [a.id, 0]));
  let done = 0, k = 0;
  $('dist').innerHTML = '<p class="sub">Running 1,000 investors…</p>'; $('axis').innerHTML = '';
  const batch = () => {
    if (token !== mcToken) return;
    const stop = Math.min(MC_RUNS, k + 80);
    for (; k < stop; k++) {
      const R = simulate(100000 + k, cfg, false);
      if (!R.buys.length) continue;
      done++;
      let best = null;
      for (const a of cfg.assets) { res[a.id].push(R.a[a.id].irr); if (!best || R.a[a.id].fv > R.a[best].fv) best = a.id; }
      wins[best]++;
    }
    if (k < MC_RUNS) setTimeout(batch, 0); else renderDist(cfg, res, wins, done);
  };
  setTimeout(batch, 0);
}
function renderDist(cfg, res, wins, done) {
  if (!done) { $('dist').innerHTML = '<p class="sub">No purchases happened. Raise the buying chance.</p>'; return; }
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  const stats = cfg.assets.map((a) => {
    const s = res[a.id].filter(Number.isFinite).sort((x, y) => x - y);
    return { a, p5: q(s, 0.05), p25: q(s, 0.25), p50: q(s, 0.5), p75: q(s, 0.75), p95: q(s, 0.95), win: wins[a.id] / done };
  }).sort((x, y) => y.p50 - x.p50);
  const L = (r) => Math.log1p(Math.max(r, -0.99));
  const lo = Math.min(L(-0.05), ...stats.map((s) => L(s.p5)));
  const hi = Math.max(L(0.1), ...stats.map((s) => L(s.p95)));
  const X = (r) => ((L(r) - lo) / (hi - lo) * 100).toFixed(2) + '%';
  $('dist').innerHTML = stats.map((s) => `<div class="drow">
      <div class="nm"><span class="dot" style="background:${colorOf(s.a)}"></span><span class="t">${esc(s.a.name)}</span></div>
      <div class="dbar"><div class="zero" style="left:${X(0)}"></div><div class="rng" style="left:${X(s.p5)};width:calc(${X(s.p95)} - ${X(s.p5)});background:${colorOf(s.a)}"></div><div class="iqr" style="left:${X(s.p25)};width:max(4px, calc(${X(s.p75)} - ${X(s.p25)}));background:${colorOf(s.a)}"></div><div class="med" style="left:calc(${X(s.p50)} - 1.5px)"></div></div>
      <div class="dnum">median <b>${pct(s.p50)}</b><br><span style="color:var(--muted)">${pct(s.p5, 0)} to ${pct(s.p95, 0)}</span></div></div>`).join('');
  const cand = [-0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20];
  const inRange = cand.filter((r) => L(r) >= lo && L(r) <= hi);
  const narrow = $('dist').clientWidth < 500;
  let lastPos = -100, ax = '';
  for (const r of inRange) { const pos = (L(r) - lo) / (hi - lo) * 100; if (pos - lastPos < (narrow ? 13 : 7)) continue; lastPos = pos; ax += `<span style="left:${pos}%">${Math.round(r * 100)}%</span>`; }
  $('axis').innerHTML = ax;
}

/* ---------------- ledger ---------------- */
function renderLedger(R) {
  const as = R.cfg.assets;
  $('ledgerCount').textContent = `(${R.buys.length})`;
  const head = `<thead><tr><th>Date</th><th>Amount</th>${as.map((a) => `<th>${esc(a.ticker === 'yours' ? a.name : a.ticker)}</th>`).join('')}</tr></thead>`;
  const rows = R.buys.map((b, k) => `<tr><td>${lab(b.i)} ${b.day}</td><td>${money(b.amt)}</td>${as.map((a) => `<td>${priceFmt(R.a[a.id].px[k])}</td>`).join('')}</tr>`).join('');
  $('ledger').innerHTML = head + '<tbody>' + rows + '</tbody>';
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const r = await fetch('data/prices.json', { cache: 'no-cache' });
    DATA = await r.json();
  } catch (e) {
    $('board').innerHTML = '<li class="sub">Could not load price data. If you opened index.html from disk, run a local server (see README).</li>';
    return;
  }
  M = DATA.months; N = M.length;
  buildAssets();
  state = readState();
  $('dataStart').textContent = lab(1); $('dataEnd').textContent = lab(N - 1); $('dataUpd').textContent = DATA.updated;
  if (DATA.repo) { $('repoLink').href = DATA.repo; $('repoWrap').hidden = false; }
  initControls();
  run();
  let rw; addEventListener('resize', () => { clearTimeout(rw); rw = setTimeout(() => lastRun && drawChart(lastRun), 150); });
}
boot();
