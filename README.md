# XRPL Strategy Lab

TradingView-style charting lab for XRPL-native tokens, with indicator overlays,
a 100-agent strategy tournament panel, and **paper trading with FAKE money only**.

**Disclaimer:** This is a research and visualization tool. All trading is simulated
with fake money (client-side only, stored in your browser's localStorage). Backtest
results are labeled as backtests — they are not live results and not a guarantee.
Nothing here is financial advice.

Live site: https://honeybbear.github.io/xrpl-strategy-lab/

## Features

- **Candlestick chart** (canvas): volume bars, drag-to-pan, scroll/pinch-to-zoom,
  crosshair with OHLC readout
- **Overlays** (toggleable): MA(20/50), EMA(12/26), Bollinger(20,2)
- **RSI(14) sub-pane** (toggleable)
- **Token switcher**: populated automatically by scanning `data/*.json` at load
  time — no hardcoded token list
- **Timeframes**: Daily / Weekly / Monthly (resampled client-side from daily)
- **Live price feed**: public XRPL WebSocket (xrplcluster.com → s1/s2.ripple.com
  failover) — ledger stream + token/XRP order-book subscription; the
  in-progress candle updates as ledgers close (~3–5s). Persistent feed badge
  (source · LIVE/RECONNECTING/OFFLINE · delay note) visible at the top without
  scrolling. If the socket drops, the last candle freezes and the badge says so
  — stale prices are never shown as live
- **Indicator engine**: sma, Wilder RSI, stdev, Bollinger, EMA, MACD,
  Stochastic, Donchian, ATR — sma/rsi/stdev/signal math matches
  `~/workspace/xrp-backtest/backtest.py` exactly (see formula block in app.js)
- **Live signals**: strategy toolkit (RSI, Bollinger, MA-cross, Donchian, MACD)
  with adjustable params; ▲/▼ markers fire only on **closed** candles at the
  exact candle + close price, with a marker list (time, side, price). Toolkit
  signals carry the label "UNPROVEN — backtest only, not a recommendation"
- **Strategy panel**: reads `results/winner.json`; shows the winner's exact rules
  and test stats only if the pre-registered bar was passed, otherwise states
  honestly that nothing passed
- **Paper trading**: $10,000 fake starting balance, buy/sell at chart prices,
  equity tracking — FAKE MONEY banner always visible
- **Snapshot label**: "Data snapshot: \<date\>" read from `data/SNAPSHOT.json`

## Data contract

Each token file is `data/<TOKEN>.json`: a JSON array, oldest candle first, of

```json
{"t":"YYYY-MM-DD","o":2.10,"h":2.1044,"l":2.092,"c":2.0948,"v":46296503}
```

`t` = date, `o/h/l/c` = open/high/low/close, `v` = volume.

`data/SNAPSHOT.json`:

```json
{"as_of":"2026-10-07","source":"sample"}
```

`results/winner.json` (written by the strategy tournament, Phase 4):
```json
{
  "passed_bar": true,
  "winner_name": "Agent-042 ...",
  "token": "XRP",
  "rules_text": "exact entry/exit rules...",
  "test_stats": {"total_return_pct": 12.3, "buyhold_return_pct": 8.1,
                 "max_drawdown_pct": -5.2, "round_trips": 34, "sharpe": 1.4},
  "note": "..."
}
```

## Live feed wiring

`data/live_map.json` maps tokens to their XRPL order book (optional — tokens
without an entry simply show OFFLINE):

```json
{"DROP": {"currency": "DROP", "issuer": "r...issuer...", "quote": "XRP"}}
```

`currency` is the on-ledger code (3-char or 40-char hex), `issuer` the issuing
account. The app subscribes to the token/XRP book and uses the order-book mid
price (best ask + best bid ÷ 2) for the forming candle. Note: live quotes are
in XRP; if a token's historical file uses different units, the live candle is
labeled LIVE so the seam is visible.

WebSocket check (2026-10-07): raw `wss://` was blocked by this sandbox's
egress proxy, but browser WebSocket connections are not subject to CORS and
public rippled endpoints (xrplcluster.com, s1/s2.ripple.com) accept them —
this is the standard pattern used by browser XRPL apps, so the socket is
primary with endpoint failover + auto-reconnect. xMagnetic was checked the
same day: it exposes no public quote API (site-internal endpoints only), so
there is no xMagnetic polling fallback — if the socket fails the badge goes
OFFLINE and freezes honestly.

## Active strategy spec

`results/active_strategy.json`:

```json
{"strategy_id": "rsi", "params": {"period": 14, "buy_level": 30, "sell_level": 60}, "source": "toolkit"}
```

`strategy_id` is one of `rsi | bollinger | ma_cross | donchian | macd`;
`source` is `"toolkit"` (default, carries the UNPROVEN label) or
`"tournament-winner"` once a tournament winner passes the bar. The dropdown
in the UI lets the user switch strategies and tweak params live.

## How to add a token

1. Drop `data/<TOKEN>.json` into the repo (matching the contract above).
2. Update `data/SNAPSHOT.json` (`as_of` date + `source`).
3. (Optional) Add the token's XRPL order book to `data/live_map.json` to enable
   the live price feed for it.
4. Push. The token switcher picks it up automatically — no code changes.

No scheduled refresh workflow yet: data is committed manually until a free,
reliable daily source is confirmed (recon phase).

## Local dev

Any static server works, e.g. `python3 -m http.server` in this directory.
