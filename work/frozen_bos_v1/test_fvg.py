import json
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from statistics import mean

from test_market_structure import (
    MINUTES, PAIRS, candles_from, consecutive, forward_path, structure, wilder_atr,
)

WINDOW = timedelta(hours=2)
MAX_HTF_AGE = timedelta(hours=24)
MIN_WIDTH_ATR = 0.15
MIN_BODY_ATR = 0.80
MIN_CLOSE_LOCATION = 0.75
MIN_OVERLAP = 0.50


@dataclass(frozen=True)
class Gap:
    index: int
    direction: int
    low: float
    high: float

    @property
    def midpoint(self):
        return (self.low + self.high) / 2

    @property
    def width(self):
        return self.high - self.low

    @property
    def far_edge(self):
        return self.low if self.direction == 1 else self.high


def direction_name(direction):
    return {1: "bullish", -1: "bearish", 0: "unseeded"}[direction]


def find_gaps(bars):
    for i in range(2, len(bars)):
        first, middle, third = bars[i - 2:i + 1]
        if not consecutive([first, middle, third]):
            continue
        if first.high < third.low:
            yield Gap(i, 1, first.high, third.low)
        elif third.high < first.low:
            yield Gap(i, -1, third.high, first.low)


def penetrates_midpoint(bar, gap):
    return bar.low <= gap.midpoint if gap.direction == 1 else bar.high >= gap.midpoint


def higher_overlaps(gap, bars, htf, higher_bars, higher_gaps, higher_closes):
    cutoff = bars[gap.index].start
    last = bisect_right(higher_closes, cutoff) - 1
    if last < 0:
        return []
    matches = []
    last_close = higher_bars[last].end
    elapsed_local = [bar for bar in bars[:gap.index] if bar.start >= last_close and bar.end <= cutoff]
    for candidate in higher_gaps:
        if candidate.index > last:
            break
        confirmation = higher_bars[candidate.index].end
        if candidate.direction != gap.direction or cutoff - confirmation > MAX_HTF_AGE:
            continue
        intersection = min(candidate.high, gap.high) - max(candidate.low, gap.low)
        if intersection < MIN_OVERLAP * gap.width:
            continue
        observed = higher_bars[candidate.index + 1:last + 1] + elapsed_local
        if any(penetrates_midpoint(bar, candidate) for bar in observed):
            continue
        matches.append({
            "timeframe": htf,
            "confirmedAt": confirmation.isoformat(),
            "zoneLow": candidate.low,
            "zoneHigh": candidate.high,
            "midpoint": candidate.midpoint,
            "overlapFractionOfLocalGap": intersection / gap.width,
        })
    return matches


def test_retest(gap, bars, atr, steps):
    confirmation = bars[gap.index]
    watch = bars[gap.index + 1:gap.index + 1 + steps]
    if len(watch) != steps or not consecutive([confirmation, *watch]):
        return {"retestStatus": "insufficient_contiguous_data", "outcome": "not_evaluated"}
    for i, bar in enumerate(watch, gap.index + 1):
        if min(gap.direction * (bar.open - gap.far_edge), gap.direction * (bar.close - gap.far_edge)) <= 0:
            return {"retestStatus": "invalidated", "outcome": "not_evaluated", "resolvedAt": bar.end.isoformat()}
        if not penetrates_midpoint(bar, gap):
            continue
        if not bar.low <= gap.midpoint <= bar.high:
            return {"retestStatus": "midpoint_skipped", "outcome": "not_evaluated", "resolvedAt": bar.end.isoformat()}
        result = {"retestStatus": "valid_midpoint_retest", "retestConfirmedAt": bar.end.isoformat()}
        if i + 1 < len(bars) and bars[i + 1].start == bar.end and gap.direction * (bars[i + 1].open - gap.far_edge) <= 0:
            return {**result, "outcome": "entry_open_beyond_far_edge"}
        return {**result, **forward_path(bars, i, gap.direction, atr, steps)}
    return {"retestStatus": "no_midpoint_retest", "outcome": "not_evaluated"}


