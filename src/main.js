import './styles.css';
import { drawChart } from './chart.js';
import {
  schedule, runInvestor, xirr, firstBuyIdx, localPrices, cpiIndex, quantile, parseCustomPrices, monthsSince,
} from './sim.js';

/* ---------------- constants ---------------- */
const $ = (id) => document.getElementById(id);
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MC_RUNS = 1000;
const CUSTOM_KEY = 'gvm.custom.v1';
const DEFAULT_START = '2010-08';
const DESKTOP = matchMedia('(min-width: 1024px)');

// Approximate average CPI inflation 2010–2025, % a year (editable in the UI).
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
const GROUPS = [
  ['metals', 'Metals'], ['crypto', 'Crypto'], ['americas', 'Americas'], ['europe', 'Europe'], ['asia', 'Asia-Pacific'], ['global', 'Global'], ['custom', 'Your picks'],
];
const PRESETS = {
  majors: ['spx', 'nasdaq', 'europe', 'japan', 'china', 'world', 'gold', 'silver', 'btc'],
  hard: ['gold', 'silver', 'btc'],
};
const FIXED_COLOR = { gold: 'var(--c-gold)', silver: 'var(--c-silver)', btc: 'var(--c-btc)' };
const METRICS = [
  { id: 'value', label: 'Value', hint: 'What everything you bought is worth at each month-end, against the cash you put in.' },
  { id: 'gain', label: 'Gain %', hint: 'Profit or loss as a percentage of the cash put in so far.' },
  { id: 'real', label: 'After inflation', hint: 'Value restated in today\'s money, so a flat line means you only kept up with prices.' },
  { id: 'price', label: 'Price', hint: 'The asset\'s own price in your currency, starting at 100. Ignores when you bought.' },
  { id: 'drawdown', label: 'Drawdown', hint: 'How far each asset\'s price sat below its previous peak. Shows how painful it was to hold.' },
];

/* ---------------- state ---------------- */
let DATA, M, N, ASSETS = [], state = {}, lastRun = null, mcToken = 0;
const hidden = new Set();
let fmtMoney, fmtCompact;

/* ---------------- helpers ---------------- */
const lab = (i) => { const [y, m] = M[i].split('-'); return `${MN[+m - 1]} ${y}`; };
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');
const sPct = (x, d = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + pct(x, d) : '–');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (x) => (Math.abs(x) >= 1e7 ? fmtCompact.format(x) : fmtMoney.format(x));
const mult = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + '×';
const flagSrc = (a) => `/flags/${a.flag}.svg`;
const flagImg = (a, cls = 'flag') => `<img class="${cls}" src="${flagSrc(a)}" alt="" width="24" height="24" loading="lazy">`;
function setMoney(cur) {
  fmtMoney = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 });
  fmtCompact = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 });
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
}
const clampNum = (v, lo, hi, d) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/* ---------------- assets ---------------- */
function loadCustom() { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); } catch { return []; } }
function saveCustom(list) { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch { /* blocked */ } }
function buildAssets() {
  ASSETS = DATA.assets.map((a) => ({ ...a }));
  for (const c of loadCustom()) {
    ASSETS.push({ id: c.id, name: c.name, short: c.name, ticker: 'your data', group: 'custom', flag: 'custom', note: 'Prices you pasted', prices: c.prices, custom: true });
  }
  for (const a of ASSETS) a.firstBuy = firstBuyIdx(a.prices);
}
function colors(selected) {
  const map = {};
  let k = 0;
  for (const a of selected) {
    if (FIXED_COLOR[a.id]) map[a.id] = FIXED_COLOR[a.id];
    else if (a.custom) map[a.id] = 'var(--c-custom)';
    else map[a.id] = `var(--p${(k++ % 12) + 1})`;
  }
  return map;
}

