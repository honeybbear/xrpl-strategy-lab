/* XRPL Strategy Lab — app.js
 * Static charting lab. Token universe is fully data-driven: at load time the
 * app scans data/*.json (via the GitHub Contents API) and builds the token
 * switcher from whatever token files exist. Adding a token = drop
 * data/<TOKEN>.json into the repo + update data/SNAPSHOT.json. Nothing else.
 *
 * Live feed: public XRPL WebSocket (xrplcluster.com -> s1/s2.ripple.com),
 * ledger stream + order-book subscription for the token/XRP pair. Browser
 * WebSocket connections are not subject to CORS, so this works from a static
 * page. xMagnetic was checked (2026-10-07): it has no public quote API
 * (site-internal endpoints only), so there is no xMagnetic polling fallback.
 * If the socket fails, the UI goes OFFLINE honestly and freezes the last
 * candle — stale prices are never shown as live.
 */
"use strict";

/* =====================================================================
 * INDICATOR ENGINE — math matches ~/workspace/xrp-backtest/backtest.py
 * exactly (sma / rsi_wilder / stdev copied semantics; signals computed on
 * candle close[t], i.e. a signal "fires" only when candle t closes — the
 * live forming candle never produces a signal). Formulas:
 *
 *  sma(vals,n,i)   = mean(vals[i-n+1 .. i]); null if i+1 < n
 *  stdev(vals,n,i) = population stdev (divide by n); null if i+1 < n
 *  rsi_wilder(cl,n,i): null if i < n. NOTE the Python reference uses a
 *    simple windowed average (gains/losses summed over the last n bars),
 *    NOT true Wilder smoothing — replicated exactly here:
 *      gains  = sum of positive (cl[j]-cl[j-1]) for j in [i-n+1..i]
 *      losses = sum of -(negative changes) over the same window
 *      rsi = 100               if losses == 0
 *          = 100 - 100/(1+gains/losses)  otherwise
 *  bollinger: mid=sma(n), band=mid +/- mult*stdev(n)          [per backtest.py]
 *  donchian: upper[i] = max(hi[i-n .. i-1]) (Python slice hi[i-n:i] EXCLUDES
 *    bar i — breakout confirmed on close[i]); lower likewise on lo / exit n
 *  ema/macd/stochastic/atr: standard textbook definitions (no Python
 *    original exists in the backtest repo):
 *    ema: k=2/(n+1), seeded with first value
 *    macd line = ema(fast)-ema(slow); signal = ema(macd, signal_n)
 *    stochastic %K = 100*(c - lowestLow_n)/(highestHigh_n - lowestLow_n),
 *      %D = sma(%K, 3)
 *    atr (Wilder): TR=max(h-l, |h-prevC|, |l-prevC|); RMA smoothing
 * ===================================================================== */

const GH_REPO = "Honeybbear/xrpl-strategy-lab";
// Fallback ONLY if the directory scan fails (e.g. offline, rate-limited, file:// dev).
const FALLBACK_TOKENS = ["SAMPLE"];
const PAPER_START = 10000;
// Public XRPL WebSocket endpoints, tried in order (browser WS has no CORS issue).
const WS_ENDPOINTS = ["wss://xrplcluster.com", "wss://s1.ripple.com", "wss://s2.ripple.com"];
const DROPS_PER_XRP = 1e6;

// ---------------------------------------------------------------- state
const state = {
  tokens: [],
  token: null,
  daily: [],             // closed daily candles
  forming: null,         // live forming candle (today, intraday) or null
  cache: {},
  tf: "D",
  series: [],            // resampled display series (may end with live candle)
  view: { end: 0, count: 60 },
  hover: null,
  show: { ma: true, ema: true, bb: true, rsi: true },
  paper: null,
  snapshot: null,
  liveMap: {},           // token -> {currency, issuer, quote}
  feed: { status: "offline", endpoint: null, ledger: null, price: null, lastUpdate: 0, note: "not connected" },
  strategy: { id: "rsi", params: null, source: "toolkit" }, // from results/active_strategy.json
  signals: [],           // [{idx, side: 'buy'|'sell', t, price}] on closed candles
};

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 4) => (n == null || isNaN(n) ? "—" : Number(n).toFixed(d));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v == null ? "—" : Number(v).toFixed(1) + "%");
function priceDecimals(p) { return p >= 100 ? 2 : p >= 1 ? 4 : 6; }
function shortDate(t) { return t.slice(5).replace("-", "/"); }
function utcToday() { return new Date().toISOString().slice(0, 10); }

