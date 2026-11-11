"""Predefined A/B replay. No threshold search; synthetic execution, not broker ticks."""
import json
import hashlib
import random
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean, median
from types import SimpleNamespace

from run_long_xauusd_research import (
    FIVE, MINUTE, PERIODS, DISCOVERY, build_setups, load_bars,
    check_hit, simulate, range_validation,
)
from test_market_structure import Candle, consecutive

OUT = Path('outputs')
SCENARIOS = {
    'frictionless': dict(spread=0., slippage=0., commission=0.),
    'low': dict(spread=.25, slippage=.05, commission=.06),
    'central': dict(spread=.50, slippage=.10, commission=.06),
    'stress': dict(spread=1., slippage=.25, commission=.06),
}
PROTOCOL = {
    'status': 'Historical diagnostic; rules frozen before this A/B run, but all periods were previously inspected. Not a prospective holdout.',
    'signal': 'Recovered-protection Strong BOS detector from previous study; strict 2+2 swings, prior Wilder ATR14, penetration >=0.15 ATR, body >=0.8 ATR, directional close location >=0.75.',
    'A': 'Entry at first 5m open after BOS confirmation.',
    'B': 'Third 5m candle after BOS closes >=1 frozen pre-BOS ATR beyond broken level. Enter following 5m open, exactly 15m after A. No additional recross, FVG, or probability-score gate. A prior stop touch during waiting does not veto B: no order exists yet.',
    'stops': 'Original BOS wick plus 0.10 frozen ATR. Distance floor is median range of 12 candles ending with BOS, frozen for both. Stop=max distance from actual modeled fill to anchor or frozen floor. Skip if reference entry is on invalid side of wick.',
    'targets': '1.5 times actual fill-to-stop distance from actual fill. 120 minutes maximum from each strategy entry. No trailing, break-even, or volatility-based changes.',
    'universe': 'Both need same complete 135-minute post-BOS window entirely in period and outside Nov 2-5 discovery. One position per strategy; new entry only after prior exit 5m bucket. No hindsight profitability filters.',
    'costs': 'USD per ounce. Treat Twelve Data OHLC as a reference midpoint (unverified quote convention). Synthetic bid=reference-spread/2, ask=reference+spread/2. Long entry ask+slippage, short bid-slippage. Stops and targets trigger on executable exit-side quotes. Adverse slippage on market entry, stops, and time exit; limit target capped at limit with no adverse slippage. Commission charged once at entry. No spread double counting.',
    'primaryHours': 'Conservative common eligibility restriction: entire signal-to-B-timeout window must avoid 20:45-23:15 UTC daily. Covers either published server-midnight offset and an assumed maintenance buffer. This is a declared research restriction, not verified Bybit trading-session history. No swaps incurred in this restricted sample.',
    'secondaryHours': 'ACG session calendar, pre-swap only; not broker-executable performance. Rollover overlaps flagged.',
    'execution': 'Use complete 1m buckets, fallback to native 5m when any minute absent. Stops first if same bar touches both. Stop gaps fill at executable open plus adverse slippage; target gaps capped at target. No tick path, latency distribution, rejections, depth, historical holiday schedule, or dynamic spreads.',
    'risk': '1R is fill-to-stop price distance before commission and exit slippage; costs can make loss >1R. Fixed dollar risk, continuous size, no leverage compounding. No claim of small-account lot-step or margin feasibility.',
    'drawdown': 'Closed-trade and sampled executable-price mark-to-market drawdown. MTM uses entry liquidation quote, completed 1m closes (5m fallback), and exit fill, less commission; does not capture intraminute peaks/troughs.',
    'scenarios': SCENARIOS,
    'broker': {
        'name': 'Bybit TradFi MT5 / CFD, tight-spread commission mode assumed',
        'feeSource': 'https://www.bybit.com/en/help-center/article/Bybit-CFD-Fees-Explained',
        'contractSource': 'https://www.bybit.com/en/help-center/article/Margin-Calculations-on-CFD-Trading',
        'executionSource': 'https://www.bybit.com/en/help-center/article/Slippage-in-CFD-Trading',
        'retrieved': '2026-11-10', 'commissionPerLot': 6, 'ouncesPerLot': 100,
        'caveat': 'Current published schedule applied across history, not audited historical fees. Account mode/symbol suffix unconfirmed. Zero-fee mode would need different spread assumptions. Spread and slippage scenarios are uncalibrated, not measured Bybit averages.',
    },
}


