import json
import hashlib
import random
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, median

from test_market_structure import Candle, consecutive, structure, wilder_atr
from test_fvg import find_gaps
from replay_combined_strategies import Setup, create_fvg_retests, summarize, MAX_HOLD, COSTS

OUT = Path("outputs")
PREFIX = "XAUUSD_{}_2026-01-01_to_2026-11-09_ACG_Sessions.json"
MINUTE = timedelta(minutes=1)
FIVE = 5 * MINUTE
UTC = timezone.utc
PERIODS = {
    "January–June": (datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 7, 1, tzinfo=UTC)),
    "July–August": (datetime(2026, 7, 1, tzinfo=UTC), datetime(2026, 9, 1, tzinfo=UTC)),
    "September–November holdout": (datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 11, 10, tzinfo=UTC)),
}
DISCOVERY = (datetime(2026, 11, 2, tzinfo=UTC), datetime(2026, 11, 6, tzinfo=UTC))
HOLDOUT = list(PERIODS)[-1]


def load_bars(label, duration):
    path = OUT / PREFIX.format(label)
    raw = path.read_bytes()
    data = json.loads(raw)
    assert data["fields"] == ["openTime", "open", "high", "low", "close"]
    bars = []
    for stamp, *ohlc in data["candles"]:
        t = datetime.fromisoformat(stamp)
        bars.append(Candle(t, t + duration, *ohlc))
    return bars, {"file":path.name,"sha256":hashlib.sha256(raw).hexdigest(),"candles":len(bars)}


def score_location(bar, side):
    width = bar.high - bar.low
    if not width:
        return 0
    return (bar.close-bar.low if side==1 else bar.high-bar.close)/width


def build_setups(bars, recover_protection=False):
    snapshots, breaks = structure(bars, recover_protection=recover_protection)
    atrs = wilder_atr(bars)
    out = {"allBOS":[], "strongBOS":[], "strongSwing":[], "structuredFVG":[]}
    strong = {}
    for i, side, label, pivot, _ in breaks:
        bar = bars[i]
        atr = atrs[i-1]
        if not atr:
            continue
        penetration = side * (bar.close-pivot.price)/atr
        body = side * (bar.close-bar.open)/atr
        location = score_location(bar,side)
        qualified = penetration >= .15 and body >= .8 and location >= .75
        details = {"bosAt":bar.end.isoformat(),"brokenLevel":pivot.price,"strong":qualified,
            "penetrationATR":penetration,"bodyATR":body,"closeLocation":location}
        if qualified:
            strong[(i,side)] = {"signalTime":bar.end.isoformat(),"event":label,"breakLevel":pivot.price}
        if label != "BOS":
            continue
        wick = bar.low if side == 1 else bar.high
        setup = Setup("strongBOS" if qualified else "otherBOS",i,side,wick,atr,details)
        out["allBOS"].append(setup)
        if qualified:
            out["strongBOS"].append(setup)
            prior = snapshots[i-1][2 if side == 1 else 1]
            if prior is not None:
                assert prior.confirmed_at <= bar.start
                out["strongSwing"].append(Setup("strongSwing",i,side,prior.price,atr,
                    {**details,"stopSwingAt":bars[prior.i].start.isoformat(),"stopSwingKnownAt":prior.confirmed_at.isoformat()}))
    gaps = []
    for gap in find_gaps(bars):
        i, side = gap.index, gap.direction
        atr = atrs[i-2]
        middle = bars[i-1]
        if (not atr or gap.width/atr < .15 or side*(middle.close-middle.open)/atr < .80
            or score_location(middle,side) < .75):
            continue
        matches = [strong[key] for key in ((i-1,side),(i,side)) if key in strong]
        if not matches:
            continue
        gaps.append({"timeframe":"5m","strong":True,"direction":"bullish" if side==1 else "bearish",
            "confirmedAt":bars[i].end.isoformat(),"zoneLow":gap.low,"zoneHigh":gap.high,
            "midpoint":gap.midpoint,"priorWilderATR14":atr,"sameDirectionStrongStructure":matches,
            "oneHourAligned":False,"higherTimeframeOverlaps":[]})
    lookup = {b.end.isoformat():i for i,b in enumerate(bars)}
    out["structuredFVG"] = list(create_fvg_retests(bars,gaps,lookup))
    out["BOSorFVG"] = out["strongBOS"] + out["structuredFVG"]
    return out


def check_hit(open_, high, low, side, stop, target):
    if side*(open_-stop) <= 0:
        return "stop_gap", open_
    if side*(open_-target) >= 0:
        return "target_gap", target
    stopped = low<=stop if side==1 else high>=stop
    reached = high>=target if side==1 else low<=target
    if stopped and reached:
        return "ambiguous", stop
    if stopped:
        return "stop", stop
    if reached:
        return "target", target
    return None