/* ---------------- URL state ---------------- */
function readState() {
  const q = new URLSearchParams(location.search);
  const ids = ASSETS.map((a) => a.id);
  const cur = q.get('cur');
  const st = {
    cur: cur === 'USD' || DATA.fx[cur] ? cur : 'USD',
    start: M.includes(q.get('from')) ? q.get('from') : DEFAULT_START,
    end: M.includes(q.get('to')) ? q.get('to') : M[N - 1],
    mode: ['random', 'monthly', 'lump'].includes(q.get('mode')) ? q.get('mode') : 'random',
    p: clampNum(q.get('p'), 10, 100, 60),
    lo: clampNum(q.get('min'), 1, 1e12, 100),
    hi: clampNum(q.get('max'), 1, 1e12, 2000),
    amt: clampNum(q.get('amt'), 1, 1e13, 500),
    seed: clampNum(q.get('seed'), 1, 1e9, 42) | 0,
    log: q.get('log') !== '0',
    metric: METRICS.some((m) => m.id === q.get('view')) ? q.get('view') : 'value',
  };
  st.infl = q.get('infl') != null ? clampNum(q.get('infl'), -20, 200, 2.5) : INFL_DEFAULT[st.cur] ?? 2.5;
  const qa = q.get('assets');
  st.assets = new Set(qa ? qa.split(',').filter((x) => ids.includes(x)) : PRESETS.majors.filter((x) => ids.includes(x)));
  if (M.indexOf(st.start) < 1) st.start = M[1];
  if (M.indexOf(st.end) < M.indexOf(st.start)) st.end = M[N - 1];
  return st;
}
function writeState() {
  const q = new URLSearchParams();
  q.set('cur', state.cur); q.set('from', state.start); q.set('to', state.end); q.set('mode', state.mode);
  if (state.mode === 'random') { q.set('p', state.p); q.set('min', state.lo); q.set('max', state.hi); q.set('seed', state.seed); }
  else q.set('amt', state.amt);
  if (state.cur !== 'USD') q.set('infl', state.infl);
  q.set('assets', [...state.assets].join(','));
  if (state.metric !== 'value') q.set('view', state.metric);
  if (!state.log) q.set('log', '0');
  history.replaceState(null, '', `?${q}${location.hash}`);
}

/* ---------------- controls ---------------- */
function initControls() {
  $('cur').innerHTML = ['USD', ...Object.keys(DATA.fx)].map((c) => `<option value="${c}">${c} – ${CUR_NAMES[c] || c}</option>`).join('');
  const opts = M.map((m, i) => (i === 0 ? '' : `<option value="${m}">${lab(i)}</option>`)).join('');
  $('startM').innerHTML = opts; $('endM').innerHTML = opts;
  $('metricSeg').innerHTML = METRICS.map((m) => `<label><input type="radio" name="metric" value="${m.id}"><span>${m.label}</span></label>`).join('');
  renderAssetPicker();

  $('cur').addEventListener('change', (e) => { state.cur = e.target.value; state.infl = INFL_DEFAULT[state.cur] ?? 2.5; run(); });
  $('infl').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { state.infl = v; run(); } });
  $('startM').addEventListener('change', (e) => { state.start = e.target.value; if (M.indexOf(state.end) < M.indexOf(state.start)) state.end = state.start; run(); });
  $('endM').addEventListener('change', (e) => { state.end = e.target.value; if (M.indexOf(state.end) < M.indexOf(state.start)) state.start = state.end; run(); });
  $('periodPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-years]'); if (!b) return;
    const yrs = +b.dataset.years;
    state.end = M[N - 1];
    state.start = yrs ? M[Math.max(1, N - yrs * 12)] : DEFAULT_START;
    run();
  });
  document.querySelectorAll('input[name=mode]').forEach((el) => el.addEventListener('change', () => { state.mode = el.value; run(); }));
  $('freq').addEventListener('input', (e) => { $('freqV').textContent = `${e.target.value}%`; });
  $('freq').addEventListener('change', (e) => { state.p = +e.target.value; run(); });
  const bindNum = (id, key) => $(id).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) { state[key] = v; run(); } else syncControls();
  });
  bindNum('minA', 'lo'); bindNum('maxA', 'hi'); bindNum('amt', 'amt');
  $('runBtn').addEventListener('click', () => { state.seed = Math.floor(Math.random() * 999999) + 1; run(); });
  $('assetPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    const p = b.dataset.preset;
    state.assets = new Set(p === 'all' ? ASSETS.map((a) => a.id) : p === 'none' ? [] : PRESETS[p].filter((id) => ASSETS.some((a) => a.id === id)));
    run();
  });
  $('metricSeg').addEventListener('change', (e) => { state.metric = e.target.value; writeState(); renderChart(); });
  $('logS').addEventListener('change', (e) => { state.log = e.target.checked; writeState(); renderChart(); });
  document.querySelector('.legend-tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]'); if (!b || !lastRun) return;
    const ids = lastRun.order.map((a) => a.id);
    hidden.clear();
    if (b.dataset.show === 'none') ids.forEach((id) => hidden.add(id));
    if (b.dataset.show === 'top5') ids.slice(5).forEach((id) => hidden.add(id));
    renderChart();
  });
  $('shareBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied'); }
    catch { window.prompt('Copy this link', location.href); }
  });
  $('cAdd').addEventListener('click', addCustom);

  // tabs (mobile)
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab, true); });
  // settings sheet (mobile)
  $('dockBtn').addEventListener('click', openSheet);
  $('sheetDone').addEventListener('click', closeSheet);
  $('backdrop').addEventListener('click', closeSheet);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('sheet-open')) closeSheet(); });
  DESKTOP.addEventListener('change', () => { closeSheet(); if (lastRun) renderChart(); });
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => lastRun && renderChart(), 150); });
}