// ---------------------------------------------------------------- indicator engine
function smaAt(vals, n, i) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += vals[j];
  return s / n;
}
function smaArr(vals, n) {
  const out = new Array(vals.length).fill(null);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= n) s -= vals[i - n];
    if (i + 1 >= n) out[i] = s / n;
  }
  return out;
}
function stdevAt(vals, n, i) {
  if (i + 1 < n) return null;
  const m = smaAt(vals, n, i);
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += (vals[j] - m) * (vals[j] - m);
  return Math.sqrt(s / n); // population stdev, matches backtest.py
}
function rsiWilderAt(cl, n, i) {
  if (i < n) return null;
  let gains = 0, losses = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const ch = cl[j] - cl[j - 1];
    if (ch > 0) gains += ch; else losses -= ch;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function rsiWilderArr(cl, n) {
  const out = new Array(cl.length).fill(null);
  for (let i = 0; i < cl.length; i++) out[i] = rsiWilderAt(cl, n, i);
  return out;
}
function emaArr(vals, n) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < vals.length; i++) {
    e = e == null ? vals[i] : vals[i] * k + e * (1 - k);
    if (i + 1 >= n) out[i] = e;
  }
  return out;
}
function bollingerArrs(cl, n, mult) {
  const mid = smaArr(cl, n);
  const upper = new Array(cl.length).fill(null);
  const lower = new Array(cl.length).fill(null);
  for (let i = 0; i < cl.length; i++) {
    if (mid[i] == null) continue;
    const s = stdevAt(cl, n, i);
    upper[i] = mid[i] + mult * s;
    lower[i] = mid[i] - mult * s;
  }
  return { mid, upper, lower };
}
function macdArrs(cl, fast, slow, signalN) {
  const ef = emaArr(cl, fast), es = emaArr(cl, slow);
  const line = cl.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  // signal = EMA of the macd line; compute over line values, skipping nulls
  const sig = new Array(cl.length).fill(null);
  const k = 2 / (signalN + 1);
  let e = null, cnt = 0;
  for (let i = 0; i < cl.length; i++) {
    if (line[i] == null) continue;
    e = e == null ? line[i] : line[i] * k + e * (1 - k);
    if (++cnt >= signalN) sig[i] = e;
  }
  return { line, signal: sig };
}
function stochArrs(hi, lo, cl, n) {
  const k = new Array(cl.length).fill(null);
  for (let i = n - 1; i < cl.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, hi[j]); ll = Math.min(ll, lo[j]); }
    k[i] = hh === ll ? 50 : (100 * (cl[i] - ll)) / (hh - ll);
  }
  const d = smaArr(k.map((v) => (v == null ? 0 : v)), 3).map((v, i) => (k[i] == null || i < n + 1 ? null : v));
  return { k, d };
}
function donchianArrs(hi, lo, entryN, exitN) {
  const upper = new Array(hi.length).fill(null);
  const lower = new Array(hi.length).fill(null);
  for (let i = 0; i < hi.length; i++) {
    if (i >= entryN) { let m = -Infinity; for (let j = i - entryN; j < i; j++) m = Math.max(m, hi[j]); upper[i] = m; }
    if (i >= exitN) { let m = Infinity; for (let j = i - exitN; j < i; j++) m = Math.min(m, lo[j]); lower[i] = m; }
  }
  return { upper, lower };
}
function atrArr(hi, lo, cl, n = 14) {
  const out = new Array(cl.length).fill(null);
  let atr = null;
  for (let i = 1; i < cl.length; i++) {
    const tr = Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i - 1]), Math.abs(lo[i] - cl[i - 1]));
    atr = atr == null ? tr : (atr * (n - 1) + tr) / n; // Wilder RMA
    if (i >= n) out[i] = atr;
  }
  return out;
}

// ---------------------------------------------------------------- resample
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 864e5));
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function resample(daily, tf) {
  if (tf === "D") return daily.slice();
  const key = tf === "W" ? isoWeekKey : (t) => t.slice(0, 7);
  const groups = [];
  const idx = {};
  for (const c of daily) {
    const k = key(c.t);
    let g = idx[k];
    if (!g) { g = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: 0 }; idx[k] = g; groups.push(g); }
    else { g.t = c.t; }
    g.h = Math.max(g.h, c.h);
    g.l = Math.min(g.l, c.l);
    g.c = c.c;
    g.v += c.v;
    if (c.live) g.live = true;
  }
  return groups;
}

// ---------------------------------------------------------------- token discovery (data-driven, no hardcoded list)
async function discoverTokens() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/data`);
    if (!res.ok) throw new Error("contents api " + res.status);
    const files = await res.json();
    const names = files
      .filter((f) => f.type === "file" && /\.json$/i.test(f.name))
      .map((f) => f.name.replace(/\.json$/i, ""))
      .filter((n) => !["SNAPSHOT", "LIVE_MAP"].includes(n.toUpperCase()))
      .sort();
    if (names.length) return names;
    throw new Error("no token files found");
  } catch (e) {
    console.warn("Token scan failed, using fallback:", e.message);
    return FALLBACK_TOKENS.slice();
  }
}

async function loadToken(name) {
  if (state.cache[name]) return state.cache[name];
  const res = await fetch(`data/${name}.json`);
  if (!res.ok) throw new Error(`data/${name}.json -> ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error(`${name}: empty/invalid data`);
  state.cache[name] = data;
  return data;
}

async function loadLiveMap() {
  try {
    const res = await fetch("data/live_map.json");
    if (res.ok) state.liveMap = await res.json();
  } catch (e) { state.liveMap = {}; }
}

// daily candles + (optional) live forming candle -> display series
function refreshSeries(keepView = true) {
  const all = state.forming ? state.daily.concat([state.forming]) : state.daily.slice();
  const prevEnd = state.view.end, prevCount = state.view.count, prevLen = state.series.length;
  state.series = resample(all, state.tf);
  if (!keepView || !prevLen) {
    state.view.end = state.series.length;
    state.view.count = clamp(Math.min(90, state.series.length), 10, state.series.length);
  } else {
    // keep the user pinned to the right edge if they were there
    if (prevEnd >= prevLen) state.view.end = state.series.length;
    state.view.count = clamp(prevCount, 5, state.series.length);
  }
  state.hover = null;
}