def run_exit(bars, minutes, entry_index, side, stop, target):
    for j in range(entry_index,entry_index+MAX_HOLD):
        bar = bars[j]
        hit = check_hit(bar.open,bar.high,bar.low,side,stop,target)
        if hit is None:
            continue
        if hit[0] in ("stop_gap","target_gap"):
            return j,*hit,"5m_open"
        finer = [minutes.get(bar.start+k*MINUTE) for k in range(5)]
        if any(x is None for x in finer):
            if hit[0]=="ambiguous":
                return j,"stop",stop,"unresolved_5m"
            return j,*hit,"fallback_5m"
        for one in finer:
            fine_hit = check_hit(one.open,one.high,one.low,side,stop,target)
            if fine_hit is not None:
                if fine_hit[0]=="ambiguous":
                    return j,"stop",stop,"unresolved_1m"
                resolution = "resolved_by_1m" if hit[0]=="ambiguous" else "1m"
                return j,*fine_hit,resolution
        raise AssertionError("Matching 5m and 1m OHLC cannot disagree on hit existence")
    j=entry_index+MAX_HOLD-1
    return j,"time",bars[j].close,"5m_close"


def eligible_window(bars, i, period):
    j = i + 1
    window = bars[j:j+MAX_HOLD]
    if len(window)!=MAX_HOLD or not consecutive([bars[i],*window]):
        return False
    left,right = period
    begin,finish=window[0].start,window[-1].end
    return left<=begin and finish<=right and (finish<=DISCOVERY[0] or begin>=DISCOVERY[1])


def simulate(bars, minutes, setups, period, swing=False):
    occupied=-1
    trades=[]
    groups=defaultdict(list)
    for setup in setups:
        if eligible_window(bars,setup.i,period):
            groups[setup.i].append(setup)
    for i, options in sorted(groups.items()):
        if i+1<=occupied or len({s.side for s in options})>1:
            continue
        # On a same-side tie, use the latest FVG retest. Otherwise select the single BOS.
        s=max(options,key=lambda s:s.details.get("gapConfirmedAt",""))
        j,side=i+1,s.side
        entry=bars[j].open
        distance=side*(entry-s.invalidation)
        if distance<=0:
            continue
        typical=median(b.high-b.low for b in bars[j-12:j])
        risk=distance if swing else max(typical,distance+.10*s.atr)
        stop,target=entry-side*risk,entry+side*1.5*risk
        k,reason,exit_,resolution=run_exit(bars,minutes,j,side,stop,target)
        occupied=k
        gross=side*(exit_-entry)
        trades.append({
            "setup":s.kind,"direction":"long" if side==1 else "short",
            "entryAt":bars[j].start.isoformat(),"entry":entry,"stop":stop,"target":target,
            "exitBarOpen":bars[k].start.isoformat(),"exit":exit_,"reason":reason,"resolution":resolution,
            "riskPerOunce":risk,"grossR":gross/risk,
            "netRByRoundTripCostPerOunce":{str(cost):(gross-cost)/risk for cost in COSTS},
            **s.details,
        })
    return trades


def week_interval(trades):
    by_week=defaultdict(list)
    for t in trades:
        key=datetime.fromisoformat(t["entryAt"]).date().isocalendar()[:2]
        by_week[key].append(t["netRByRoundTripCostPerOunce"]["0.5"])
    blocks=[(sum(r),len(r)) for r in by_week.values()]
    rng=random.Random(20261110)
    estimates=[]
    if len(blocks)<5:
        return {"activeWeeks":len(blocks),"approximate95PercentIntervalPerTrade":None}
    for _ in range(3000):
        sample=rng.choices(blocks,k=len(blocks))
        estimates.append(sum(a for a,n in sample)/sum(n for a,n in sample))
    estimates.sort()
    return {"activeWeeks":len(blocks),"approximate95PercentIntervalPerTrade":[estimates[75],estimates[2924]]}


def paired_stops(bars, minutes, trades, swing_setups):
    lookup={b.start.isoformat():i for i,b in enumerate(bars)}
    anchors={s.details["bosAt"]:s.invalidation for s in swing_setups}
    out=[]
    for t in trades:
        stop=anchors.get(t["bosAt"])
        side=1 if t["direction"]=="long" else -1
        if stop is None or side*(t["entry"]-stop)<=0:
            continue
        j=lookup[t["entryAt"]]
        k,reason,exit_,resolution=run_exit(bars,minutes,j,side,stop,t["target"])
        out.append({"entryAt":t["entryAt"],"stop":stop,"target":t["target"],"exit":exit_,"reason":reason,
            "originalNetR":t["netRByRoundTripCostPerOunce"]["0.5"],
            "swingStopNetROriginalSize":(side*(exit_-t["entry"])-.5)/t["riskPerOunce"],
            "plannedStopRiskVsOriginal":side*(t["entry"]-stop)/t["riskPerOunce"]})
    return {"count":len(out),"originalNetR":sum(p["originalNetR"] for p in out),
            "swingStopNetROriginalSize":sum(p["swingStopNetROriginalSize"] for p in out),
            "medianPlannedStopRiskVsOriginal":median([p["plannedStopRiskVsOriginal"] for p in out]) if out else None,
            "pairs":out}


