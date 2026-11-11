import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean, median

from test_market_structure import candles_from, wilder_atr

MAX_HOLD = 24
COSTS = (0.0, 0.25, 0.50, 1.00)
R_MULTIPLE = 1.5
RANGE_LOOKBACK = 12
OUTPUTS = Path("outputs")


@dataclass(frozen=True)
class Setup:
    kind: str
    i: int
    side: int
    invalidation: float
    atr: float
    details: dict


def read(name):
    return json.loads((OUTPUTS / name).read_text(encoding="utf-8"))


def direction(label):
    return 1 if label == "bullish" else -1


def bars_after(bars, i, maximum):
    for j in range(i + 1, min(i + 1 + maximum, len(bars))):
        if bars[j - 1].end != bars[j].start:
            break
        yield j, bars[j]


def stop_boundary(side, *prices):
    return min(prices) if side == 1 else max(prices)


def create_bos(bars, signals, lookup):
    for signal in signals:
        i = lookup[signal["signalTime"]]
        bar = bars[i]
        side = direction(signal["direction"])
        edge = bar.low if side == 1 else bar.high
        yield Setup("strongBOS", i, side, edge, signal["previousATR14"],
                    {"bosAt": signal["signalTime"], "oneHourAligned": signal["oneHourAligned"]})


def create_zone_retests(bars, zones, bos_by_index, lookup):
    matched = defaultdict(list)
    for zone in zones:
        if zone["kind"] != "pair":
            continue
        i = lookup[zone["knownAt"]]
        side = -zone["side"]
        edge = zone["high"] if side == 1 else zone["low"]
        for j, bar in bars_after(bars, i, 48):
            if side * (bar.close - edge) <= 0:
                continue
            if (j, side) in bos_by_index:
                matched[j, side].append((abs(bar.close - edge), -i, zone))
            break
    for (j, side), candidates in sorted(matched.items()):
        zone = min(candidates, key=lambda item: (item[0], item[1]))[2]
        signal = bos_by_index[j, side]
        edge = zone["high"] if side == 1 else zone["low"]
        opposite = zone["low"] if side == 1 else zone["high"]
        for k, bar in bars_after(bars, j, 12):
            if (bar.low > edge if side == 1 else bar.high < edge):
                continue
            if bar.low <= edge <= bar.high and side * (bar.close - edge) > 0:
                boundary = stop_boundary(side, opposite, bar.low if side == 1 else bar.high)
                yield Setup("zoneBreakRetest", k, side, boundary, signal["previousATR14"], {
                    "zoneKnownAt": zone["knownAt"], "zoneLow": zone["low"], "zoneHigh": zone["high"],
                    "zoneHighQuality": zone["highQuality"], "zoneNearby15mPivot": zone["nearby15m"],
                    "bosAt": signal["signalTime"], "oneHourAligned": signal["oneHourAligned"],
                })
            break


def create_fvg_retests(bars, gaps, lookup):
    for gap in gaps:
        if gap["timeframe"] != "5m" or not gap["strong"]:
            continue
        i = lookup[gap["confirmedAt"]]
        side = direction(gap["direction"])
        far = gap["zoneLow"] if side == 1 else gap["zoneHigh"]
        for j, bar in bars_after(bars, i, 24):
            if min(side * (bar.open - far), side * (bar.close - far)) <= 0:
                break
            midpoint = gap["midpoint"]
            reached = bar.low <= midpoint if side == 1 else bar.high >= midpoint
            if not reached:
                continue
            if bar.low <= midpoint <= bar.high:
                boundary = stop_boundary(side, far, bar.low if side == 1 else bar.high)
                structure_signals = gap["sameDirectionStrongStructure"]
                yield Setup("strongFVGRetestWithStructure" if structure_signals else "strongFVGRetestWithoutStructure",
                            j, side, boundary, gap["priorWilderATR14"], {
                                "gapConfirmedAt": gap["confirmedAt"], "gapLow": gap["zoneLow"], "gapHigh": gap["zoneHigh"],
                                "gapMidpoint": midpoint, "structure": structure_signals,
                                "oneHourAligned": gap["oneHourAligned"], "higherTimeframeGapOverlap": bool(gap["higherTimeframeOverlaps"]),
                            })
            break