def rollover_overlap(start, end):
    day = start.replace(hour=0, minute=0, second=0, microsecond=0)
    while day < end:
        if start < day+timedelta(hours=23, minutes=15) and end > day+timedelta(hours=20, minutes=45):
            return True
        day += timedelta(days=1)
    return False


def candidates(bars, setups, bounds, restricted):
    out = []
    rejected = Counter()
    for s in setups:
        i = s.i
        window = bars[i:i+28]
        if len(window) != 28 or not consecutive(window):
            rejected['incomplete135mWindow'] += 1
            continue
        begin, end = bars[i+1].start, bars[i+27].end
        if not bounds[0] <= begin < end <= bounds[1]:
            continue
        if not (end <= DISCOVERY[0] or bars[i].start >= DISCOVERY[1]):
            rejected['discoveryOverlap'] += 1
            continue
        if restricted and rollover_overlap(bars[i].start, end):
            rejected['rolloverBuffer'] += 1
            continue
        out.append(s)
    return out, dict(rejected)


def execute(bars, minutes, s, variant, cost):
    i, side = s.i, s.side
    j = i+1 if variant == 'A' else i+4
    reference = bars[j].open
    if side*(reference-s.invalidation) <= 0:
        return None
    h, slip, fee = cost['spread']/2, cost['slippage'], cost['commission']
    entry = reference+side*(h+slip)
    floor = median(b.high-b.low for b in bars[i-11:i+1])
    anchor = s.invalidation-side*.10*s.atr
    risk = max(floor, side*(entry-anchor))
    stop, target = entry-side*risk, entry+side*1.5*risk
    path = [(bars[j].start.isoformat(), (side*(reference-side*h-entry)-fee)/risk)]
    counts = Counter()
    for k in range(j, j+24):
        bar = bars[k]
        finer = [minutes.get(bar.start+n*MINUTE) for n in range(5)]
        complete = all(b is not None for b in finer)
        rows = finer if complete else [bar]
        if not complete:
            counts['fallback5mBuckets'] += 1
        for b in rows:
            op, hi, lo = (p-side*h for p in (b.open,b.high,b.low))
            hit = check_hit(op, hi, lo, side, stop, target)
            if hit:
                reason, fill = hit
                if reason == 'ambiguous':
                    counts['ambiguous1m' if complete else 'ambiguous5m'] += 1
                if reason in ('stop','stop_gap','ambiguous'):
                    fill -= side*slip
                stamp = b.start if reason.endswith('_gap') else b.end
                # Intrabar exit timing is bounded to this candle, not exact ticks.
                break
            path.append((b.end.isoformat(), (side*(b.close-side*h-entry)-fee)/risk))
        else:
            continue
        break
    else:
        reason = 'time'
        fill = bars[k].close-side*(h+slip)
        stamp = bars[k].end
    net = (side*(fill-entry)-fee)/risk
    path.append((stamp.isoformat(),net))
    assert risk > 0 and side*(entry-stop)>0 and side*(target-entry)>0
    assert bars[j].start >= bars[i].end + (timedelta(0) if variant=='A' else 3*FIVE)
    return dict(variant=variant, bosAt=bars[i].end.isoformat(),
                entryAt=bars[j].start.isoformat(), entryReference=reference, entryFill=entry,
                direction=side, originalATR=s.atr, brokenLevel=s.details['brokenLevel'],
                acceptanceATR=side*(bars[i+3].close-s.details['brokenLevel'])/s.atr if variant=='B' else None,
                riskPerOunce=risk, stop=stop, target=target, exitAt=stamp.isoformat(),
                exitFill=fill, exitReason=reason, exitBarIndex=k, netR=net,
                feePerOunce=fee, rolloverBufferOverlap=rollover_overlap(bars[j].start, stamp),
                resolution=dict(counts), mtmPath=path)