def range_validation(bars):
    early=[b.high-b.low for b in bars if b.end<=PERIODS["January–June"][1]]
    benchmark=median(early)
    e_const,e_recent=[],[]
    left,right=PERIODS[HOLDOUT]
    for i,b in enumerate(bars):
        if i<12 or not left<=b.start<right or DISCOVERY[0]<=b.start<DISCOVERY[1]:
            continue
        recent=bars[i-12:i]
        if not consecutive([*recent,b]) or (recent[0].start<DISCOVERY[1] and b.start>=DISCOVERY[1]):
            continue
        actual=b.high-b.low
        e_const.append(abs(actual-benchmark))
        e_recent.append(abs(actual-median(r.high-r.low for r in recent)))
    return {"count":len(e_const),"constantJanJuneMedian":benchmark,
        "constantMAE":mean(e_const),"priorHourMedianMAE":mean(e_recent),
        "constantMedianAbsoluteError":median(e_const),"priorHourMedianAbsoluteError":median(e_recent)}


def main():
    recovery = "--recover-protection" in sys.argv
    bars, source5=load_bars("5m",FIVE)
    finer, source1=load_bars("1m",MINUTE)
    minutes={b.start:b for b in finer}
    setups=build_setups(bars,recover_protection=recovery)
    print("Signals", {name:len(group) for name,group in setups.items()},flush=True)
    report={"symbol":"XAUUSD","sources":[source5,source1],
        "detector":{"recoveryEnabled":recovery,"note":("Post-hoc exploratory repair. If a direction has no protected swing, arm the next newly confirmed opposite-side pivot when the close is on the valid side. All periods are diagnostic after the lock was discovered." if recovery else "Frozen prior rules."),
            "lastStrongBOS":bars[setups["strongBOS"][-1].i].end.isoformat(),
            "strongSignalsByMonth":dict(Counter(bars[s.i].start.strftime("%Y-%m") for s in setups["strongBOS"]))},
        "method":{
            "thresholds":"Strict 2+2 pivots; continuation BOS; 0.15 prior ATR beyond swing, 0.80 prior ATR directional body, outer quarter close. ATR is Wilder 14.",
            "signalWick":"Entry on next 5m open. Stop beyond signal wick by 0.10 prior ATR, at least the last 12-bar median range. FVG setup uses its own previously tested structural invalidation.",
            "swing":"Exact most recent confirmed opposite swing known before BOS candle open, with no buffer or range floor.",
            "execution":"One position per variant and period, 1.5R target, 24 five-minute candles max. One-minute bars refine barrier fills on complete 1m buckets. Stop first for unresolved OHLC, stop gaps at open, favorable gaps capped at target. Fee scenarios USD/oz per round trip. No bid/ask.",
            "holdout":"September 1 through November 9. Reject 2–5 November discovery interval and any full outcome window crossing it or the evaluation-period end. The period is fresh for these 5m rules except excluded dates; older higher intervals were previously inspected.",
            "matched":"Re-evaluate baseline entries with fixed original size and target and replace only the stop. Longer holding periods can overlap, so paired outcomes do not represent a one-position portfolio.",
            "interval":"Exploratory percentile block bootstrap over active holdout ISO weeks; no adjustment for model comparison."},
        "periods":{}}
    for period,bounds in PERIODS.items():
        result={}
        for name,group in setups.items():
            trades=simulate(bars,minutes,group,bounds,swing=name=="strongSwing")
            counts=dict(Counter(t["resolution"] for t in trades))
            result[name]={"trades":trades,"costs":summarize(trades),"exitReasons":dict(Counter(t["reason"] for t in trades)),
                "resolution":counts,"weeklyBootstrap":week_interval(trades)}
            print(period,name,len(trades),round(result[name]["costs"]["0.5"]["netR"],3),
                  round(result[name]["costs"]["1.0"]["netR"],3),
                  round(result[name]["costs"]["0.5"]["maxClosedTradeDrawdownR"],3),counts,flush=True)
        result["matchedSwingStop"]=paired_stops(bars,minutes,result["strongBOS"]["trades"],setups["strongSwing"])
        report["periods"][period]=result
        print("Matched",period,{k:v for k,v in result["matchedSwingStop"].items() if k!="pairs"},flush=True)
    report["rangePrediction"]=range_validation(bars)
    print("Range",report["rangePrediction"],flush=True)
    suffix = "_recovery" if recovery else ""
    Path(f"work/XAUUSD_long_history_research{suffix}.json").write_text(json.dumps(report,indent=2,allow_nan=False)+"\n",encoding="utf-8")


if __name__=="__main__":
    main()