def execute(bars, setup, common_stop=False, *, exact_stop=False):
    i, side = setup.i + 1, setup.side
    if i >= len(bars) or bars[setup.i].end != bars[i].start:
        return "missing_entry_bar", i, None
    entry = bars[i].open
    if side * (entry - setup.invalidation) <= 0:
        return "entry_beyond_invalidation", i, None
    typical_range = median(bar.high - bar.low for bar in bars[i-RANGE_LOOKBACK:i])
    assert typical_range > 0
    structural_distance = side * (entry - setup.invalidation) + .10 * setup.atr
    if exact_stop:
        risk = side * (entry - setup.invalidation)
    else:
        risk = typical_range if common_stop else max(typical_range, structural_distance)
    stop, target = entry - side * risk, entry + side * risk * R_MULTIPLE
    ambiguous = False
    for j in range(i, min(i + MAX_HOLD, len(bars))):
        bar = bars[j]
        if j > i and bars[j - 1].end != bar.start:
            return "missing_exit_window", len(bars), None
        if side * (bar.open - stop) <= 0:
            reason, exit_price = "stop_gap", bar.open
            break
        if side * (bar.open - target) >= 0:
            reason, exit_price = "target_gap", target
            break
        stopped = bar.low <= stop if side == 1 else bar.high >= stop
        reached = bar.high >= target if side == 1 else bar.low <= target
        if stopped:
            ambiguous = reached
            reason, exit_price = "stop", stop
            break
        if reached:
            reason, exit_price = "target", target
            break
        if j == i + MAX_HOLD - 1:
            reason, exit_price = "time", bar.close
            break
    else:
        return "missing_exit_window", len(bars), None
    profit = side * (exit_price - entry)
    return None, j, {
        "setup": setup.kind, "direction": "long" if side == 1 else "short",
        "triggerAt": bars[setup.i].end.isoformat(), "entryAt": bars[i].start.isoformat(),
        "entry": entry, "stop": stop, "target": target, "exitBarOpen": bars[j].start.isoformat(),
        "exit": exit_price, "reason": reason, "bothBarriersOnExitBar": ambiguous,
        "riskPerOunce": risk, "previousHourMedianRange": typical_range,
        "grossR": profit / risk, "grossPriceMove": profit,
        "netRByRoundTripCostPerOunce": {str(cost): (profit - cost) / risk for cost in COSTS},
        **setup.details,
    }


def replay(bars, setups, common_stop=False):
    trades, skipped = [], Counter()
    occupied_until = -1
    priority = {"zoneBreakRetest": 0, "strongFVGRetestWithStructure": 1,
                "strongFVGRetestWithoutStructure": 2, "strongBOS": 3}
    for setup in sorted(setups, key=lambda s: (s.i, priority[s.kind],
                                               s.details.get("gapConfirmedAt", ""), -s.side)):
        if setup.i + 1 <= occupied_until:
            skipped["position_open_or_same_entry"] += 1
            continue
        skip, exit_index, trade = execute(bars, setup, common_stop)
        if skip:
            skipped[skip] += 1
            if skip == "missing_exit_window":
                occupied_until = exit_index
            continue
        occupied_until = exit_index
        trades.append(trade)
    return trades, dict(skipped)


def summarize(trades):
    output = {}
    for cost in COSTS:
        results = [trade["netRByRoundTripCostPerOunce"][str(cost)] for trade in trades]
        equity, peak, drawdown = 0, 0, 0
        for result in results:
            equity += result
            peak = max(peak, equity)
            drawdown = max(drawdown, peak - equity)
        output[str(cost)] = {
            "netR": sum(results), "meanR": mean(results) if results else None,
            "positiveTrades": sum(value > 0 for value in results),
            "maxClosedTradeDrawdownR": drawdown,
        }
    return output