function renderAssetPicker() {
  const html = GROUPS.map(([g, title]) => {
    const list = ASSETS.filter((a) => a.group === g);
    if (!list.length) return '';
    return `<div class="region"><div class="region-h"><span>${title}</span><button type="button" class="link" data-group="${g}">toggle</button></div>
      <div class="chips">${list.map((a) => `<button type="button" class="chip" data-id="${a.id}" aria-pressed="${state.assets.has(a.id)}" title="${esc(`${a.ticker} · ${a.note || ''}`)}">${flagImg(a)}<span>${esc(a.short || a.name)}</span>${a.custom ? `<span class="x" data-del="${a.id}" role="button" aria-label="Remove ${esc(a.name)}">×</span>` : ''}</button>`).join('')}</div></div>`;
  }).join('');
  $('assetGroups').innerHTML = html;
  $('assetGroups').querySelectorAll('.chip').forEach((el) => el.addEventListener('click', (ev) => {
    const id = el.dataset.id;
    if (ev.target.dataset.del) { removeCustom(id); return; }
    if (state.assets.has(id)) state.assets.delete(id); else state.assets.add(id);
    run();
  }));
  $('assetGroups').querySelectorAll('[data-group]').forEach((el) => el.addEventListener('click', () => {
    const ids = ASSETS.filter((a) => a.group === el.dataset.group).map((a) => a.id);
    const allOn = ids.every((id) => state.assets.has(id));
    ids.forEach((id) => (allOn ? state.assets.delete(id) : state.assets.add(id)));
    run();
  }));
}

function addCustom() {
  const name = ($('cName').value.trim() || 'My stock').slice(0, 24);
  const { prices, count } = parseCustomPrices($('cData').value, M);
  if (count < 3) { $('cMsg').textContent = 'Could not read at least 3 monthly prices. Use lines like 2015-06,42.10'; return; }
  const list = loadCustom();
  const id = `c_${Date.now().toString(36)}`;
  list.push({ id, name, prices });
  saveCustom(list);
  buildAssets(); state.assets.add(id); renderAssetPicker();
  $('cMsg').textContent = `Added ${name} with ${count} monthly prices.`;
  $('cData').value = ''; $('cName').value = '';
  run();
}
function removeCustom(id) {
  saveCustom(loadCustom().filter((c) => c.id !== id));
  state.assets.delete(id); buildAssets(); renderAssetPicker(); run();
}

