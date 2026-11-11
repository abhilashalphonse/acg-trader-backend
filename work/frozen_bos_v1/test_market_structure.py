import json
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean

PIVOT_WIDTH = 2
ATR_PERIOD = 14
HORIZON = timedelta(hours=2)
MINUTES = {"5m": 5, "15m": 15, "30m": 30, "1h": 60}
PAIRS = {"5m": "15m", "15m": "30m"}


@dataclass(frozen=True)
class Candle:
    start: datetime
    end: datetime
    open: float
    high: float
    low: float
    close: float


@dataclass(frozen=True)
class Pivot:
    i: int
    price: float
    confirmed_at: datetime


def candles_from(rows):
    return [
        Candle(datetime.fromisoformat(row["openTime"]), datetime.fromisoformat(row["closeTime"]),
               row["open"], row["high"], row["low"], row["close"])
        for row in rows
    ]


def consecutive(bars):
    return all(a.end == b.start for a, b in zip(bars, bars[1:]))


def wilder_atr(bars):
    ranges = [bars[0].high - bars[0].low]
    for previous, bar in zip(bars, bars[1:]):
        ranges.append(max(bar.high - bar.low, abs(bar.high - previous.close), abs(bar.low - previous.close)))
    atr = [None] * (ATR_PERIOD - 1) + [mean(ranges[:ATR_PERIOD])]
    for value in ranges[ATR_PERIOD:]:
        atr.append((atr[-1] * (ATR_PERIOD - 1) + value) / ATR_PERIOD)
    return atr


def structure(bars, *, recover_protection=False):
    pivots = {1: None, -1: None}
    breached = set()
    bias, protected, extreme = 0, None, None
    snapshots, breaks = [], []
    for i, bar in enumerate(bars):
        if i >= 2 * PIVOT_WIDTH:
            center = i - PIVOT_WIDTH
            window = bars[i - 2 * PIVOT_WIDTH:i + 1]
            if consecutive(window):
                for direction, field in ((1, "high"), (-1, "low")):
                    price = getattr(bars[center], field)
                    if all(direction * (price - getattr(other, field)) > 0
                           for j, other in enumerate(window) if j != PIVOT_WIDTH):
                        pivots[direction] = Pivot(center, price, bar.end)

        if recover_protection and bias and protected is None:
            candidate = pivots[-bias]
            if (candidate and candidate.confirmed_at == bar.end
                    and bias * (bar.close - candidate.price) > 0):
                protected = candidate

        if i and pivots[1] and pivots[-1]:
            previous = bars[i - 1]
            for direction in (1, -1):
                if bias == 0:
                    label, level = "SEED", pivots[direction]
                elif direction == bias:
                    label, level = "BOS", pivots[direction]
                    if direction * (level.price - extreme) <= 0:
                        continue
                else:
                    label, level = "MSS", protected
                if level is None or (direction, level.i) in breached:
                    continue
                if direction * (previous.close - level.price) > 0 or direction * (bar.close - level.price) <= 0:
                    continue

                candidate = pivots[-direction]
                if candidate and (-direction, candidate.i) not in breached and direction * (bar.close - candidate.price) > 0:
                    if label != "BOS" or protected is None or direction * (candidate.price - protected.price) > 0:
                        protected = candidate
                elif label != "BOS":
                    protected = None

                breached.add((direction, level.i))
                prior_bias = bias
                bias, extreme = direction, level.price
                if label != "SEED" and previous.end == bar.start:
                    breaks.append((i, direction, label, level, prior_bias))
                break

        for direction, pivot in pivots.items():
            if pivot and direction * (bar.close - pivot.price) > 0:
                breached.add((direction, pivot.i))

        snapshots.append((bias, pivots[1], pivots[-1]))
    return snapshots, breaks


def forward_path(bars, i, direction, atr, steps):
    entry_bar = bars[i + 1] if i + 1 < len(bars) else None
    window = bars[i + 1:i + 1 + steps]
    if len(window) != steps or not consecutive([bars[i], *window]):
        return {"outcome": "insufficient_contiguous_data", "entryOpen": None}
    entry = entry_bar.open
    for bar in window:
        if direction * (bar.open - entry) >= atr:
            outcome = "favorable_first"
        elif direction * (bar.open - entry) <= -atr:
            outcome = "adverse_first"
        else:
            favorable = direction * ((bar.high if direction == 1 else bar.low) - entry) >= atr
            adverse = direction * ((bar.low if direction == 1 else bar.high) - entry) <= -atr
            if not favorable and not adverse:
                continue
            outcome = "ambiguous" if favorable and adverse else "favorable_first" if favorable else "adverse_first"
        break
    else:
        outcome = "neither"
    return {
        "outcome": outcome,
        "entryOpen": entry,
        "entryTime": entry_bar.start.isoformat(),
        "finalClose": window[-1].close,
        "signedTwoHourMoveAtr": direction * (window[-1].close - entry) / atr,
    }