function closedSeries() {
  // Signals fire on CLOSED candles only — the live forming candle is excluded.
  return state.series.filter((c) => !c.live);
}

// ---------------------------------------------------------------- strategy toolkit
// Position semantics mirror backtest.py (targets[t] decided on close[t]).
// Markers are derived from 0->1 (BUY) and 1->0 (SELL) transitions, plotted at
// candle t / price close[t] — the exact candle and price where the signal fired.
const STRATEGIES = {
  rsi: {
    name: "RSI",
    defaults: { period: 14, buy_level: 30, sell_level: 60 },
    desc: "Buy when RSI <= buy level; exit when RSI >= sell level (backtest.py strat_rsi).",
    positions(cl, hi, lo, p) {
      const pos = new Array(cl.length).fill(0);
      let cur = 0;
      for (let i = 0; i < cl.length; i++) {
        const r = rsiWilderAt(cl, p.period, i);
        if (r == null) continue;
        if (r <= p.buy_level) cur = 1;
        else if (r >= p.sell_level) cur = 0;
        pos[i] = cur;
      }
      return pos;
    },
  },
  bollinger: {
    name: "Bollinger",
    defaults: { period: 20, mult: 2 },
    desc: "Buy when close < lower band; exit when close > middle (backtest.py strat_bollinger).",
    positions(cl, hi, lo, p) {
      const pos = new Array(cl.length).fill(0);
      let cur = 0;
      for (let i = 0; i < cl.length; i++) {
        const m = smaAt(cl, p.period, i), s = stdevAt(cl, p.period, i);
        if (m == null) continue;
        if (cl[i] < m - p.mult * s) cur = 1;
        else if (cl[i] > m) cur = 0;
        pos[i] = cur;
      }
      return pos;
    },
  },
  ma_cross: {
    name: "MA cross",
    defaults: { fast: 20, slow: 50 },
    desc: "Long when fast MA > slow MA; flat on cross down (backtest.py strat_sma2050).",
    positions(cl, hi, lo, p) {
      const pos = new Array(cl.length).fill(0);
      for (let i = 0; i < cl.length; i++) {
        const f = smaAt(cl, p.fast, i), s = smaAt(cl, p.slow, i);
        pos[i] = f != null && s != null && f > s ? 1 : 0;
      }
      return pos;
    },
  },
  donchian: {
    name: "Donchian",
    defaults: { entry: 20, exit: 10 },
    desc: "Buy on entry-bar high breakout; exit on exit-bar low breakdown (backtest.py strat_donchian).",
    positions(cl, hi, lo, p) {
      const pos = new Array(cl.length).fill(0);
      let cur = 0;
      for (let i = 0; i < cl.length; i++) {
        if (i < p.entry) continue;
        let mx = -Infinity; for (let j = i - p.entry; j < i; j++) mx = Math.max(mx, hi[j]);
        let mn = Infinity; for (let j = i - p.exit; j < i; j++) mn = Math.min(mn, lo[j]);
        if (cl[i] > mx) cur = 1;
        else if (cl[i] < mn) cur = 0;
        pos[i] = cur;
      }
      return pos;
    },
  },
  macd: {
    name: "MACD",
    defaults: { fast: 12, slow: 26, signal: 9 },
    desc: "Long when MACD line > signal line; flat on cross down (standard definition).",
    positions(cl, hi, lo, p) {
      const { line, signal } = macdArrs(cl, p.fast, p.slow, p.signal);
      return line.map((v, i) => (v != null && signal[i] != null && v > signal[i] ? 1 : 0));
    },
  },
};

function computeSignals() {
  state.signals = [];
  const def = STRATEGIES[state.strategy.id];
  if (!def) return;
  const s = closedSeries();
  if (s.length < 2) return;
  const cl = s.map((c) => c.c), hi = s.map((c) => c.h), lo = s.map((c) => c.l);
  const p = Object.assign({}, def.defaults, state.strategy.params || {});
  const pos = def.positions(cl, hi, lo, p);
  // map closed-series index -> display-series index
  let di = 0;
  const mapIdx = [];
  for (let k = 0; k < state.series.length; k++) if (!state.series[k].live) mapIdx.push(k);
  for (let i = 1; i < pos.length; i++) {
    if (pos[i] === 1 && pos[i - 1] === 0)
      state.signals.push({ idx: mapIdx[i], side: "buy", t: s[i].t, price: s[i].c });
    else if (pos[i] === 0 && pos[i - 1] === 1)
      state.signals.push({ idx: mapIdx[i], side: "sell", t: s[i].t, price: s[i].c });
  }
}

async function loadActiveStrategy() {
  try {
    const res = await fetch("results/active_strategy.json");
    if (!res.ok) throw new Error("missing");
    const a = await res.json();
    if (a && STRATEGIES[a.strategy_id]) {
      state.strategy = {
        id: a.strategy_id,
        params: Object.assign({}, STRATEGIES[a.strategy_id].defaults, a.params || {}),
        source: a.source === "tournament-winner" ? "tournament-winner" : "toolkit",
      };
      return;
    }
  } catch (e) { /* fall through to default */ }
  state.strategy = { id: "rsi", params: Object.assign({}, STRATEGIES.rsi.defaults), source: "toolkit" };
}