def replay(bars, minutes, setups, variant, cost):
    occupied = -1
    trades = []
    skipped = Counter()
    for s in setups:
        if variant=='B' and s.side*(bars[s.i+3].close-s.details['brokenLevel'])/s.atr < 1:
            skipped['acceptanceBelow1ATR'] += 1
            continue
        j = s.i+(1 if variant=='A' else 4)
        if j <= occupied:
            skipped['positionAlreadyOpen'] += 1
            continue
        trade = execute(bars, minutes, s, variant, cost)
        if trade is None:
            skipped['invalidEntry'] += 1
            continue
        trades.append(trade)
        occupied = trade['exitBarIndex']
    return trades, dict(skipped)


def stats(trades):
    balance = peak = dd = mtm_peak = mtm_dd = 0.
    streak = max_streak = 0
    for t in trades:
        for _,r in t['mtmPath']:
            value = balance+r
            mtm_peak = max(mtm_peak,value)
            mtm_dd = max(mtm_dd,mtm_peak-value)
        balance += t['netR']
        peak = max(peak,balance)
        dd = max(dd,peak-balance)
        streak = streak+1 if t['netR']<0 else 0
        max_streak = max(max_streak,streak)
    wins = sum(max(0,t['netR']) for t in trades)
    losses = -sum(min(0,t['netR']) for t in trades)
    return dict(trades=len(trades), netR=balance, meanR=balance/len(trades) if trades else None,
                winRate=mean(t['netR']>0 for t in trades) if trades else None,
                profitFactor=wins/losses if losses else None,
                closedDrawdownR=dd, sampledMTMDrawdownR=mtm_dd, maxLosingStreak=max_streak,
                medianStopUSDPerOz=median(t['riskPerOunce'] for t in trades) if trades else None,
                medianHoldMinutes=median((datetime.fromisoformat(t['exitAt'])-datetime.fromisoformat(t['entryAt'])).total_seconds()/60 for t in trades) if trades else None,
                rolloverBufferTrades=sum(t['rolloverBufferOverlap'] for t in trades),
                exitReasons=dict(Counter(t['exitReason'] for t in trades)),
                resolution=dict(sum((Counter(t['resolution']) for t in trades),Counter())))


def bootstrap(a, b, bounds):
    weeks = defaultdict(lambda: [0.,0.])
    day = bounds[0]
    while day<bounds[1]:
        weeks[day.date().isocalendar()[:2]]
        day += timedelta(days=1)
    for idx, trades in enumerate((a,b)):
        for t in trades:
            weeks[datetime.fromisoformat(t['entryAt']).date().isocalendar()[:2]][idx] += t['netR']
    delta = [b-a for a,b in weeks.values()]
    rng = random.Random(20261110)
    draws = sorted(sum(rng.choices(delta,k=len(delta))) for _ in range(4000))
    return {'calendarWeeks':len(delta),'BminusANetR':sum(delta),
            'approximatePairedWeekBootstrap95IntervalTotalR':[draws[100],draws[3899]],
            'note':'Descriptive dependent-week approximation; not corrected for research selection or regimes.'}


def execution_checks():
    tested = 0
    for side in (1,-1):
        origin = next(iter(PERIODS.values()))[0] + timedelta(days=5)
        bars = [Candle(origin+n*FIVE,origin+(n+1)*FIVE,100,100.5,99.5,100) for n in range(40)]
        s = SimpleNamespace(i=12, side=side, atr=1., invalidation=100-side,
                            details={'brokenLevel':100.})
        for mode in ('ambiguous','gap','target'):
            fine = {}
            for k in range(13,37):
                for n in range(5):
                    t=bars[k].start+n*MINUTE
                    fine[t]=Candle(t,t+MINUTE,100,100,100,100)
            first=bars[13].start
            if mode=='ambiguous':
                fine[first]=Candle(first,first+MINUTE,100,104,96,100)
            elif mode=='target':
                fine[first]=Candle(first,first+MINUTE,100,104 if side==1 else 100,96 if side==-1 else 100,100)
            else:
                t=first+MINUTE
                value=100-side*2
                fine[t]=Candle(t,t+MINUTE,value,value,value,value)
            t=execute(bars,fine,s,'A',SCENARIOS['central'])
            if mode=='ambiguous':
                assert t['exitReason']=='ambiguous'
                assert abs(t['exitFill']-(t['stop']-side*.1))<1e-9
            elif mode=='gap':
                assert t['exitReason']=='stop_gap'
                assert abs(t['exitFill']-(100-side*2-side*.25-side*.1))<1e-9
            else:
                assert t['exitReason']=='target'
                assert abs(t['exitFill']-t['target'])<1e-9
                assert abs(t['netR']-(1.5-.06/t['riskPerOunce']))<1e-9
            tested+=1
    return tested