function syncControls() {
  $('cur').value = state.cur; $('startM').value = state.start; $('endM').value = state.end;
  $('infl').value = state.infl; $('inflField').hidden = state.cur === 'USD';
  document.querySelectorAll('input[name=mode]').forEach((el) => { el.checked = el.value === state.mode; });
  document.querySelectorAll('input[name=metric]').forEach((el) => { el.checked = el.value === state.metric; });
  $('freq').value = state.p; $('freqV').textContent = `${state.p}%`;
  $('minA').value = state.lo; $('maxA').value = state.hi; $('amt').value = state.amt;
  $('amtLabel').textContent = state.mode === 'lump' ? 'Amount invested once' : 'Amount each month';
  document.querySelectorAll('.m-random').forEach((el) => { el.hidden = state.mode !== 'random'; });
  document.querySelectorAll('.m-fixed').forEach((el) => { el.hidden = state.mode === 'random'; });
  $('modeHint').textContent = {
    random: 'Buys in random months, random amounts, on random days. Closest to how most people really invest.',
    monthly: 'The same amount in the middle of every month (dollar-cost averaging).',
    lump: 'Everything at once on the first day, then hold.',
  }[state.mode];
  const metricIsPct = state.metric === 'gain' || state.metric === 'drawdown';
  $('logS').checked = state.log && !metricIsPct; $('logS').disabled = metricIsPct;
  $('metricHint').textContent = METRICS.find((m) => m.id === state.metric).hint;
  document.querySelectorAll('#assetGroups .chip').forEach((el) => el.setAttribute('aria-pressed', state.assets.has(el.dataset.id)));
  $('selCount').textContent = `${state.assets.size} of ${ASSETS.length}`;
  const sIdx = M.indexOf(state.start), eIdx = M.indexOf(state.end);
  document.querySelectorAll('#periodPresets [data-years]').forEach((b) => {
    const yrs = +b.dataset.years;
    const on = eIdx === N - 1 && (yrs ? sIdx === Math.max(1, N - yrs * 12) : state.start === DEFAULT_START);
    b.setAttribute('aria-pressed', on);
  });
  document.querySelectorAll('#assetPresets [data-preset]').forEach((b) => {
    const p = b.dataset.preset;
    const want = p === 'all' ? ASSETS.map((a) => a.id) : p === 'none' ? [] : PRESETS[p];
    b.setAttribute('aria-pressed', want.length === state.assets.size && want.every((id) => state.assets.has(id)));
  });
  const modeTxt = { random: `random buys ${state.p}%`, monthly: `${fmtMoney.format(state.amt)} monthly`, lump: `${fmtMoney.format(state.amt)} once` }[state.mode];
  $('dockSum').innerHTML = `<b>${state.cur}</b> · ${lab(sIdx)} – ${lab(eIdx)} · ${modeTxt} · ${state.assets.size} assets`;
}

/* ---------------- sheet & tabs ---------------- */
let lastFocus = null;
function openSheet() {
  if (DESKTOP.matches) return;
  lastFocus = document.activeElement;
  document.body.classList.add('sheet-open');
  $('backdrop').hidden = false;
  $('dockBtn').setAttribute('aria-expanded', 'true');
  $('settings').setAttribute('role', 'dialog'); $('settings').setAttribute('aria-modal', 'true');
  setTimeout(() => $('sheetDone').focus(), 50);
}
function closeSheet() {
  document.body.classList.remove('sheet-open');
  $('backdrop').hidden = true;
  $('dockBtn').setAttribute('aria-expanded', 'false');
  $('settings').removeAttribute('role'); $('settings').removeAttribute('aria-modal');
  if (lastFocus && !DESKTOP.matches) lastFocus.focus?.();
}
function setTab(tab, scroll) {
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab));
  history.replaceState(null, '', `${location.search}#${tab}`);
  if (tab === 'chart' && lastRun) renderChart();
  if (scroll && !DESKTOP.matches) {
    const top = $('tabs').getBoundingClientRect().top + scrollY - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--top-h'));
    if (scrollY > top) scrollTo({ top, behavior: 'instant' });
  }
}

/* ---------------- run ---------------- */
function config() {
  const sel = ASSETS.filter((a) => state.assets.has(a.id));
  let s = M.indexOf(state.start);
  const e = M.indexOf(state.end);
  const need = sel.length ? Math.max(...sel.map((a) => a.firstBuy)) : 1;
  const late = sel.filter((a) => a.firstBuy > s);
  if (need > s) s = Math.min(need, e);
  const fx = state.cur === 'USD' ? null : DATA.fx[state.cur];
  let lo = state.lo, hi = state.hi; if (hi < lo) [lo, hi] = [hi, lo];
  const cols = colors(sel);
  return {
    s, e, late, sel, fx, cols,
    sch: { s, e, mode: state.mode, p: state.p / 100, lo, hi, amt: state.amt },
    cpi: cpiIndex(M, state.cur, DATA.cpiUS, state.infl),
    assets: sel.map((a) => ({ id: a.id, local: localPrices(a.prices, fx) })),
  };
}