def analyze(timeframe, all_bars, all_gaps, states_1h, prior_signals):
    bars = all_bars[timeframe]
    atrs = wilder_atr(bars)
    frames = (PAIRS[timeframe], "1h")
    closes = {key: [bar.end for bar in all_bars[key]] for key in frames}
    steps = WINDOW // timedelta(minutes=MINUTES[timeframe])
    events = []
    for gap in all_gaps[timeframe]:
        i = gap.index
        prior_atr = atrs[i - 2]
        if prior_atr is None or prior_atr <= 0:
            continue
        first, middle, third = bars[i - 2:i + 1]
        body = gap.direction * (middle.close - middle.open) / prior_atr
        close_distance = middle.close - middle.low if gap.direction == 1 else middle.high - middle.close
        close_location = close_distance / (middle.high - middle.low) if middle.high > middle.low else 0.0
        width_atr = gap.width / prior_atr
        overlaps = [
            overlap for htf in frames
            for overlap in higher_overlaps(gap, bars, htf, all_bars[htf], all_gaps[htf], closes[htf])
        ]
        hourly_index = bisect_right(closes["1h"], third.start) - 1
        hourly_bias = states_1h[hourly_index][0] if hourly_index >= 0 else 0
        direction = direction_name(gap.direction)
        structure_matches = [
            prior_signals[(timeframe, time.isoformat(), direction)]
            for time in (middle.end, third.end)
            if (timeframe, time.isoformat(), direction) in prior_signals
        ]
        events.append({
            "timeframe": timeframe,
            "direction": direction,
            "firstCandleOpen": first.start.isoformat(),
            "thirdCandleOpen": third.start.isoformat(),
            "confirmedAt": third.end.isoformat(),
            "zoneLow": gap.low,
            "zoneHigh": gap.high,
            "midpoint": gap.midpoint,
            "priorWilderATR14": prior_atr,
            "widthATR": width_atr,
            "middleDirectionalBodyATR": body,
            "middleCloseLocation": close_location,
            "strong": width_atr >= MIN_WIDTH_ATR and body >= MIN_BODY_ATR and close_location >= MIN_CLOSE_LOCATION,
            "higherTimeframeOverlaps": overlaps,
            "oneHourBias": direction_name(hourly_bias),
            "oneHourAligned": hourly_bias == gap.direction,
            "sameDirectionStrongStructure": structure_matches,
            **test_retest(gap, bars, prior_atr, steps),
        })
    return events


def stats(events):
    retests = Counter(event["retestStatus"] for event in events)
    outcomes = Counter(event["outcome"] for event in events if event["retestStatus"] == "valid_midpoint_retest")
    moves = [event["signedTwoHourMoveAtr"] for event in events if "signedTwoHourMoveAtr" in event]
    return {
        "gaps": len(events),
        "evaluableRetestWindows": len(events) - retests["insufficient_contiguous_data"],
        "validMidpointRetests": retests["valid_midpoint_retest"],
        "invalidated": retests["invalidated"],
        "midpointSkipped": retests["midpoint_skipped"],
        "noMidpointRetest": retests["no_midpoint_retest"],
        "evaluablePostRetestWindows": len(moves),
        "favorableFirst": outcomes["favorable_first"],
        "adverseFirst": outcomes["adverse_first"],
        "neither": outcomes["neither"],
        "ambiguous": outcomes["ambiguous"],
        "postRetestInsufficientData": outcomes["insufficient_contiguous_data"],
        "entryOpenBeyondFarEdge": outcomes["entry_open_beyond_far_edge"],
        "meanSignedTwoHourMoveATR": mean(moves) if moves else None,
    }


