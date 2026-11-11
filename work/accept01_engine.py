"""ACG-ACCEPT-01. Local paper evidence only. Launch through accept01_run.py."""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'work/frozen_bos_v1'))
from test_market_structure import Candle, structure, wilder_atr, consecutive
from compare_bos_acceptance_execution import rollover_overlap
from run_long_xauusd_research import check_hit

UTC = timezone.utc
M = timedelta(minutes=1)
FIVE = 5*M

def stamp(s):
    d = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('Timezone missing')
    return d.astimezone(UTC)

def timing(event, observed):
    lag = (observed-event).total_seconds()
    if lag < 0:
        raise ValueError('Decision observed before completion')
    return dict(eventTime=event.isoformat(), observedAt=observed.isoformat(),
                observedLagSeconds=lag, lateObservation=lag > 90)

class Journal:
    def __init__(self, path, now):
        self.path, self.now, self.rows = path, now, {}
        if path.exists():
            for line in path.read_text(encoding='utf-8').splitlines():
                row = json.loads(line)
                key = row['eventId']
                if key in self.rows:
                    raise ValueError('Duplicate past event '+key)
                self.rows[key] = row
        self.new = 0

    def emit(self, key, payload, event=None):
        if key in self.rows:
            old = self.rows[key]
            for k, v in payload.items():
                if old.get(k) != v:
                    raise ValueError('Past-event consistency failed '+key+'/'+k)
            return old
        row = dict(eventId=key, recordedAt=self.now.isoformat(), study='ACG-ACCEPT-01', **payload)
        if event is not None:
            row.update(timing(event, self.now))
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(row, allow_nan=False)+'\n')
            f.flush()
            os.fsync(f.fileno())
        self.rows[key] = row
        self.new += 1
        return row

def session(t):
    return t.weekday()<4 or t.weekday()==4 and t.hour<22 or t.weekday()==6 and t.hour>=22

def load(tf, protocol, folder, now):
    step = M if tf=='1m' else FIVE
    records = {}
    for path in (Path(protocol['baseline'][tf]['path']), folder/f'provider_{tf}.json'):
        data = json.loads(path.read_text(encoding='utf-8'))
        for row in data['candles']:
            t = stamp(row[0])
            values = row[1:]
            if t in records and records[t] != values:
                raise ValueError('Conflicting cached candle '+tf+'/'+row[0])
            if session(t) and t+step <= now:
                records[t] = values
    return [Candle(t,t+step,*v) for t,v in sorted(records.items())]

def acceptance(bars_by_start, signal, side, level, atr):
    bars = [bars_by_start.get(signal+k*FIVE) for k in range(3)]
    if any(b is None for b in bars):
        return None
    distance = side*(bars[-1].close-level)/atr
    return dict(accepted=distance>=1, distanceATR=distance)

def entry_terms(reference, side, wick, atr, floor, cost):
    if side*(reference-wick)<=0:
        return None
    entry = reference+side*(cost['spread']/2+cost['slippage'])
    risk = max(floor, side*(entry-wick)+.1*atr)
    return dict(entryFillProxy=entry, stop=entry-side*risk,
                target=entry+side*1.5*risk, riskPerOunce=risk)

def settle(enter, side, terms, minutes, latest, cost):
    t, deadline = enter, enter+120*M
    entry, stop, target, risk = (terms[k] for k in ('entryFillProxy','stop','target','riskPerOunce'))
    while t<deadline and t+M<=latest:
        b = minutes.get(t)
        if b is None:
            return dict(status='data_gap', missingAt=t.isoformat())
        h = side*cost['spread']/2
        hit = check_hit(b.open-h,b.high-h,b.low-h,side,stop,target)
        if hit:
            why, price = hit
            if why in ('stop','stop_gap','ambiguous'):
                price -= side*cost['slippage']
            when = b.start if why.endswith('_gap') else b.end
            return dict(status='closed',exitAt=when.isoformat(),exitEvidenceBarOpen=b.start.isoformat(),
                        exitReason=why,exitFillProxy=price,
                        netR=(side*(price-entry)-cost['commission'])/risk)
        t += M
    if t==deadline:
        price = minutes[t-M].close-side*(cost['spread']/2+cost['slippage'])
        return dict(status='closed',exitAt=t.isoformat(),exitEvidenceBarOpen=(t-M).isoformat(),
                    exitReason='time',exitFillProxy=price,
                    netR=(side*(price-entry)-cost['commission'])/risk)
    return dict(status='open')