function run() {
  setMoney(state.cur);
  syncControls(); writeState();
  const cfg = config();
  const warn = $('startWarn');
  if (cfg.late.length && cfg.sel.length) {
    warn.hidden = false;
    warn.textContent = `${cfg.late.map((a) => a.short || a.name).join(', ')} ${cfg.late.length > 1 ? 'have' : 'has'} no prices before ${lab(cfg.s - 1)}, so everything starts in ${lab(cfg.s)}.`;
  } else warn.hidden = true;

  if (!cfg.sel.length) {
    lastRun = null; mcToken++;
    $('verdict').innerHTML = '<h1 class="v-head">Pick something to compare.</h1><p class="v-sub">Open Settings and choose at least one market, metal or coin.</p>';
    ['board', 'legend', 'chart', 'dist', 'axis', 'ledger'].forEach((id) => { $(id).innerHTML = ''; });
    $('runSum').textContent = '';
    return;
  }
  const buys = schedule(state.seed, cfg.sch);
  const R = runInvestor(buys, cfg.assets, { e: cfg.e, cpi: cfg.cpi, detail: true });
  R.cfg = cfg;
  R.order = [...cfg.sel].sort((x, y) => (R.a[y.id]?.fv ?? 0) - (R.a[x.id]?.fv ?? 0));
  lastRun = R;
  renderVerdict(R); renderBoard(R); renderChart(); renderLedger(R);
  if (state.mode === 'random') runMC(cfg);
  else { mcToken++; $('dist').innerHTML = '<p class="empty">The odds view needs random buying. Choose <b>Random</b> under How you buy.</p>'; $('axis').innerHTML = ''; }
}

/* ---------------- verdict ---------------- */
function renderVerdict(R) {
  const cfg = R.cfg;
  if (!R.buys.length) {
    $('verdict').innerHTML = '<h1 class="v-head">No purchases in this window.</h1><p class="v-sub">Raise the buying chance or widen the dates.</p>';
    return;
  }
  const best = R.order[0], worst = R.order[R.order.length - 1];
  const bv = R.a[best.id];
  const how = { random: `put in ${money(R.invested)} at random`, monthly: `put in ${money(cfg.sch.amt)} every month`, lump: `put in ${money(cfg.sch.amt)} once` }[state.mode];
  const head = `Since ${lab(cfg.s)}, if you ${how}, <span class="hl">${esc(best.name)}</span> would have turned it into ${money(bv.fv)}.`;
  const tile = (a, label, cls = '') => {
    const r = R.a[a.id];
    return `<div class="tile ${cls}"><div class="t-l">${flagImg(a)}<span>${esc(label)}</span></div><div class="t-v">${money(r.fv)}</div><div class="t-s">${mult(r.fv / R.invested)} · ${sPct(r.real)} real/yr</div></div>`;
  };
  const tiles = [tile(best, `Best: ${best.short || best.name}`, 'best')];
  const gold = R.order.find((a) => a.id === 'gold');
  if (gold && gold !== best && gold !== worst) tiles.push(tile(gold, `Gold · #${R.order.indexOf(gold) + 1} of ${R.order.length}`));
  else if (R.order.length > 2) { const mid = R.order[Math.floor(R.order.length / 2)]; tiles.push(tile(mid, `Middle: ${mid.short || mid.name}`)); }
  if (worst !== best) tiles.push(tile(worst, `Worst: ${worst.short || worst.name}`));
  tiles.push(`<div class="tile"><div class="t-l"><span class="ic dash" style="color:var(--infl)"></span><span>Just keeping up with inflation</span></div><div class="t-v">${money(R.inflNeeded)}</div><div class="t-s">${mult(R.inflNeeded / R.invested)} · cash alone: ${money(R.invested)}</div></div>`);
  const beat = R.order.filter((a) => R.a[a.id].fv > R.inflNeeded).length;
  const btcNote = best.id === 'btc' && M[cfg.s] < '2013-01' ? ' Early Bitcoin prices come from tiny exchanges, so treat that as an upper bound.' : '';
  $('verdict').innerHTML = `<h1 class="v-head">${head}</h1>
    <p class="v-sub">${beat} of ${R.order.length} beat inflation.${btcNote} Values at the end of ${lab(cfg.e)}, in ${CUR_NAMES[state.cur] || state.cur}${state.cur === 'USD' ? 's' : ''}.</p>
    <div class="tiles">${tiles.join('')}</div>`;
}