def summarize(events):
    groups = {
        "all": lambda e: True,
        "other": lambda e: not e["strong"],
        "strong": lambda e: e["strong"],
        "strongWithHTFOverlap": lambda e: e["strong"] and bool(e["higherTimeframeOverlaps"]),
        "strongWithoutHTFOverlap": lambda e: e["strong"] and not e["higherTimeframeOverlaps"],
        "strongOneHourAligned": lambda e: e["strong"] and e["oneHourAligned"],
        "strongOneHourOpposed": lambda e: e["strong"] and e["oneHourBias"] != "unseeded" and not e["oneHourAligned"],
        "strongWithStrongStructure": lambda e: e["strong"] and bool(e["sameDirectionStrongStructure"]),
    }
    return {key: {group: stats([e for e in events if e["timeframe"] == key and include(e)])
                  for group, include in groups.items()} for key in PAIRS}


def main():
    source = Path("outputs/XAUUSD_2026_all_intervals.json")
    dataset = json.loads(source.read_text(encoding="utf-8"))
    previous = json.loads(Path("outputs/XAUUSD_MSS_BOS_test.json").read_text(encoding="utf-8"))
    prior_signals = {
        (event["timeframe"], event["signalTime"], event["direction"]):
            {key: event[key] for key in ("signalTime", "event", "breakLevel")}
        for event in previous["signals"] if event["strong"]
    }
    all_bars = {key: candles_from(dataset["intervals"][key]["candles"]) for key in MINUTES}
    all_gaps = {key: list(find_gaps(bars)) for key, bars in all_bars.items()}
    states_1h, _ = structure(all_bars["1h"])
    events = [event for key in PAIRS for event in analyze(key, all_bars, all_gaps, states_1h, prior_signals)]
    start = max(all_bars[key][0].start for key in PAIRS).isoformat()
    end = min(all_bars[key][-1].end for key in PAIRS).isoformat()
    report = {
        "symbol": dataset["symbol"],
        "source": dataset["collection"],
        "timezone": "UTC",
        "rules": {
            "formation": "Three contiguous candles. Bullish: first high < third low. Bearish: third high < first low. Confirmation is the third candle close.",
            "ATR": "14-period Wilder ATR as of the first candle close, immediately before the middle displacement candle.",
            "minWidthATR": MIN_WIDTH_ATR,
            "minDirectionalMiddleBodyATR": MIN_BODY_ATR,
            "minMiddleCloseLocation": MIN_CLOSE_LOCATION,
            "htfOverlap": "For 5m use 15m and 1h. For 15m use 30m and 1h. Same direction; confirmed by third candle open and at most 24 hours old; at least 50% of local gap width overlaps; no midpoint penetration by an observed closed candle since HTF confirmation. Check closed HTF candles and subsequent closed local candles.",
            "structureContext": "Strong same-direction MSS or BOS from the previous test at the middle or third candle close.",
            "retest": "Within the next 2 contiguous hours, require the first midpoint retest and a close inside or on the favorable side of the zone, strictly past the far edge in the favorable direction. An open at or beyond the far edge invalidates the gap. An observed jump past the midpoint without a touch is skipped.",
            "outcome": "Entry at next bar open after retest confirmation, provided the open is on the favorable side of the far edge. First touch of +1 versus -1 prior ATR over the next 2 contiguous hours. Same-bar double touches with open between barriers are ambiguous. Observations can overlap. No costs or sizing.",
        },
        "dataQuality": previous["crossIntervalDataQuality"],
        "summary": summarize(events),
        "sharedWindow": {"start": start, "end": end, "summary": summarize([
            event for event in events if event["firstCandleOpen"] >= start and event["confirmedAt"] <= end
        ])},
        "gaps": events,
    }
    Path("work/XAUUSD_FVG_test.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    for title, results in (("full", report["summary"]), ("shared", report["sharedWindow"]["summary"])):
        print(title, start, end)
        for key, groups in results.items():
            for group, s in groups.items():
                print(key, group, s)
    for key in PAIRS:
        examples = [event for event in events if event["timeframe"] == key and event["strong"] and event["higherTimeframeOverlaps"] and event["outcome"] == "favorable_first"]
        if examples:
            print(key, json.dumps(examples[0]))


if __name__ == "__main__":
    main()