def busy(previous, enter):
    if previous is None:
        return False
    if previous['status']!='closed':
        return True
    t = stamp(previous['exitEvidenceBarOpen'])
    return enter <= t.replace(minute=t.minute//5*5,second=0,microsecond=0)

def diagnostic(signal, side, atr, accepted, minutes, latest, costs):
    begin, end = signal+15*M, signal+120*M
    if latest < end:
        return None
    path = [minutes.get(begin+k*M) for k in range(105)]
    missing = [begin+k*M for k,b in enumerate(path) if b is None]
    if missing:
        return dict(status='data_gap',missingAt=missing[0].isoformat())
    gross = side*(path[-1].close-path[0].open)
    return dict(status='complete', accepted=accepted, begin=begin.isoformat(),end=end.isoformat(),
                grossUSDPerOunce=gross, priorATR=atr,
                netUSDPerOunce={name:gross-c['spread']-2*c['slippage']-c['commission'] for name,c in costs.items()})

def process(bars, fine, protocol, folder, now):
    journal = Journal(folder/'events.jsonl', now)
    start = stamp(protocol['cohortStartUTC'])
    if now < start:
        return dict(status='before_boundary', newEvents=0)
    if not bars or not fine:
        raise ValueError('Missing provider candles')
    minutes = {b.start:b for b in fine}
    by_start = {b.start:b for b in bars}
    latest = fine[-1].end
    atrs = wilder_atr(bars)
    _, breaks = structure(bars,recover_protection=True)
    positions = {(scenario,variant):None for scenario in protocol['costScenarios'] for variant in ('A','B')}
    found = set()
    for i,side,label,pivot,_ in breaks:
        b = bars[i]
        if b.end <= start or label!='BOS' or i<14:
            continue
        atr, width = atrs[i-1], b.high-b.low
        if not atr or width<=0:
            continue
        penetration, body = side*(b.close-pivot.price)/atr, side*(b.close-b.open)/atr
        loc = (b.close-b.low if side==1 else b.high-b.close)/width
        if penetration<.15 or body<.8 or loc<.75:
            continue
        sid = b.end.isoformat()+('/long' if side==1 else '/short')
        found.add(sid)
        wick = b.low if side==1 else b.high
        floor = median(c.high-c.low for c in bars[i-11:i+1])
        signal = journal.emit(sid+'/signal',dict(kind='signal', signalId=sid, signalAt=b.end.isoformat(),
                    side=side,ATR=atr,level=pivot.price,signalWick=wick,rangeFloor=floor,
                    bodyATR=body,penetrationATR=penetration,closeLocation=loc,source='Twelve Data proxy'),b.end)
        eligible = not rollover_overlap(b.start,b.end+135*M)
        update = None
        if now>=b.end+15*M:
            acc = acceptance(by_start,b.end,side,pivot.price,atr)
            if acc is None:
                journal.emit(sid+'/acceptance_gap',dict(kind='data_gap',signalId=sid,stage='acceptance'))
            else:
                update = journal.emit(sid+'/acceptance',dict(kind='acceptance_update',signalId=sid,**acc),b.end+15*M)
                result = diagnostic(b.end,side,atr,acc['accepted'],minutes,latest,protocol['costScenarios'])
                if result:
                    key = '/diagnostic' if result['status']=='complete' else '/diagnostic_gap'
                    journal.emit(sid+key,dict(kind='common_horizon',signalId=sid,eligible=eligible,**result))
        for scenario,cost in protocol['costScenarios'].items():
            for variant in ('A','B'):
                key = sid+'/'+scenario+'/'+variant
                enter = b.end+(15*M if variant=='B' else timedelta(0))
                if now<enter:
                    continue
                base = dict(kind='decision',signalId=sid,scenario=scenario,variant=variant)
                if not eligible:
                    journal.emit(key+'/decision',dict(**base,decision='excluded_rollover_window'),enter)
                    continue
                if variant=='B' and update is None:
                    continue
                decision_source = signal if variant=='A' else update
                if variant=='B' and not update['accepted']:
                    journal.emit(key+'/decision',dict(**base,decision='acceptance_below_1ATR'),enter)
                    continue
                if busy(positions[scenario,variant],enter):
                    journal.emit(key+'/decision',dict(**base,decision='position_already_open'),enter)
                    continue
                first = minutes.get(enter)
                if first is None:
                    if latest>=enter+M:
                        positions[scenario,variant] = dict(status='data_gap')
                        journal.emit(key+'/entry_gap',dict(kind='data_gap',signalId=sid,stage='entry',missingAt=enter.isoformat()))
                    continue
                terms = entry_terms(first.open,side,wick,atr,floor,cost)
                if terms is None:
                    journal.emit(key+'/decision',dict(**base,decision='invalid_entry'),enter)
                    continue
                journal.emit(key+'/decision',dict(**base,decision='hypothetical_entry',entryScheduledAt=enter.isoformat(),
                    signalWasLate=signal['lateObservation'],decisionInformationWasLate=decision_source['lateObservation'],
                    executionLabel='Synthetic proxy open; not broker fill',**terms),enter)
                result = settle(enter,side,terms,minutes,latest,cost)
                positions[scenario,variant] = result
                if result['status']!='open':
                    suffix = '/outcome' if result['status']=='closed' else '/gap/'+result['missingAt']
                    journal.emit(key+suffix,dict(kind='outcome' if result['status']=='closed' else 'data_gap',signalId=sid,
                                              scenario=scenario,variant=variant,**result))
    past = {r['signalId'] for r in journal.rows.values() if r.get('kind')=='signal'}
    if past != found:
        raise ValueError('Previously recorded signal disappeared')
    status = dict(checkedAt=now.isoformat(),source='Twelve Data proxy',brokerExecutionValidated=False,
                  newEvents=journal.new,signals=len(found),latest5mClose=bars[-1].end.isoformat(),latest1mClose=latest.isoformat(),
                  stale5m=(now-bars[-1].end).total_seconds()>390,
                  stale1m=(now-latest).total_seconds()>150,sessionExpected=session(now))
    if 'run/'+now.isoformat() not in journal.rows:
        journal.emit('run/'+now.isoformat(),dict(kind='run',**status))
    return status