/* ---------------- ranking ---------------- */
function renderBoard(R) {
  const n = R.buys.length, cfg = R.cfg;
  $('runSum').textContent = !n ? '' : state.mode === 'random'
    ? `Investor #${state.seed}: ${n} purchases in ${cfg.e - cfg.s + 1} months, ${money(R.invested)} in total.`
    : state.mode === 'monthly' ? `${n} monthly purchases, ${money(R.invested)} in total.` : `${money(R.invested)} invested at the start of ${lab(cfg.s)}.`;
  if (!n) { $('board').innerHTML = ''; return; }
  const lm = (v) => Math.log(Math.max(v, 0.01));
  const mults = R.order.map((a) => R.a[a.id].fv / R.invested);
  const maxL = lm(Math.max(...mults, R.inflNeeded / R.invested, 1)), minL = Math.min(0, ...mults.map(lm));
  const w = (m) => Math.max(2, ((lm(m) - minL) / (maxL - minL || 1)) * 100);
  const row = (rank, icon, name, sub, color, fv, irr, real, cls = '') => {
    const m = fv / R.invested, gain = fv - R.invested;
    return `<li class="row ${cls}"><span class="rk ${rank === 1 ? 'gold-1' : ''}">${rank}</span>
      <span class="nm">${icon}<span class="t">${esc(name)}<small>${esc(sub)}</small></span></span>
      <span class="bar" title="${mult(m)} your money"><i style="width:${w(m).toFixed(1)}%;background:${color}"></i></span>
      <span class="num big c-val">${money(fv)}</span>
      <span class="metrics">
        <span class="num ${gain >= 0 ? 'pos' : 'neg'}"><span class="ml">Profit</span>${gain >= 0 ? '+' : ''}${money(gain)}</span>
        <span class="num"><span class="ml">Per year</span>${pct(irr)}</span>
        <span class="num ${real >= 0 ? 'pos' : 'neg'}"><span class="ml">Real / yr</span>${sPct(real)}</span>
      </span></li>`;
  };
  const head = '<li class="row head"><span></span><span>Asset</span><span>Money multiple</span><span class="num">Worth now</span><span class="num">Profit</span><span class="num">Per year</span><span class="num">After inflation</span></li>';
  let html = head + R.order.map((a, i) => {
    const r = R.a[a.id];
    return row(i + 1, flagImg(a, 'flag ic'), a.name, `${a.ticker} · ${mult(r.fv / R.invested)}`, R.cfg.cols[a.id], r.fv, r.irr, r.real);
  }).join('');
  const ts = R.buys.map((b) => b.t), amts = R.buys.map((b) => b.amt);
  html += row('', '<span class="ic dash" style="color:var(--infl)"></span>', 'Keeping up with inflation', 'the bar to clear', 'var(--infl)', R.inflNeeded, xirr(ts, amts, R.tEnd, R.inflNeeded), 0, 'base');
  html += row('', '<span class="ic dash" style="color:var(--cash)"></span>', 'Cash under the mattress', 'no return', 'var(--cash)', R.invested, 0, xirr(ts, R.realAmts, R.tEnd, R.invested), 'base');
  $('board').innerHTML = html;
}