function unprovenLabel() {
  return state.strategy.source === "toolkit"
    ? `<span class="unproven-label">UNPROVEN — backtest only, not a recommendation</span>`
    : `<span class="backtest-label">BACKTEST — not live results, not a guarantee</span>`;
}

function renderStrategyUI() {
  const sel = $("strat-select");
  sel.innerHTML = Object.keys(STRATEGIES).map((id) =>
    `<option value="${id}"${id === state.strategy.id ? " selected" : ""}>${esc(STRATEGIES[id].name)}</option>`).join("");
  renderParams();
  $("strat-desc").textContent = STRATEGIES[state.strategy.id].desc;
  $("strat-source-note").innerHTML = state.strategy.source === "tournament-winner"
    ? `Source: <b>tournament winner</b> (results/active_strategy.json)`
    : `Source: <b>toolkit</b> (no tournament winner — results/active_strategy.json)`;
  $("signals-head-label").innerHTML = unprovenLabel();
}

function renderParams() {
  const def = STRATEGIES[state.strategy.id];
  const p = Object.assign({}, def.defaults, state.strategy.params || {});
  $("strat-params").innerHTML = Object.keys(def.defaults).map((k) =>
    `<label>${esc(k)} <input type="number" data-param="${esc(k)}" value="${esc(p[k])}" step="any"></label>`).join("");
  $("strat-params").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) return;
      state.strategy.params[inp.dataset.param] = v;
      computeSignals(); drawChart(); renderMarkers();
    });
  });
}

function renderMarkers() {
  const box = $("marker-list");
  const sigs = state.signals;
  $("marker-count").textContent = sigs.length ? `${sigs.length} signals on closed candles` : "No signals on closed candles";
  if (!sigs.length) { box.innerHTML = `<div class="marker-row none">—</div>`; return; }
  box.innerHTML = sigs.slice().reverse().map((m) =>
    `<div class="marker-row"><span class="mdate">${esc(m.t)}</span>` +
    `<span class="mside ${m.side}">${m.side === "buy" ? "▲ BUY" : "▼ SELL"}</span>` +
    `<span class="mprice">${fmt(m.price, priceDecimals(m.price))}</span></div>`).join("");
}

// ---------------------------------------------------------------- chart rendering
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const AXIS_W = 62, DATE_H = 20;

function visibleRange() {
  const n = state.series.length;
  const count = clamp(state.view.count, 5, n);
  const end = clamp(state.view.end, count, n);
  return { start: end - count, end, count };
}

