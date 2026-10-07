# xrpl-strategy-lab — Phase 1 Data Recon Report

**Date:** 2026-10-07 · **Analyst:** Arlo (subagent) · **Universe:** XRPL-native tokens, ranked by market cap

## TL;DR

- **9 tokens USABLE** with ≥1yr daily history: XRP, PHNIX, ARMY, CTF, SOLO (100%/99.7% clean) + FUZZY, DROP, SLT, BEAR (89.6%, one documented 33-day vendor outage gap each).
- **3 big-tier tokens EXCLUDED**, each with explicit reason below.
- **xMagnetic yielded nothing programmatically usable** from this environment (details in §Sources). All series below are CoinGecko `market_chart` (daily close + volume).
- **OHLC limitation (read this):** CoinGecko's free `market_chart` provides **daily close + volume only** — no true open/high/low. In every `<TOKEN>.json`, `o`/`h`/`l` are set equal to `c` (the daily close). This is a disclosed convention, not measured intraday range. The free `/ohlc` endpoint returns 4-day candles (verified on XRP and DROP), so it cannot supply daily OHLC either. No free programmatic source found offers true daily OHLC for XRPL DEX tokens.

## Ranked candidate table

Ranked by CoinGecko "XRP Ledger Ecosystem" category market cap (36 tokens total, pulled 2026-10-07). Multi-chain fiat stablecoins in the category (USDC, EURCV, EUROP, XSGD, EURQ, AUDD, USDQ) are not XRPL-native price series and were not pulled.

| # | Token | CoinGecko id | CG mcap rank | MCap (USD) | 24h vol (USD) | Source | Coverage | Verdict |
|---|-------|--------------|--------------|-----------|---------------|--------|----------|---------|
| 1 | XRP | `ripple` | 5 | $89.70B | $2.45B | CoinGecko | 365/365 (100%) | **USABLE** |
| 2 | RLUSD | `ripple-usd` | 45 | $2.53B | $180.8M | CoinGecko | 365/365 (100%) | **EXCLUDED** — USD stablecoin; price flat by design ($0.9989–$1.0006 all year, max daily move 0.1%). No tradable volatility. |
| 3 | FUZZY | `fuzzybear` | 1050 | $14.38M | $26.7K | CoinGecko | 327/365 (89.6%) | **USABLE*** — 5d + 33d gaps (vendor outage, see §Gaps) |
| 4 | PHNIX | `phnix` | 1668 | $5.30M | $72.5K | CoinGecko | 365/365 (100%) | **USABLE** |
| 5 | ARMY | `army-3` | 1772 | $4.59M | $3.4K | CoinGecko | 365/365 (100%) | **USABLE** |
| 6 | CTF | `crypto-trading-fund` | 2206 | $2.53M | $194 | CoinGecko | 364/365 (99.7%) | **USABLE** — 1 missing day; ⚠️ dust-level liquidity (median $165/day) |
| 7 | DROP | `drop-2` | 2231 | $2.44M | $3.2K | CoinGecko | 327/365 (89.6%) | **USABLE*** — 5d + 33d gaps (vendor outage, see §Gaps) |
| 8 | SLT | `salute` | 2526 | $1.69M | $36 | CoinGecko | 327/365 (89.6%) | **USABLE*** — thin ($865/day median) + 33d gap |
| 9 | BEAR | `bearxrpl` | 2658 | $1.45M | $1.2K | CoinGecko | 327/365 (89.6%) | **USABLE*** — 5d + 33d gaps (vendor outage, see §Gaps) |
| 10 | SOLO | `solo-coin` | 2893 | $1.12M | $1.6K | CoinGecko | 365/365 (100%) | **USABLE** — ⚠️ single-day volume anomaly 2025-10-29, see §Quality |
| 11 | BXE | `banxchange` | 3027 | $0.98M | $15.1K | CoinGecko | 298/365 (81.6%) | **EXCLUDED** — 46d + 13d + 8d gaps; history starts 2025-11-23 |
| 12 | REAL | `real-token` | 3104 | $0.91M | $123.9K | CoinGecko | 278/365 (76.2%) | **EXCLUDED** — 79 days missing at series start (starts 2025-12-26) + 8d gap |

**Final usable universe (9):** XRP, PHNIX, ARMY, CTF, SOLO, FUZZY, DROP, SLT, BEAR.

## Per-token quality notes

**Gaps — one shared root cause.** FUZZY, DROP, SLT, BEAR (and partly BXE/REAL) share *identical* gap windows, which points to a CoinGecko-side XRPL data feed outage, not token illiquidity:
- `2025-11-02 → 2025-11-06` (5 days)
- `2026-03-19 → 2026-04-20` (33 days; BXE/REAL rejoined 2026-03-27)
- CTF: single missing day (not in the shared windows; date omitted from file).