/* ---------------- chart ---------------- */
function renderChart() {
  const R = lastRun;
  if (!R || !R.idx) { $('chart').innerHTML = ''; $('legend').innerHTML = ''; return; }
  if (!DESKTOP.matches && !document.querySelector('[data-pane="chart"]').classList.contains('on')) return; // draw when visible
  const cfg = R.cfg, idx = R.idx, metric = state.metric;
  const cpiE = cfg.cpi[cfg.e];
  const labels = idx.map((j) => lab(j));
  const yearOf = (k) => (M[idx[k]].endsWith('-01') ? +M[idx[k]].slice(0, 4) : null);
  const localById = Object.fromEntries(cfg.assets.map((a) => [a.id, a.local]));
  const seriesFor = (a) => {
    const r = R.a[a.id];
    const P = localById[a.id];
    switch (metric) {
      case 'gain': return r.path.map((v, k) => (R.cash[k] > 0 ? v / R.cash[k] - 1 : null));
      case 'real': return r.path.map((v, k) => v * cpiE / cfg.cpi[idx[k]]);
      case 'price': return idx.map((j) => (P[j] / P[idx[0]]) * 100);
      case 'drawdown': { let peak = 0; return idx.map((j) => { peak = Math.max(peak, P[j]); return P[j] / peak - 1; }); }
      default: return r.path;
    }
  };
  const extras = [];
  if (metric === 'value') {
    extras.push({ id: '_cash', name: 'Cash put in', color: 'var(--cash)', v: R.cash, dash: '6 5', thin: true });
    extras.push({ id: '_infl', name: 'Cash + inflation', color: 'var(--infl)', v: R.infl, dash: '2 4', thin: true });
  } else if (metric === 'gain') {
    extras.push({ id: '_infl', name: 'Inflation', color: 'var(--infl)', v: R.infl.map((v, k) => (R.cash[k] > 0 ? v / R.cash[k] - 1 : null)), dash: '2 4', thin: true });
  } else if (metric === 'real') {
    extras.push({ id: '_cash', name: 'Cash put in (today\'s money)', color: 'var(--infl)', v: R.cash.map((v, k) => R.infl[k] * cpiE / cfg.cpi[idx[k]]), dash: '2 4', thin: true });
    extras.push({ id: '_mat', name: 'Cash under the mattress', color: 'var(--cash)', v: R.cash.map((v, k) => v * cpiE / cfg.cpi[idx[k]]), dash: '6 5', thin: true });
  } else if (metric === 'price') {
    extras.push({ id: '_cpi', name: 'Prices in shops (CPI)', color: 'var(--infl)', v: idx.map((j) => (cfg.cpi[j] / cfg.cpi[idx[0]]) * 100), dash: '2 4', thin: true });
  }
  const main = R.order.map((a) => ({ id: a.id, a, name: a.short || a.name, color: cfg.cols[a.id], v: seriesFor(a) }));
  const vis = [...main, ...extras].filter((s) => !hidden.has(s.id));

  $('legend').innerHTML = main.map((s) => `<button type="button" class="lg" data-id="${s.id}" aria-pressed="${!hidden.has(s.id)}" style="border-color:${hidden.has(s.id) ? 'var(--line)' : s.color}">${flagImg(s.a)}<span>${esc(s.name)}</span></button>`).join('')
    + extras.map((s) => `<button type="button" class="lg extra" data-id="${s.id}" aria-pressed="${!hidden.has(s.id)}"><i class="sw" style="background:repeating-linear-gradient(90deg,${s.color} 0 4px,transparent 4px 7px)"></i><span>${esc(s.name)}</span></button>`).join('');
  $('legend').querySelectorAll('.lg').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id; if (hidden.has(id)) hidden.delete(id); else hidden.add(id); renderChart();
  }));

  const unit = metric === 'gain' || metric === 'drawdown' ? 'pct' : metric === 'price' ? 'index' : 'money';
  const fmt = unit === 'pct' ? (v) => sPct(v) : unit === 'index' ? (v) => v.toFixed(1) : (v) => money(v);
  const fmtAxis = unit === 'pct' ? (v) => `${Math.round(v * 100)}%` : unit === 'index' ? (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(1)}`) : (v) => fmtCompact.format(v);
  drawChart($('chart'), { series: vis, labels, yearOf, unit, log: state.log, fmt, fmtAxis, aria: `${METRICS.find((m) => m.id === metric).label} over time` });
}

/* ---------------- Monte Carlo ---------------- */
function runMC(cfg) {
  const token = ++mcToken;
  const res = Object.fromEntries(cfg.sel.map((a) => [a.id, []]));
  const wins = Object.fromEntries(cfg.sel.map((a) => [a.id, 0]));
  let done = 0, k = 0;
  $('dist').innerHTML = '<p class="empty">Simulating 1,000 investors…</p>'; $('axis').innerHTML = '';
  const step = () => {
    if (token !== mcToken) return;
    const stop = Math.min(MC_RUNS, k + 60);
    for (; k < stop; k++) {
      const buys = schedule(100000 + k, cfg.sch);
      if (!buys.length) continue;
      const R = runInvestor(buys, cfg.assets, { e: cfg.e, cpi: cfg.cpi });
      done++;
      let best = null;
      for (const a of cfg.sel) { res[a.id].push(R.a[a.id].irr); if (!best || R.a[a.id].fv > R.a[best].fv) best = a.id; }
      wins[best]++;
    }
    if (k < MC_RUNS) setTimeout(step, 0); else renderDist(cfg, res, wins, done);
  };
  setTimeout(step, 0);
}
function renderDist(cfg, res, wins, done) {
  if (!done) { $('dist').innerHTML = '<p class="empty">No purchases happened. Raise the buying chance.</p>'; return; }
  const stats = cfg.sel.map((a) => {
    const s = res[a.id].filter(Number.isFinite).sort((x, y) => x - y);
    return { a, p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95), win: wins[a.id] / done };
  }).sort((x, y) => y.p50 - x.p50);
  const L = (r) => Math.log1p(Math.max(r, -0.99));
  const lo = Math.min(L(-0.05), ...stats.map((s) => L(s.p5)));
  const hi = Math.max(L(0.1), ...stats.map((s) => L(s.p95)));
  const X = (r) => `${(((L(r) - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  $('dist').innerHTML = stats.map((s) => {
    const c = cfg.cols[s.a.id];
    return `<div class="drow"><div class="nm">${flagImg(s.a)}<span class="t">${esc(s.a.short || s.a.name)}</span></div>
      <div class="dbar"><div class="zero" style="left:${X(0)}"></div><div class="rng" style="left:${X(s.p5)};width:calc(${X(s.p95)} - ${X(s.p5)});background:${c}"></div><div class="iqr" style="left:${X(s.p25)};width:max(4px, calc(${X(s.p75)} - ${X(s.p25)}));background:${c}"></div><div class="med" style="left:calc(${X(s.p50)} - 1.5px)"></div></div>
      <div class="dnum"><b>${pct(s.p50)}</b> median<br><span class="muted">${pct(s.p5, 0)} to ${pct(s.p95, 0)}${s.win >= 0.005 ? ` · #1 in ${pct(s.win, 0)}` : ''}</span></div></div>`;
  }).join('');
  const cand = [-0.3, -0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20];
  const narrow = $('dist').clientWidth < 520;
  let last = -100, ax = '';
  for (const r of cand) {
    if (L(r) < lo || L(r) > hi) continue;
    const pos = ((L(r) - lo) / (hi - lo)) * 100;
    if (pos - last < (narrow ? 12 : 6)) continue;
    last = pos; ax += `<span style="left:${pos}%">${Math.round(r * 100)}%</span>`;
  }
  $('axis').innerHTML = ax;
}

/* ---------------- ledger ---------------- */
function renderLedger(R) {
  const as = R.order;
  $('ledgerSub').textContent = `${R.buys.length} purchases. Prices in ${state.cur}.`;
  const head = `<thead><tr><th>Date</th><th>Amount</th>${as.map((a) => `<th title="${esc(a.name)}">${esc(a.custom ? a.name : a.ticker)}</th>`).join('')}</tr></thead>`;
  const pf = (x) => (x >= 1000 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
  const rows = R.buys.map((b, k) => `<tr><td>${lab(b.i)} ${b.day}</td><td>${money(b.amt)}</td>${as.map((a) => `<td>${pf(R.a[a.id].px[k])}</td>`).join('')}</tr>`).join('');
  $('ledger').innerHTML = `${head}<tbody>${rows}</tbody>`;
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const r = await fetch('/data/prices.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.statusText);
    DATA = await r.json();
  } catch {
    $('verdict').innerHTML = '<h1 class="v-head">Could not load price data.</h1><p class="v-sub">Check your connection and reload. Running locally? Use <code>npm run dev</code>.</p>';
    return;
  }
  M = DATA.months; N = M.length;
  buildAssets();
  state = readState();
  setMoney(state.cur);
  const age = monthsSince(DATA.end);
  const badge = $('dataBadge');
  badge.innerHTML = `<span class="long">Prices to </span>${lab(N - 1)}`;
  if (age > 2) { badge.classList.add('stale'); badge.title = 'The monthly data update has not run recently.'; badge.innerHTML += ' · outdated'; }
  $('dataInfo').innerHTML = `Data: ${lab(1)} to ${lab(N - 1)}, updated ${esc(DATA.updated)}. Sources: ${(DATA.sources || []).map(esc).join('; ')}.`;
  initControls();
  const tab = (location.hash || '').slice(1);
  setTab(['rank', 'chart', 'odds', 'buys', 'about'].includes(tab) ? tab : 'rank', false);
  run();
}
boot();