def main():
    raw = read("XAUUSD_2026_all_intervals.json")
    bars = candles_from(raw["intervals"]["5m"]["candles"])
    lookup = {bar.end.isoformat(): i for i, bar in enumerate(bars)}
    signals = [e for e in read("XAUUSD_MSS_BOS_test.json")["signals"]
               if e["timeframe"] == "5m" and e["strong"] and e["event"] == "BOS"]
    bos_by_index = {(lookup[e["signalTime"]], direction(e["direction"])): e for e in signals}
    bos = list(create_bos(bars, signals, lookup))
    zone = list(create_zone_retests(bars, read("XAUUSD_5m_liquidity_zones.json")["zones"], bos_by_index, lookup))
    gaps = list(create_fvg_retests(bars, read("XAUUSD_FVG_test.json")["gaps"], lookup))
    with_structure = [s for s in gaps if s.kind == "strongFVGRetestWithStructure"]
    without_structure = [s for s in gaps if s.kind == "strongFVGRetestWithoutStructure"]
    candidates = {
        "strongBOSBenchmark": bos,
        "zoneBreakRetest": zone,
        "strongFVGRetestWithStructure": with_structure,
        "strongFVGRetestWithoutStructure": without_structure,
        "combinedEitherRetest": zone + with_structure,
    }
    variants = {}
    for key, setups in candidates.items():
        trades, skipped = replay(bars, setups)
        common, common_skipped = replay(bars, setups, common_stop=True)
        variants[key] = {
            "candidates": len(setups), "trades": trades, "skipped": skipped, "costScenarios": summarize(trades),
            "commonStopSensitivity": {"tradeCount": len(common), "skipped": common_skipped,
                                      "costScenarios": summarize(common)},
        }
    report = {
        "symbol": "XAUUSD", "timeframe": "5m", "timezone": "UTC",
        "coverage": {"bars": len(bars), "firstOpen": bars[0].start.isoformat(), "lastClose": bars[-1].end.isoformat()},
        "rules": {
            "strongBOSBenchmark": "Enter after the previously tested strong BOS, using signal candle wick as structural invalidation.",
            "zoneBreakRetest": "A pre-existing paired-swing zone's first full close beyond it within 4h must coincide with a strong same-direction BOS. First test of the breakout edge within 12 candles must trade at the edge and close back on breakout side. Invalidation is beyond both the zone and retest wick.",
            "strongFVGRetest": "An existing strong 5m FVG's midpoint must be touched within 24 bars and the retest candle must open and close on valid side of far edge. With-structure variant requires a strong same-direction BOS or MSS on candle 2 or 3 of FVG. Invalidation is beyond both the gap and retest wick.",
            "combinedEitherRetest": "Run both retest strategies with one shared position; zone setup has priority on same entry bar. HTF features are recorded as tags.",
            "execution": "Next 5m open; skip entry beyond structural invalidation. One active trade at a time for each variant. Stop is 0.10 ATR beyond structural invalidation, widened if needed to one median candle range over the previous 12 candles. Target 1.5 times initial risk, time exit at close of 24th candle. Stop assumed first if both barriers hit inside one candle. Opening gap through stop fills at open; target gap fills at target. Right-censored trades excluded.",
            "costs": "Illustrative all-in USD per ounce per round trip. Deduct from gross directional price move before dividing by initial stop distance. Actual bid/ask and broker lot sizes unavailable.",
            "commonStopSensitivity": "Repeat with every trade stop distance set to exactly the previous hour median candle range, same 1.5R target. Still require entry on valid side of structural invalidation.",
            "scope": "Same sample that motivated the hypotheses, exploratory replay rather than independent validation. Risk units do not assume a funded account or particular broker sizing.",
        },
        "variants": variants,
    }
    Path("work/XAUUSD_5m_strategy_replay.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    for key, v in variants.items():
        trades = v["trades"]
        print(key, "candidates", v["candidates"], "trades", len(trades), Counter(t["reason"] for t in trades), v["skipped"])
        print("Base", v["costScenarios"])
        print("Common", v["commonStopSensitivity"]["tradeCount"], v["commonStopSensitivity"]["costScenarios"]["0.5"])
        for t in trades:
            if key in ("zoneBreakRetest", "strongFVGRetestWithStructure"):
                print(t["entryAt"], t["direction"], t["entry"], t["stop"], t["target"], t["reason"], t["netRByRoundTripCostPerOunce"]["0.5"])


if __name__ == "__main__":
    main()