Gaps are **not interpolated or bridged** — the missing dates are simply absent from the JSON (date sequence jumps visibly) and are listed here. No `g:true` bridge candles were written; the tournament engine should skip or handle the gap explicitly.

**Flatlines / wash-trading check.** Longest run of identical daily closes = 1 day on every token (no flatlines). Zero zero-volume days on every token. Max single-day moves look organic (XRP 20.5% on the Oct-2026 selloff; ARMY 227%; PHNIX 143%; CTF 455% on dust volume). No repeated round-number prints or other wash-trade signatures observed. Volume spike ratios (max/median): XRP 6.8x, PHNIX 2.8x, ARMY 27x, DROP 38.6x, BEAR 23.7x, FUZZY 10.4x — elevated but consistent with thin meme-coin tapes, not single-print manipulation.

**Anomalies flagged:**
- SOLO 2025-10-29: CoinGecko reports $587.8M volume (92,950x median) while price barely moved ($0.2471). Almost certainly a bad volume print, not real trading. Price series unaffected; treat SOLO volume on/around that date as unreliable.
- CTF/SLT: median daily volumes of $165 / $865 — real but dust-level; slippage would dominate any live strategy. Paper-tournament only.
- RLUSD excluded as above (stablecoin).

## Sources investigated

1. **xMagnetic (xmagnetic.org) — NOT programmatically usable (stated explicitly).** Token pages (e.g. `/tokens/SWIFT+<issuer>`) are JS-rendered; text fetch of the DROP token page returned HTTP 500 and could not be retried per tool policy. No public API, docs site, or CSV export found via web search (results only surfaced an unrelated "Magnetic" project-management tool). If the 1yr+ DROP/BEAR chart history visible in a real browser is needed, that requires a live-browser session or a reverse-engineered private API — flagged for the parent, not attempted here.
2. **XPMarket (xpmarket.com) — no public API.** Homepage is currently a "Coming Soon" teaser; no docs or endpoints found via search. Token pages exist (`/token/<name>-<issuer>`) but expose no pullable history without a browser.
3. **XRPL Meta API (s1.xrplmeta.org) — programmatic, but only ~9 months of history** (indexed range 2026-01-16 → 2026-10-07). Documented via its open-source repo (`ajkagy/xrplmeta`): `GET /token/{currency}:{issuer}/series/price?time_start=&time_end=&time_interval=86400`. Fails the ≥1yr bar; noted as a possible secondary/cross-check source.
4. **Sologenic / XRPL DEX scrapers — none found** with free historical OHLC. GeckoTerminal has no XRPL network. Ripple's Data API (data.ripple.com) is dead (auth-walled). Bitget publishes SOLO history but that's CEX data, not XRPL-native.
5. **CoinGecko free API — USED.** `market_chart?vs_currency=usd&days=365` → daily close + volume (+market cap, unused). `/ohlc?days=365` returns 4-day candles on the free tier (verified for both XRP and DROP), so it was not used.

## Rate-limit notes

CoinGecko free tier (~5–15 req/min observed tolerance): 6s sleep between calls, 14 calls total, zero 429s. If re-pulling, keep ≥5s spacing; the free `market_chart` window is `days=2..365` with daily granularity above 90 days.

## Files written (this phase)

All in `~/workspace/xrpl-strategy-lab/data/`, schema `[{"t":"YYYY-MM-DD","o":..,"h":..,"l":..,"c":..,"v":..}]`, oldest first, numbers only, UTC dates, `v` = CoinGecko 24h volume in USD. `o`/`h`/`l` = daily close (see OHLC limitation above). Gaps omitted, never interpolated.

- `XRP.json` — 365 candles, 2025-10-08 → 2026-10-07
- `PHNIX.json` — 365 candles, 2025-10-08 → 2026-10-07
- `ARMY.json` — 365 candles, 2025-10-08 → 2026-10-07
- `CTF.json` — 364 candles, 2025-10-08 → 2026-10-07 (1 day missing)
- `SOLO.json` — 365 candles, 2025-10-08 → 2026-10-07
- `FUZZY.json` — 327 candles, 2025-10-08 → 2026-10-07 (gaps 2025-11-02→06, 2026-03-19→04-20)
- `DROP.json` — 327 candles, 2025-10-08 → 2026-10-07 (same gaps)
- `SLT.json` — 327 candles, 2025-10-08 → 2026-10-07 (same gaps)
- `BEAR.json` — 327 candles, 2025-10-08 → 2026-10-07 (same gaps)

Pre-existing scaffold files (`SAMPLE.json`, `SNAPSHOT.json`, `live_map.json`) were left untouched. Git was not initialized, per instructions.