function drawChart() {
  const { ctx, w, h } = setupCanvas($("chart"));
  const css = getComputedStyle(document.documentElement);
  const up = css.getPropertyValue("--up").trim() || "#26a69a";
  const down = css.getPropertyValue("--down").trim() || "#ef5350";
  const dim = css.getPropertyValue("--dim").trim() || "#8b949e";
  const accent = css.getPropertyValue("--accent").trim() || "#58a6ff";

  ctx.clearRect(0, 0, w, h);
  const s = state.series;
  if (!s.length) return;

  const { start, end, count } = visibleRange();
  const vis = s.slice(start, end);
  const plotW = w - AXIS_W, plotH = h - DATE_H;
  const cl = s.map((c) => c.c);

  let hi = -Infinity, lo = Infinity, vmax = 0;
  for (const c of vis) { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); vmax = Math.max(vmax, c.v); }
  const ma20 = state.show.ma ? smaArr(cl, 20) : null;
  const ma50 = state.show.ma ? smaArr(cl, 50) : null;
  const ema12 = state.show.ema ? emaArr(cl, 12) : null;
  const ema26 = state.show.ema ? emaArr(cl, 26) : null;
  const bb = state.show.bb ? bollingerArrs(cl, 20, 2) : null;
  for (const arr of [ma20, ma50, ema12, ema26]) {
    if (!arr) continue;
    for (let i = start; i < end; i++) {
      const v = arr[i];
      if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
  }
  if (bb) for (let i = start; i < end; i++) {
    if (bb.upper[i] != null) { hi = Math.max(hi, bb.upper[i]); lo = Math.min(lo, bb.lower[i]); }
  }
  const pad = (hi - lo) * 0.08 || 1;
  hi += pad; lo -= pad;

  const volH = plotH * 0.22;
  const priceH = plotH - volH;
  const x = (i) => (i - start + 0.5) * (plotW / count);
  const y = (p) => priceH - ((p - lo) / (hi - lo)) * priceH;
  const bw = Math.max(1, (plotW / count) * 0.62);
  const dec = priceDecimals(hi);

  // volume bars
  for (let i = start; i < end; i++) {
    const c = s[i];
    ctx.fillStyle = c.c >= c.o ? up + "55" : down + "55";
    const vh = vmax ? (c.v / vmax) * volH : 0;
    ctx.fillRect(x(i) - bw / 2, plotH - vh, bw, vh);
  }

  // bollinger band fill
  if (bb) {
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      if (bb.upper[i] == null) continue;
      const px = x(i), py = y(bb.upper[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    for (let i = end - 1; i >= start; i--) {
      if (bb.lower[i] == null) continue;
      ctx.lineTo(x(i), y(bb.lower[i]));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(88,166,255,0.08)";
    ctx.fill();
  }

  // candles (live forming candle gets an accent outline)
  for (let i = start; i < end; i++) {
    const c = s[i];
    const col = c.c >= c.o ? up : down;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    const px = x(i);
    ctx.beginPath(); ctx.moveTo(px, y(c.h)); ctx.lineTo(px, y(c.l)); ctx.stroke();
    const yo = y(c.o), yc = y(c.c);
    const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(px - bw / 2, top, bw, bh);
    if (c.live) {
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
      ctx.strokeRect(px - bw / 2 - 1, y(c.h) - 1, bw + 2, y(c.l) - y(c.h) + 2);
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = accent; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("LIVE", px, y(c.h) - 5);
    }
  }

  // buy/sell markers (closed candles only — signals never include the live candle)
  ctx.textAlign = "center"; ctx.font = "bold 13px sans-serif";
  for (const m of state.signals) {
    if (m.idx < start || m.idx >= end) continue;
    const px = x(m.idx);
    if (m.side === "buy") {
      ctx.fillStyle = up;
      ctx.fillText("▲", px, y(s[m.idx].l) + 14);
    } else {
      ctx.fillStyle = down;
      ctx.fillText("▼", px, y(s[m.idx].h) - 6);
    }
  }

  // overlays
  const line = (arr, color, width = 1.5) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    let started = false;
    for (let i = start; i < end; i++) {
      const v = arr[i];
      if (v == null) continue;
      const px = x(i), py = y(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.lineWidth = 1;
  };
  if (bb) { line(bb.upper, "rgba(88,166,255,0.7)"); line(bb.mid, "rgba(88,166,255,0.4)"); line(bb.lower, "rgba(88,166,255,0.7)"); }
  if (ma20) { line(ma20, "#f0b429"); line(ma50, "#ab47bc"); }
  if (ema12) { line(ema12, "#29b6f6"); line(ema26, "#66bb6a"); }

  // price axis
  ctx.fillStyle = dim; ctx.font = "10px monospace"; ctx.textAlign = "left";
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4;
    const py = y(p);
    ctx.fillText(fmt(p, dec), plotW + 5, py + 3);
    ctx.strokeStyle = "rgba(139,148,158,0.12)";
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
  }

  // date axis
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(count / 6));
  for (let i = start; i < end; i += step) {
    ctx.fillText(shortDate(s[i].t) + (s[i].live ? " •" : ""), x(i), h - 6);
  }

  // crosshair
  if (state.hover != null && state.hover >= start && state.hover < end) {
    const i = state.hover, c = s[i];
    const px = x(i), py = y(c.c);
    ctx.strokeStyle = "rgba(230,237,243,0.5)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, plotH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = accent;
    ctx.fillRect(plotW, py - 9, AXIS_W, 18);
    ctx.fillStyle = "#0d1117"; ctx.textAlign = "left";
    ctx.fillText(fmt(c.c, dec), plotW + 5, py + 3);
    updateReadout(c);
  } else {
    updateReadout(null);
  }

  const last = s[s.length - 1];
  $("price-label").textContent = `${state.token} ${state.tf === "D" ? "daily" : state.tf === "W" ? "weekly" : "monthly"} close: ${fmt(last.c, priceDecimals(last.c))}${last.live ? " (LIVE)" : ""}`;

  drawRsi(plotW, count, start, end);
}

function drawRsi(plotW, count, start, end) {
  const cv = $("rsi-chart");
  if (!state.show.rsi) { cv.style.display = "none"; return; }
  cv.style.display = "block";
  const { ctx, w, h } = setupCanvas(cv);
  const css = getComputedStyle(document.documentElement);
  const dim = css.getPropertyValue("--dim").trim() || "#8b949e";
  ctx.clearRect(0, 0, w, h);
  const s = state.series;
  const rsi = rsiWilderArr(s.map((c) => c.c), 14);
  const plotH = h - DATE_H;
  const y = (v) => plotH - (v / 100) * plotH;
  const x = (i) => (i - start + 0.5) * (plotW / count);

  ctx.strokeStyle = "rgba(239,83,80,0.4)";
  ctx.beginPath(); ctx.moveTo(0, y(70)); ctx.lineTo(plotW, y(70)); ctx.stroke();
  ctx.strokeStyle = "rgba(38,166,154,0.4)";
  ctx.beginPath(); ctx.moveTo(0, y(30)); ctx.lineTo(plotW, y(30)); ctx.stroke();

  ctx.beginPath(); ctx.strokeStyle = "#ab47bc"; ctx.lineWidth = 1.5;
  let started = false;
  for (let i = start; i < end; i++) {
    const v = rsi[i];
    if (v == null) continue;
    const px = x(i), py = y(v);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke(); ctx.lineWidth = 1;

  ctx.fillStyle = dim; ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText("RSI 70", plotW + 5, y(70) + 3);
  ctx.fillText("RSI 30", plotW + 5, y(30) + 3);
}

function updateReadout(c) {
  const el = $("ohlc-readout");
  if (!c) {
    const last = state.series[state.series.length - 1];
    if (!last) { el.innerHTML = "O — H — L — C —"; return; }
    c = last;
  }
  const col = c.c >= c.o ? "var(--up)" : "var(--down)";
  const d = priceDecimals(c.c);
  el.innerHTML = `<b>${c.t}${c.live ? " (LIVE forming)" : ""}</b> &nbsp;O <b>${fmt(c.o, d)}</b> H <b>${fmt(c.h, d)}</b> L <b>${fmt(c.l, d)}</b> ` +
    `C <b style="color:${col}">${fmt(c.c, d)}</b> V <b>${Number(c.v).toLocaleString()}</b>`;
}

// ---------------------------------------------------------------- interaction (drag pan, wheel/pinch zoom, crosshair)
function bindChart() {
  const wrap = $("chart-wrap");
  let dragging = false, lastX = 0, moved = 0;
  let pinchD0 = 0, pinchCount0 = 0;

  const posToIndex = (clientX) => {
    const rect = $("chart").getBoundingClientRect();
    const plotW = rect.width - AXIS_W;
    const { start, count } = visibleRange();
    const rel = clamp((clientX - rect.left) / plotW, 0, 0.9999);
    return start + Math.floor(rel * count);
  };

  wrap.addEventListener("pointerdown", (e) => {
    dragging = true; moved = 0; lastX = e.clientX;
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      moved += Math.abs(dx);
      if (moved > 6) state.hover = null;
      const rect = $("chart").getBoundingClientRect();
      const barsPerPx = visibleRange().count / (rect.width - AXIS_W);
      state.view.end = clamp(Math.round(state.view.end - dx * barsPerPx), 1, state.series.length);
      lastX = e.clientX;
      drawChart();
    } else if (e.pointerType === "mouse") {
      state.hover = posToIndex(e.clientX);
      drawChart();
    }
  });
  const endDrag = () => { dragging = false; };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);

  wrap.addEventListener("click", (e) => {
    if (moved <= 6) {
      state.hover = posToIndex(e.clientX);
      drawChart();
    }
  });

  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  wrap.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      pinchD0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      pinchCount0 = state.view.count;
    }
  }, { passive: true });
  wrap.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (pinchD0 > 0) state.view.count = clamp(Math.round(pinchCount0 * (pinchD0 / d)), 5, state.series.length);
      drawChart();
    } else if (e.touches.length === 1 && !dragging) {
      state.hover = posToIndex(e.touches[0].clientX);
      drawChart();
    }
  }, { passive: false });

  window.addEventListener("resize", () => drawChart());
}