def main():
    # Written before reading outcomes, making all design decisions inspectable.
    OUT.joinpath('XAUUSD_BOS_A_vs_B_protocol.json').write_text(json.dumps(PROTOCOL,indent=2)+'\n')
    bars,s5 = load_bars('5m',FIVE)
    fine,s1 = load_bars('1m',MINUTE)
    minutes = {b.start:b for b in fine}
    setups = build_setups(bars,recover_protection=True)['strongBOS']
    report = {'protocol':PROTOCOL,'sources':[s5,s1],'samples':{},'validation':{}}
    for restricted in (False,True):
        sample = 'rolloverExcluded' if restricted else 'ACGCalendarPreSwap'
        report['samples'][sample] = {}
        for scenario,cost in SCENARIOS.items():
            result = {'periods':{},'all':{},'monthly':{}}
            combined = {'A':[],'B':[]}
            for period,bounds in PERIODS.items():
                candidate,excluded = candidates(bars,setups,bounds,restricted)
                group = {'candidateSignals':len(candidate),'exclusions':excluded}
                for variant in ('A','B'):
                    trades, skipped = replay(bars,minutes,candidate,variant,cost)
                    combined[variant] += trades
                    group[variant] = {'summary':stats(trades),'skipped':skipped,'trades':trades}
                group['comparison'] = bootstrap(group['A']['trades'],group['B']['trades'],bounds)
                result['periods'][period] = group
            for variant in ('A','B'):
                trades=combined[variant]
                result['all'][variant]=stats(trades)
                months=defaultdict(list)
                for t in trades:
                    months[t['entryAt'][:7]].append(t)
                result['monthly'][variant]={m:stats(ts) for m,ts in sorted(months.items())}
            report['samples'][sample][scenario] = result
            print(sample,scenario,{v:result['all'][v] for v in ('A','B')},flush=True)
    # Exact compatibility check on legacy eligibility, zero-cost arithmetic and exit sequencing.
    legacy = []
    for bounds in PERIODS.values():
        legacy += simulate(bars,minutes,setups,bounds)
    by_bos = {s.details['bosAt']:s for s in setups}
    for t in legacy:
        new = execute(bars,minutes,by_bos[t['bosAt']],'A',SCENARIOS['frictionless'])
        assert abs(new['netR']-t['grossR']) < 1e-9
        assert abs(new['entryFill']-t['entry']) < 1e-9
        assert abs(new['stop']-t['stop']) < 1e-9
        assert abs(new['target']-t['target']) < 1e-9
    for sample in report['samples']['rolloverExcluded'].values():
        for v in ('A','B'):
            assert sample['all'][v]['rolloverBufferTrades']==0
    report['validation']['legacyZeroCostTradesReconciled']=len(legacy)
    report['validation']['syntheticLongShortGapTargetAmbiguityChecks']=execution_checks()
    report['rangeComponentUnchanged']=range_validation(bars)
    for sample in report['samples'].values():
        for result in sample.values():
            for group in result['periods'].values():
                for variant in ('A','B'):
                    for t in group[variant]['trades']:
                        values=[v for _,v in t.pop('mtmPath')]
                        t['sampledMTMMinimumR']=min(values)
                        t['sampledMTMMaximumR']=max(values)
    report['scriptSHA256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    OUT.joinpath('XAUUSD_BOS_A_vs_B_execution.json').write_text(json.dumps(report,indent=2,ensure_ascii=False,allow_nan=False)+'\n',encoding='utf-8')
    print('VALIDATED',report['validation'],flush=True)


if __name__=='__main__':
    main()
