#!/usr/bin/env python3
"""PHASE 2 — 100-agent strategy tournament for xrpl-strategy-lab.

FAKE money ($10,000 start per run), REAL data (CoinGecko daily, data/*.json).

================================================================================
CRITICAL DATA CAVEAT (honest, not a bug — documented here, in DATA_REPORT.md,
and in every indicator below):
  * data/*.json carry DAILY CLOSE + VOLUME ONLY. In every file, o = h = l = c.
  * Therefore every indicator below is CLOSE-BASED. Specifically:
      - Donchian "breakout": computed against max/min of prior CLOSES (there are
        no intraday highs/lows to break out of). Semantics: "close exceeds the
        highest close of the prior N days" — a close-based breakout proxy.
      - Bollinger bands: from closes only (population stdev of closes).
      - RSI/MACD/MA cross are natively close-based — unaffected.
      - ATR/Stochastic are not used at all (they need true range data).
  * Gaps are OMITTED days (never interpolated). The 33-day CoinGecko XRPL feed
    outage 2026-03-19 -> 2026-04-20 (FUZZY/DROP/SLT/BEAR) means: no candles, no
    trades possible in that window; indicator windows that span the gap simply
    use the closes on either side of it. Nothing is bridged or filled.
================================================================================

ENGINE: adapted from ~/workspace/xrp-backtest/backtest.py (proven patterns):
  * signals computed on candle close[t], executed at open[t+1]. Because o == c
    in this data, execution is effectively the NEXT DAY'S CLOSE. No lookahead.
  * long/flat only, no leverage, no shorting.
  * fee = 0.15%/side (0.0015) — wider than CEX because XRPL DEX spreads are wider.
  * $10,000 fake start, equity marked at daily close.

DESIGN: exactly 100 agents = 5 strategy families x 20 parameter variants.
  * Family/strategy_id strings and param names are IDENTICAL to the app's
    toolkit in app.js (STRATEGIES), so the winner plugs straight into
    results/active_strategy.json.
  * Each agent is a fixed (family, params, token) triple. Agent i (family-major
    order, 0..99) is assigned token TOKENS[i % 9], cycling families evenly
    across all 9 tokens: token 0 (XRP) gets 12 agents, the other 8 get 11 each.

SPLIT = 2026-05-15 (calendar date): TRAIN = dates before, TEST = dates on/after.
  Targets are computed over the FULL series first (indicators need history),
  then split at the same index as the price series. The split is pre-registered
  and the bar below is evaluated on the TEST set ONLY. Do NOT move the split,
  do NOT re-run with tweaked params — that would be p-hacking.

PRE-REGISTERED BAR (test set only):
  (a) agent's test total return STRICTLY BEATS buy-and-hold total return on the
      SAME token over the SAME test period (same engine, same fees), AND
  (b) test max drawdown no worse than -40%, AND
  (c) >= 12 round trips on the test set.
  Overall winner = highest test-set excess return vs buy-and-hold among bar-passers.
  If nothing passes: the honest result is "no robust winning strategy found".

Determinism: seed 42 (no RNG used in practice), fixed agent order, JSON written
with sorted keys and rounded floats, so two runs are byte-identical.
"""
import json, math, random, datetime

SEED = 42
random.seed(SEED)

TOKENS = ["XRP", "PHNIX", "ARMY", "CTF", "SOLO", "FUZZY", "DROP", "SLT", "BEAR"]
SPLIT = "2026-05-15"            # TEST = dates >= SPLIT
FEE = 0.0015                    # 0.15% per side
START = 10000.0                 # fake dollars
MAX_DD = -0.40                  # bar condition (b)
MIN_RT = 12                     # bar condition (c)

# ---------------------------------------------------------------- indicators
# Match app.js indicator math exactly (smaAt, stdevAt, rsiWilderAt, emaArr,
# macdArrs) so the tournament winner behaves identically in the app.
def sma(vals, n, i):
    if i + 1 < n:
        return None
    return sum(vals[i - n + 1:i + 1]) / n