function zoom(factor) {
  state.view.count = clamp(Math.round(state.view.count * factor), 5, state.series.length);
  state.view.end = clamp(state.view.end, state.view.count, state.series.length);
  drawChart();
}

// ---------------------------------------------------------------- live feed (XRPL WebSocket)
const feed = {
  ws: null, epIdx: 0, backoff: 2000, timer: null, lastMsg: 0, lastDraw: 0,
};

function feedBadge() {
  const el = $("live-badge");
  const f = state.feed;
  el.className = "live-badge " + f.status;
  const dot = f.status === "live" ? "●" : f.status === "reconnecting" ? "◐" : "○";
  let txt;
  if (f.status === "live") {
    txt = `${dot} LIVE · ${esc(f.endpoint)} · ledger ${f.ledger ?? "—"} · ~3–5s delay` +
      (f.price != null ? ` · ${fmt(f.price, priceDecimals(f.price))} XRP` : "");
  } else if (f.status === "reconnecting") {
    txt = `${dot} RECONNECTING… · ${esc(f.endpoint || "—")} · last update ${ago(f.lastUpdate)} · prices frozen`;
  } else {
    txt = `${dot} OFFLINE · ${esc(f.note)} · prices frozen`;
  }
  el.innerHTML = txt;
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

function stopFeed() {
  if (feed.timer) { clearTimeout(feed.timer); feed.timer = null; }
  if (feed.ws) { try { feed.ws.close(); } catch (e) {} feed.ws = null; }
}

function startFeed() {
  stopFeed();
  state.forming = null;
  const map = state.liveMap[state.token];
  if (!map || !map.currency || !map.issuer) {
    state.feed = { status: "offline", endpoint: null, ledger: null, price: null, lastUpdate: 0, note: `no live mapping for ${state.token}` };
    feedBadge();
    refreshSeries(false); computeSignals(); drawChart(); renderMarkers();
    return;
  }
  feed.epIdx = 0; feed.backoff = 2000;
  connectFeed();
}

function connectFeed() {
  const map = state.liveMap[state.token];
  const url = WS_ENDPOINTS[feed.epIdx % WS_ENDPOINTS.length];
  const host = url.replace("wss://", "");
  state.feed = { status: "reconnecting", endpoint: host, ledger: state.feed.ledger, price: state.feed.price, lastUpdate: state.feed.lastUpdate, note: "connecting" };
  feedBadge();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) { scheduleReconnect(); return; }
  feed.ws = ws;
  feed.lastMsg = Date.now();

  ws.onopen = () => {
    feed.backoff = 2000;
    ws.send(JSON.stringify({ id: 1, command: "subscribe", streams: ["ledger"] }));
    ws.send(JSON.stringify({
      id: 2, command: "subscribe",
      books: [{
        taker_pays: { currency: "XRP" },
        taker_gets: { currency: map.currency, issuer: map.issuer },
        snapshot: true, both: true,
      }],
    }));
  };
  ws.onmessage = (ev) => {
    feed.lastMsg = Date.now();
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "ledgerClosed") {
      state.feed.ledger = m.ledger_index;
      if (state.feed.status !== "live") state.feed.status = "live";
      maybeRolloverDay();
      feedBadge();
    } else if (Array.isArray(m.asks) || Array.isArray(m.bids)) {
      const px = bookMidPrice(m);
      if (px != null) onLivePrice(px);
    }
  };
  const dead = () => scheduleReconnect();
  ws.onclose = dead;
  ws.onerror = () => { try { ws.close(); } catch (e) {} };

  // heartbeat: no message for 25s -> reconnect
  const beat = setInterval(() => {
    if (feed.ws !== ws) { clearInterval(beat); return; }
    if (Date.now() - feed.lastMsg > 25000) { clearInterval(beat); try { ws.close(); } catch (e) {} scheduleReconnect(); }
  }, 5000);
}