def analyze(timeframe, bars, breaks, all_bars, all_snapshots):
    steps = HORIZON // timedelta(minutes=MINUTES[timeframe])
    atrs = wilder_atr(bars)
    higher_frames = (PAIRS[timeframe], "1h")
    higher_closes = {key: [bar.end for bar in all_bars[key]] for key in higher_frames}
    events = []
    for i, direction, label, level, previous_bias in breaks:
        bar = bars[i]
        atr = atrs[i - 1]
        if atr is None or atr <= 0 or bar.high <= bar.low:
            continue
        penetration = direction * (bar.close - level.price) / atr
        body = direction * (bar.close - bar.open) / atr
        close_location = (bar.close - bar.low if direction == 1 else bar.high - bar.close) / (bar.high - bar.low)
        strong = penetration >= 0.15 and body >= 0.8 and close_location >= 0.75

        bias_1h = 0
        higher_breaks = []
        for htf in higher_frames:
            j = bisect_right(higher_closes[htf], bar.start) - 1
            if j < 0:
                continue
            htf_bias, high, low = all_snapshots[htf][j]
            if htf == "1h":
                bias_1h = htf_bias
            pivot = high if direction == 1 else low
            if pivot and direction * (all_bars[htf][j].close - pivot.price) <= 0 and (
                direction * (bars[i - 1].close - pivot.price) <= 0 < direction * (bar.close - pivot.price)
            ):
                higher_breaks.append({
                    "timeframe": htf,
                    "level": pivot.price,
                    "pivotOpenTime": all_bars[htf][pivot.i].start.isoformat(),
                    "knownAt": pivot.confirmed_at.isoformat(),
                })
        events.append({
            "timeframe": timeframe,
            "signalTime": bar.end.isoformat(),
            "signalBarOpenTime": bar.start.isoformat(),
            "event": label,
            "direction": "bullish" if direction == 1 else "bearish",
            "breakLevel": level.price,
            "pivotOpenTime": bars[level.i].start.isoformat(),
            "pivotKnownAt": level.confirmed_at.isoformat(),
            "signalOpen": bar.open,
            "signalHigh": bar.high,
            "signalLow": bar.low,
            "signalClose": bar.close,
            "previousATR14": atr,
            "penetrationATR": penetration,
            "directionalBodyATR": body,
            "closeLocation": close_location,
            "strong": strong,
            "oneHourBias": {1: "bullish", -1: "bearish", 0: "unseeded"}[bias_1h],
            "oneHourAligned": bias_1h == direction,
            "higherTimeframeLevelsCrossed": higher_breaks,
            **forward_path(bars, i, direction, atr, steps),
        })
    return events


def stats(events):
    outcomes = Counter(e["outcome"] for e in events)
    moves = [e["signedTwoHourMoveAtr"] for e in events if "signedTwoHourMoveAtr" in e]
    return {
        "signals": len(events),
        "evaluable": len(moves),
        "favorableFirst": outcomes["favorable_first"],
        "adverseFirst": outcomes["adverse_first"],
        "neither": outcomes["neither"],
        "ambiguous": outcomes["ambiguous"],
        "insufficientContiguousData": outcomes["insufficient_contiguous_data"],
        "meanSignedTwoHourMoveAtr": mean(moves) if moves else None,
    }


def summaries(events):
    groups = {
        "all": lambda e: True,
        "nonStrong": lambda e: not e["strong"],
        "strong": lambda e: e["strong"],
        "strongOneHourAligned": lambda e: e["strong"] and e["oneHourAligned"],
        "strongOneHourOpposed": lambda e: e["strong"] and e["oneHourBias"] != "unseeded" and not e["oneHourAligned"],
        "strongHigherLevelCross": lambda e: e["strong"] and bool(e["higherTimeframeLevelsCrossed"]),
    }
    return {
        timeframe: {
            label: {name: stats([e for e in events if e["timeframe"] == timeframe and e["event"] == label and include(e)])
                    for name, include in groups.items()}
            for label in ("BOS", "MSS")
        }
        for timeframe in PAIRS
    }