def stdev(vals, n, i):
    # population stdev of closes (app.js stdevAt)
    if i + 1 < n:
        return None
    m = sma(vals, n, i)
    return math.sqrt(sum((x - m) ** 2 for x in vals[i - n + 1:i + 1]) / n)

def rsi_wilder(cl, n, i):
    # app.js rsiWilderAt: window-sum gains/losses (Wilder-style, no recursion)
    if i < n:
        return None
    gains = losses = 0.0
    for j in range(i - n + 1, i + 1):
        ch = cl[j] - cl[j - 1]
        if ch > 0:
            gains += ch
        else:
            losses -= ch
    if losses == 0:
        return 100.0
    return 100 - 100 / (1 + gains / losses)

def ema_arr(vals, n):
    # app.js emaArr: seeded with vals[0], released at index n-1
    out = [None] * len(vals)
    k = 2 / (n + 1)
    e = None
    for i, v in enumerate(vals):
        e = v if e is None else v * k + e * (1 - k)
        if i + 1 >= n:
            out[i] = e
    return out

# ---------------------------------------------------------------- strategies
# Each returns target[0/1] per day over the FULL series (targets[t] decided on
# close[t]). Parameter names match app.js STRATEGIES.<id>.defaults exactly.
#
# DONCHIAN CAVEAT: because o=h=l=c in the source data, the "entry-bar high"
# breakout degenerates to "close > max of prior entry closes" and the "exit-bar
# low" breakdown to "close < min of prior exit closes". This is the close-only
# reading of Donchian; it is not the classic intraday-range breakout.
def strat_rsi(cl, p):
    pos, cur = [0] * len(cl), 0
    for i in range(len(cl)):
        r = rsi_wilder(cl, p["period"], i)
        if r is None:
            continue
        if r <= p["buy_level"]:
            cur = 1
        elif r >= p["sell_level"]:
            cur = 0
        pos[i] = cur
    return pos

def strat_bollinger(cl, p):
    pos, cur = [0] * len(cl), 0
    for i in range(len(cl)):
        m, s = sma(cl, p["period"], i), stdev(cl, p["period"], i)
        if m is None:
            continue
        if cl[i] < m - p["mult"] * s:
            cur = 1
        elif cl[i] > m:
            cur = 0
        pos[i] = cur
    return pos

def strat_ma_cross(cl, p):
    out = []
    for i in range(len(cl)):
        f, s = sma(cl, p["fast"], i), sma(cl, p["slow"], i)
        out.append(1 if (f is not None and s is not None and f > s) else 0)
    return out

def strat_donchian(cl, p):
    pos, cur = [0] * len(cl), 0
    e, x = p["entry"], p["exit"]
    for i in range(len(cl)):
        if i < e:
            continue
        # CAVEAT: hi/lo == close in this data, so these are max/min of closes
        mx = max(cl[i - e:i])
        mn = min(cl[i - x:i])
        if cl[i] > mx:
            cur = 1
        elif cl[i] < mn:
            cur = 0
        pos[i] = cur
    return pos

def strat_macd(cl, p):
    ef, es = ema_arr(cl, p["fast"]), ema_arr(cl, p["slow"])
    line = [ef[i] - es[i] if (ef[i] is not None and es[i] is not None) else None
            for i in range(len(cl))]
    sig, e, cnt = [None] * len(cl), None, 0
    k = 2 / (p["signal"] + 1)
    for i in range(len(cl)):
        if line[i] is None:
            continue
        e = line[i] if e is None else line[i] * k + e * (1 - k)
        cnt += 1
        if cnt >= p["signal"]:
            sig[i] = e
    return [1 if (line[i] is not None and sig[i] is not None and line[i] > sig[i]) else 0
            for i in range(len(cl))]

STRATS = {"rsi": strat_rsi, "bollinger": strat_bollinger, "ma_cross": strat_ma_cross,
          "donchian": strat_donchian, "macd": strat_macd}