function scheduleReconnect() {
  stopFeed();
  if (state.feed.status === "live" || state.feed.lastUpdate) {
    state.feed.status = "reconnecting";
    state.feed.note = "connection lost";
  }
  feedBadge();
  feed.epIdx++;
  feed.timer = setTimeout(connectFeed, feed.backoff);
  feed.backoff = Math.min(feed.backoff * 2, 30000);
}

// mid price (XRP per token) from a book snapshot/update for the token/XRP book
function bookMidPrice(m) {
  const px = (o, isAsk) => {
    try {
      if (isAsk) {
        // ask: TakerPays=token (value), TakerGets=XRP (drops)
        const tok = parseFloat(o.TakerPays.value), xrp = parseFloat(o.TakerGets) / DROPS_PER_XRP;
        return tok > 0 ? xrp / tok : null;
      }
      // bid: TakerPays=XRP (drops), TakerGets=token (value)
      const xrp = parseFloat(o.TakerPays) / DROPS_PER_XRP, tok = parseFloat(o.TakerGets.value);
      return tok > 0 ? xrp / tok : null;
    } catch (e) { return null; }
  };
  let bestAsk = null, bestBid = null;
  for (const o of m.asks || []) { const p = px(o, true); if (p != null && (bestAsk == null || p < bestAsk)) bestAsk = p; }
  for (const o of m.bids || []) { const p = px(o, false); if (p != null && (bestBid == null || p > bestBid)) bestBid = p; }
  if (bestAsk != null && bestBid != null) return (bestAsk + bestBid) / 2;
  return bestAsk != null ? bestAsk : bestBid;
}

function onLivePrice(px) {
  const f = state.feed;
  f.price = px; f.lastUpdate = Date.now();
  if (f.status !== "live") f.status = "live";
  const today = utcToday();
  if (!state.forming || state.forming.t !== today) {
    // finalize yesterday's forming candle as a closed candle (day rolled over)
    if (state.forming) {
      state.daily.push(Object.assign({}, state.forming, { live: false }));
      state.cache[state.token] = state.daily;
    }
    const prevClose = state.daily.length ? state.daily[state.daily.length - 1].c : px;
    state.forming = { t: today, o: prevClose, h: Math.max(prevClose, px), l: Math.min(prevClose, px), c: px, v: 0, live: true };
    computeSignals(); // new closed candle -> signals may fire
  } else {
    state.forming.c = px;
    state.forming.h = Math.max(state.forming.h, px);
    state.forming.l = Math.min(state.forming.l, px);
  }
  refreshSeries(true);
  renderMarkers();
  // throttle redraws: book updates can stream fast
  const now = Date.now();
  if (now - feed.lastDraw > 1500) { feed.lastDraw = now; drawChart(); }
  feedBadge();
}

function maybeRolloverDay() {
  // ledger closed: check the forming candle still belongs to today (UTC)
  const today = utcToday();
  if (state.forming && state.forming.t !== today && state.feed.price != null) {
    onLivePrice(state.feed.price); // finalizes + starts a fresh forming candle
  }
}

// ---------------------------------------------------------------- tournament strategy panel (results/winner.json)
async function loadStrategy() {
  const body = $("strategy-body");
  try {
    const res = await fetch("results/winner.json");
    if (!res.ok) throw new Error("missing");
    const w = await res.json();
    if (w && w.passed_bar === true) {
      const s = w.test_stats || {};
      body.innerHTML = `
        <p><b>Winner: ${esc(w.winner_name)}</b> <span class="token-tag">${esc(w.token || "")}</span></p>
        <div class="rules">${esc(w.rules_text || "")}</div>
        <div class="stat-grid">
          <div class="stat"><div class="k">Test return</div><div class="v">${pct(s.total_return_pct)}</div></div>
          <div class="stat"><div class="k">Buy &amp; hold</div><div class="v">${pct(s.buyhold_return_pct)}</div></div>
          <div class="stat"><div class="k">Max drawdown</div><div class="v">${pct(s.max_drawdown_pct)}</div></div>
          <div class="stat"><div class="k">Round trips</div><div class="v">${s.round_trips ?? "—"}</div></div>
          <div class="stat"><div class="k">Sharpe</div><div class="v">${s.sharpe != null ? Number(s.sharpe).toFixed(2) : "—"}</div></div>
        </div>
        ${w.note ? `<p class="honest">${esc(w.note)}</p>` : ""}
        <span class="backtest-label">BACKTEST — not live results, not a guarantee</span>`;
    } else {
      honestEmpty(body);
    }
  } catch (e) {
    honestEmpty(body);
  }
}

function honestEmpty(body) {
  body.innerHTML = `<p class="honest"><b>No strategy passed the pre-registered bar.</b><br>
    Toolkit included for research; paper-trade at your own risk.<br>
    <span class="backtest-label">BACKTEST — not live results, not a guarantee</span></p>`;
}

// ---------------------------------------------------------------- paper trading (FAKE money, client-side only)
function paperKey() { return `xrplab-paper-${state.token}`; }