def shared_candle_quality(five_minute, fifteen_minute):
    indexed = {bar.start: bar for bar in five_minute}
    differences = []
    for native in fifteen_minute:
        parts = [indexed.get(native.start + timedelta(minutes=5 * offset)) for offset in range(3)]
        if any(bar is None for bar in parts):
            continue
        from_five = (parts[0].open, max(bar.high for bar in parts), min(bar.low for bar in parts), parts[-1].close)
        ohlc = (native.open, native.high, native.low, native.close)
        differences.append(max(abs(a - b) for a, b in zip(from_five, ohlc)))
    return {
        "native15mCandlesCompared": len(differences),
        "differingFromAggregated5mByMoreThan0_00001": sum(delta > 0.00001 for delta in differences),
        "largestAbsoluteOHLCDiscrepancy": round(max(differences), 5),
    }


def main():
    dataset = json.loads(Path("outputs/XAUUSD_2026_all_intervals.json").read_text(encoding="utf-8"))
    all_bars = {key: candles_from(dataset["intervals"][key]["candles"]) for key in MINUTES}
    for key, bars in all_bars.items():
        assert all(bar.end - bar.start == timedelta(minutes=MINUTES[key]) for bar in bars), key
        assert all(a.end <= b.start for a, b in zip(bars, bars[1:])), key
    structures = {key: structure(bars) for key, bars in all_bars.items()}
    snapshots = {key: state[0] for key, state in structures.items()}
    events = [event for key in PAIRS for event in analyze(key, all_bars[key], structures[key][1], all_bars, snapshots)]
    for event in events:
        assert event["pivotKnownAt"] <= event["signalTime"]
        assert all(level["knownAt"] <= event["signalBarOpenTime"] for level in event["higherTimeframeLevelsCrossed"])
    summary = summaries(events)
    overlap_start = max(all_bars[key][0].start for key in PAIRS).isoformat()
    overlap_end = min(all_bars[key][-1].end for key in PAIRS).isoformat()
    overlap = summaries([e for e in events if e["signalBarOpenTime"] >= overlap_start and e["signalTime"] <= overlap_end])
    report = {
        "symbol": dataset["symbol"],
        "source": dataset["collection"],
        "timezone": "UTC",
        "rules": {
            "pivotBarsEachSide": PIVOT_WIDTH,
            "structure": "Strict swing pivots use contiguous candles. The first close crossing a confirmed swing seeds direction. BOS closes through a fresh same-direction swing beyond the last structural break level. MSS closes through the opposite pivot protected by the previous structure break and flips direction. On a BOS, protection advances to the latest intact opposite pivot only when it tightens in the trend direction. A close after a missing-bar gap may update structure but does not emit a signal.",
            "wilderATRPeriod": ATR_PERIOD,
            "strongMinPenetrationATR": 0.15,
            "strongMinDirectionalBodyATR": 0.8,
            "strongMinCloseLocation": 0.75,
            "oneHourContext": "Most recent closed 1h structure state known at the signal bar open.",
            "higherLevelContext": "First LTF close crossing on this bar of the latest confirmed same-side 15m/30m or 1h pivot, whose most recent closed HTF close was on the pre-break side. 5m uses 15m + 1h; 15m uses 30m + 1h.",
            "evaluation": "Next bar open. First touch of symmetric +/-1 previous ATR within 2 contiguous hours. Same-bar double touches with open inside are ambiguous. Signals are evaluated separately and windows can overlap. Costs and position management are excluded.",
        },
        "inputCoverage": {
            key: {"candles": len(bars), "firstOpenTime": bars[0].start.isoformat(), "lastCloseTime": bars[-1].end.isoformat()}
            for key, bars in all_bars.items()
        },
        "crossIntervalDataQuality": shared_candle_quality(all_bars["5m"], all_bars["15m"]),
        "summary": summary,
        "sharedWindow": {"start": overlap_start, "end": overlap_end, "summary": overlap},
        "signals": events,
    }
    Path("work/XAUUSD_MSS_BOS_test.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    for name, scope in (("Full", summary), ("Shared", overlap)):
        print(name, overlap_start, overlap_end)
        for key, labels in scope.items():
            for label, groups in labels.items():
                for group, s in groups.items():
                    print(key, label, group, [s[field] for field in ("signals", "evaluable", "favorableFirst", "adverseFirst", "neither", "ambiguous")], round(s["meanSignedTwoHourMoveAtr"], 3) if s["evaluable"] else "-")
    examples = [e for e in events if e["strong"] and e["higherTimeframeLevelsCrossed"] and e["outcome"] != "insufficient_contiguous_data"]
    for event in examples[:8]:
        print(json.dumps(event))


if __name__ == "__main__":
    main()