# ---------------------------------------------------------------- engine
def backtest(days, targets, fee=FEE, start=START):
    """days: list of (open, close). targets[t] decided on close[t], executed at
    open[t+1] (with o==c in this data, execution = next day's close)."""
    cash, qty, entry = start, 0.0, 0.0
    equity, wins, rts, trades = [], 0, 0, 0
    for t in range(len(days)):
        if t > 0:
            want, px = targets[t - 1], days[t][0]
            if want == 1 and qty == 0 and cash > 0:
                qty, cash, entry = cash * (1 - fee) / px, 0.0, px
                trades += 1
            elif want == 0 and qty > 0:
                if px > entry:
                    wins += 1
                rts += 1
                trades += 1
                cash, qty = qty * px * (1 - fee), 0.0
        equity.append(cash + qty * days[t][1])
    if qty > 0:  # liquidate at last close
        cash = qty * days[-1][1] * (1 - fee)
        qty = 0
        equity[-1] = cash
    rets = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity)) if equity[i - 1] > 0]
    tot = equity[-1] / start - 1
    sharpe = 0.0
    if len(rets) > 1:
        mu = sum(rets) / len(rets)
        var = sum((r - mu) ** 2 for r in rets) / len(rets)
        sharpe = (mu / (math.sqrt(var) or 1e-9)) * math.sqrt(365)
    peak, mdd = equity[0], 0.0
    for e in equity:
        peak = max(peak, e)
        mdd = min(mdd, e / peak - 1)
    return dict(ret=tot, sharpe=sharpe, mdd=mdd, trades=trades,
                winrate=(wins / rts if rts else 0.0), roundtrips=rts, end=equity[-1])

# ---------------------------------------------------------------- parameter grids: 5 families x 20 = exactly 100
GRID = []
for period in [7, 14, 21, 28]:                                   # rsi
    for buy in [20, 25, 30, 35, 40]:
        GRID.append(("rsi", {"period": period, "buy_level": buy, "sell_level": 60}))
for period in [10, 15, 20, 25, 30]:                              # bollinger
    for mult in [1.5, 2.0, 2.5, 3.0]:
        GRID.append(("bollinger", {"period": period, "mult": mult}))
for fast in [5, 10, 20, 25]:                                     # ma_cross
    for slow in [50, 100, 150, 200, 300]:
        GRID.append(("ma_cross", {"fast": fast, "slow": slow}))
for entry in [20, 30, 40, 50, 60]:                               # donchian
    for ex in [5, 10, 15, 20]:
        GRID.append(("donchian", {"entry": entry, "exit": ex}))
for fast in [8, 12]:                                             # macd
    for slow in [21, 26]:
        for signal in [7, 9, 12, 14, 16]:
            GRID.append(("macd", {"fast": fast, "slow": slow, "signal": signal}))
assert len(GRID) == 100, f"grid must be exactly 100, got {len(GRID)}"

def rules_text(family, p):
    if family == "rsi":
        return (f"Each day on the daily close, compute the {p['period']}-day RSI. "
                f"Go LONG when RSI <= {p['buy_level']}; go FLAT when RSI >= {p['sell_level']}. "
                "Long/flat only. Signals trade on the next day's close. Fee 0.15% per side.")
    if family == "bollinger":
        return (f"Each day on the daily close, compute the {p['period']}-day simple moving "
                f"average and population standard deviation of closes. Go LONG when close < "
                f"SMA - {p['mult']}x stdev (below the lower band); go FLAT when close > SMA "
                "(above the middle band). Long/flat only. Signals trade on the next day's "
                "close. Fee 0.15% per side.")
    if family == "ma_cross":
        return (f"Each day on the daily close, compute the {p['fast']}-day and {p['slow']}-day "
                "simple moving averages of closes. Hold LONG while fast MA > slow MA; hold "
                "FLAT otherwise. Long/flat only. Signals trade on the next day's close. "
                "Fee 0.15% per side.")
    if family == "donchian":
        return (f"Each day on the daily close: go LONG when the close exceeds the highest close "
                f"of the previous {p['entry']} days (close-based breakout — intraday highs are "
                "unavailable in this data); go FLAT when the close falls below the lowest close "
                f"of the previous {p['exit']} days. Long/flat only. Signals trade on the next "
                "day's close. Fee 0.15% per side.")
    if family == "macd":
        return (f"Each day on the daily close, compute MACD({p['fast']},{p['slow']}) and its "
                f"{p['signal']}-day signal line. Hold LONG while the MACD line is above the "
                "signal line; hold FLAT otherwise. Long/flat only. Signals trade on the next "
                "day's close. Fee 0.15% per side.")
    raise ValueError(family)