function loadPaper() {
  try {
    const raw = localStorage.getItem(paperKey());
    if (raw) { state.paper = JSON.parse(raw); return; }
  } catch (e) { /* ignore */ }
  state.paper = { cash: PAPER_START, qty: 0, trades: [] };
}

function savePaper() {
  try { localStorage.setItem(paperKey(), JSON.stringify(state.paper)); } catch (e) { /* ignore */ }
}

function lastPrice() {
  const s = state.series;
  return s.length ? s[s.length - 1].c : 0;
}

function renderPaper() {
  const p = state.paper, px = lastPrice();
  const equity = p.cash + p.qty * px;
  const pnl = equity - PAPER_START;
  const cls = pnl >= 0 ? "pos" : "neg";
  $("paper-stats").innerHTML =
    `Cash: $${p.cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}<br>` +
    `Holdings: ${p.qty} ${esc(state.token)} @ ${fmt(px, priceDecimals(px))}${state.forming ? " (LIVE)" : ""}<br>` +
    `Equity: <b>$${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b> ` +
    `<span class="${cls}">(${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })})</span>`;
  const box = $("paper-trades");
  if (!p.trades.length) { box.innerHTML = `<div class="trade">No trades yet — fake money only.</div>`; return; }
  box.innerHTML = p.trades.slice(-20).reverse().map((t) =>
    `<div class="trade"><span class="${t.side}">${t.side.toUpperCase()} ${t.qty} @ ${fmt(t.price, priceDecimals(t.price))}</span><span>${t.date}</span></div>`
  ).join("");
}

function trade(side) {
  const qty = parseFloat($("trade-qty").value);
  if (!qty || qty <= 0) return;
  const px = lastPrice();
  const p = state.paper;
  const date = state.series[state.series.length - 1].t + (state.forming ? " (live)" : "");
  if (side === "buy") {
    const cost = qty * px;
    if (cost > p.cash + 1e-9) { alert("Not enough fake cash."); return; }
    p.cash -= cost; p.qty += qty;
  } else {
    if (qty > p.qty + 1e-9) { alert("Not enough fake holdings."); return; }
    p.cash += qty * px; p.qty -= qty;
  }
  p.trades.push({ side, qty, price: px, date });
  savePaper(); renderPaper();
}

// ---------------------------------------------------------------- snapshot
async function loadSnapshot() {
  try {
    const res = await fetch("data/SNAPSHOT.json");
    if (!res.ok) throw new Error("missing");
    const s = await res.json();
    state.snapshot = s;
    $("snapshot-label").textContent = `Data snapshot: ${s.as_of || "—"} · source: ${s.source || "—"}`;
  } catch (e) {
    $("snapshot-label").textContent = "Data snapshot: unavailable";
  }
}

// ---------------------------------------------------------------- boot
async function selectToken(name) {
  stopFeed();
  state.token = name;
  $("token-select").value = name;
  state.daily = await loadToken(name);
  state.forming = null;
  state.feed = { status: "offline", endpoint: null, ledger: null, price: null, lastUpdate: 0, note: "not connected" };
  refreshSeries(false);
  computeSignals();
  loadPaper();
  drawChart();
  renderPaper();
  renderMarkers();
  startFeed();
}

async function boot() {
  const tokens = await discoverTokens();
  state.tokens = tokens;
  const sel = $("token-select");
  sel.innerHTML = tokens.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  sel.addEventListener("change", () => selectToken(sel.value).catch((e) => alert(e.message)));

  document.querySelectorAll(".tf-group button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tf-group button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.tf = b.dataset.tf;
      refreshSeries(false);
      computeSignals();
      drawChart();
      renderMarkers();
      renderPaper();
    });
  });

  $("ov-ma").addEventListener("change", (e) => { state.show.ma = e.target.checked; drawChart(); });
  $("ov-ema").addEventListener("change", (e) => { state.show.ema = e.target.checked; drawChart(); });
  $("ov-bb").addEventListener("change", (e) => { state.show.bb = e.target.checked; drawChart(); });
  $("ov-rsi").addEventListener("change", (e) => { state.show.rsi = e.target.checked; drawChart(); });

  $("strat-select").addEventListener("change", (e) => {
    state.strategy.id = e.target.value;
    state.strategy.params = Object.assign({}, STRATEGIES[state.strategy.id].defaults);
    renderStrategyUI();
    computeSignals(); drawChart(); renderMarkers();
  });

  $("btn-buy").addEventListener("click", () => trade("buy"));
  $("btn-sell").addEventListener("click", () => trade("sell"));
  $("btn-reset").addEventListener("click", () => {
    if (confirm("Reset fake portfolio to $10,000?")) {
      state.paper = { cash: PAPER_START, qty: 0, trades: [] };
      savePaper(); renderPaper();
    }
  });

  bindChart();
  loadSnapshot();
  loadStrategy();
  await loadLiveMap();
  await loadActiveStrategy();
  renderStrategyUI();
  await selectToken(tokens[0]);
}

document.addEventListener("DOMContentLoaded", boot);

// Node test hook: expose pure functions for verification (no-op in browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    smaAt, smaArr, stdevAt, rsiWilderAt, rsiWilderArr, emaArr, bollingerArrs,
    macdArrs, stochArrs, donchianArrs, atrArr,
    resample, isoWeekKey, fmt, bookMidPrice, STRATEGIES, priceDecimals,
    updateReadout, state,
  };
}