def r6(x):
    return round(float(x), 6)

def main(out_path):
    data_meta, series = {}, {}
    for tok in TOKENS:
        rows = json.load(open(f"data/{tok}.json"))
        cl = [r["c"] for r in rows]
        dates = [r["t"] for r in rows]
        data_meta[tok] = {"n": len(rows), "first": dates[0], "last": dates[-1]}
        series[tok] = {"dates": dates, "days": [(r["o"], r["c"]) for r in rows], "cl": cl}

    leaderboard = []
    for idx, (family, params) in enumerate(GRID):
        token = TOKENS[idx % 9]          # token assignment: documented, deterministic
        k = idx % 20                      # variant number within family (0-based)
        agent_id = f"{family}-{k + 1:02d}"
        s = series[token]
        tg_full = STRATS[family](s["cl"], params)
        train_days, train_tg, test_days, test_tg = [], [], [], []
        for d, day, t in zip(s["dates"], s["days"], tg_full):
            if d >= SPLIT:
                test_days.append(day); test_tg.append(t)
            else:
                train_days.append(day); train_tg.append(t)
        tr = backtest(train_days, train_tg)
        te = backtest(test_days, test_tg)
        bh = backtest(test_days, [1] * len(test_days))   # buy-and-hold baseline, same engine/fees
        beats = te["ret"] > bh["ret"]
        dd_ok = te["mdd"] >= MAX_DD
        rt_ok = te["roundtrips"] >= MIN_RT
        passed = beats and dd_ok and rt_ok
        leaderboard.append({
            "agent_id": agent_id,
            "strategy_id": family,
            "params": params,
            "token": token,
            "train": {"return_pct": r6(tr["ret"] * 100), "sharpe": round(tr["sharpe"], 4),
                      "max_drawdown_pct": r6(tr["mdd"] * 100), "round_trips": tr["roundtrips"],
                      "trades": tr["trades"], "win_rate": r6(tr["winrate"])},
            "test": {"return_pct": r6(te["ret"] * 100), "sharpe": round(te["sharpe"], 4),
                     "max_drawdown_pct": r6(te["mdd"] * 100), "round_trips": te["roundtrips"],
                     "trades": te["trades"], "win_rate": r6(te["winrate"])},
            "buyhold_test": {"return_pct": r6(bh["ret"] * 100),
                             "max_drawdown_pct": r6(bh["mdd"] * 100)},
            "excess_return_pct": r6((te["ret"] - bh["ret"]) * 100),
            "pass": {"beats_buyhold": beats, "drawdown_ok": dd_ok, "roundtrips_ok": rt_ok,
                     "passed_bar": passed},
        })

    # leaderboard sorted by test excess return vs buy-and-hold (desc);
    # ties broken by agent_id for determinism
    leaderboard.sort(key=lambda a: (-a["excess_return_pct"], a["agent_id"]))
    passers = [a for a in leaderboard if a["pass"]["passed_bar"]]
    winner = passers[0] if passers else None

    out = {
        "metadata": {
            "phase": "100-agent strategy tournament",
            "seed": SEED, "fee_per_side": FEE, "start_fake_usd": START,
            "split": f"TRAIN < {SPLIT} <= TEST (calendar dates)",
            "test_period": f"{SPLIT}..2026-10-07",
            "data_caveat": ("daily CLOSE only (o=h=l=c); all indicators close-based; "
                            "Donchian/stdev degrade to close-only semantics; gaps omitted, "
                            "never interpolated; 33-day CoinGecko XRPL feed outage "
                            "2026-03-19..2026-04-20 affects FUZZY/DROP/SLT/BEAR"),
            "assignment": ("agent i (family-major order 0..99) -> token TOKENS[i % 9]; "
                           "XRP gets 12 agents, each other token 11"),
            "bar": {"a": "test return strictly beats same-token buy-and-hold (test period)",
                    "b": f"test max drawdown >= {MAX_DD * 100:.0f}%",
                    "c": f"test round trips >= {MIN_RT}"},
            "data": data_meta,
        },
        "leaderboard": leaderboard,
        "pass_count": len(passers),
        "winner_agent_id": winner["agent_id"] if winner else None,
    }
    json.dump(out, open(out_path, "w"), indent=2, sort_keys=True)

    # ---- winner.json (schema consumed by app.js loadStrategy)
    if winner:
        w = {"passed_bar": True,
             "winner_name": winner["agent_id"],
             "token": winner["token"],
             "rules_text": rules_text(winner["strategy_id"], winner["params"]),
             "test_stats": {
                 "total_return_pct": winner["test"]["return_pct"],
                 "buyhold_return_pct": winner["buyhold_test"]["return_pct"],
                 "max_drawdown_pct": winner["test"]["max_drawdown_pct"],
                 "round_trips": winner["test"]["round_trips"],
                 "sharpe": winner["test"]["sharpe"]},
             "note": (f"Pre-registered bar passed on the TEST set ({SPLIT}..2026-10-07). "
                      "BACKTEST with FAKE money — not live results, not a guarantee. "
                      "Trade idea only; nothing here is financial advice.")}
    else:
        # closest miss = most bar conditions passed, then highest excess return
        # (descriptive only — the outcome is already fixed: no agent passed the bar)
        def miss_key(a):
            p = a["pass"]
            return (sum(p[k] for k in ("beats_buyhold", "drawdown_ok", "roundtrips_ok")),
                    a["excess_return_pct"], a["agent_id"])
        miss = max([a for a in leaderboard if not a["pass"]["passed_bar"]], key=miss_key)
        fail = [k for k in ("beats_buyhold", "drawdown_ok", "roundtrips_ok")
                if not miss["pass"][k]]
        w = {"passed_bar": False, "winner_name": None, "token": None,
             "rules_text": None, "test_stats": None,
             "note": ("No robust winning strategy found. 100 agents tested on the "
                      f"pre-registered test set ({SPLIT}..2026-10-07); none passed all three "
                      "bar conditions. Closest miss: "
                      f"{miss['agent_id']} on {miss['token']} (excess return "
                      f"{miss['excess_return_pct']:.2f}% vs buy-and-hold, failed: "
                      f"{', '.join(fail)}). Bar was fixed before testing; no re-runs, no "
                      "p-hacking.")}
    json.dump(w, open("results/winner.json", "w"), indent=2, sort_keys=True)

    # ---- active_strategy.json (schema consumed by app.js loadActiveStrategy)
    if winner:
        a = {"strategy_id": winner["strategy_id"], "params": winner["params"],
             "source": "tournament-winner"}
    else:
        a = {"strategy_id": "rsi", "params": {"period": 14, "buy_level": 30, "sell_level": 60},
             "source": "toolkit",
             "_note": "no tournament winner passed the bar; app falls back to toolkit default"}
    json.dump(a, open("results/active_strategy.json", "w"), indent=2, sort_keys=True)

    print(f"agents={len(leaderboard)} passers={len(passers)} winner={winner['agent_id'] if winner else 'NONE'}")
    print("top-5 by test excess return vs buy-and-hold:")
    for a in leaderboard[:5]:
        print(f"  {a['agent_id']:<13} {a['token']:<6} test {a['test']['return_pct']:>8.2f}% "
              f"vs BH {a['buyhold_test']['return_pct']:>8.2f}%  excess {a['excess_return_pct']:>8.2f}%  "
              f"DD {a['test']['max_drawdown_pct']:>7.2f}%  RT {a['test']['round_trips']:>3}  "
              f"pass={a['pass']['passed_bar']}")

if __name__ == "__main__":
    import sys
    main(sys.argv[1] if len(sys.argv) > 1 else "results/tournament.json")
