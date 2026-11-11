"""Read-only ACCEPT inputs, append-only STATE outputs; no market/order requests."""
import hashlib,json,math,os,sys
from datetime import datetime,timedelta,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/ACG_STATE01'
SOURCE=ROOT/'outputs/ACG_ACCEPT01'
UTC=timezone.utc;FIVE=timedelta(minutes=5);MINUTE=timedelta(minutes=1)

def stamp(s):
    t=datetime.fromisoformat(s.replace('Z','+00:00'))
    if t.tzinfo is None:raise ValueError('Timezone missing')
    return t.astimezone(UTC)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def filehash(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def sign(x):return 1 if x>0 else -1 if x<0 else 0

def verify():
    from accept01_run import verify as verify_accept
    parent=verify_accept()
    for name in ('protocol','runtime_manifest'):
        if filehash(OUT/(name+'.json'))!=(OUT/(name+'.sha256')).read_text().strip():raise ValueError('STATE seal mismatch '+name)
    p=json.loads((OUT/'protocol.json').read_text())
    if filehash(SOURCE/'protocol.json')!=p['acceptanceProtocolSHA256']:raise ValueError('Parent protocol mismatch')
    if p['cohortStartUTC']!=parent['cohortStartUTC']:raise ValueError('Cohort mismatch')
    for name,h in json.loads((OUT/'runtime_manifest.json').read_text())['files'].items():
        if filehash(ROOT/name)!=h:raise ValueError('STATE runtime mismatch '+name)
    return p,parent

class Store:
    def __init__(self,path):
        self.path=path;self.rows={}
        if path.exists():
            for line in path.read_text().splitlines():
                r=json.loads(line)
                if r['eventId'] in self.rows:raise ValueError('Duplicate STATE event')
                self.rows[r['eventId']]=r
    def emit(self,key,payload,now):
        if key in self.rows:
            for k,v in payload.items():
                if self.rows[key].get(k)!=v:raise ValueError('STATE past evidence changed '+key+'/'+k)
            return self.rows[key]
        row=dict(eventId=key,study='ACG-STATE-01',recordedAt=now.isoformat(),**payload)
        with self.path.open('a',encoding='utf-8') as f:
            f.write(json.dumps(row,allow_nan=False)+'\n');f.flush();os.fsync(f.fileno())
        self.rows[key]=row;return row

def features(signal,update,candles,costs):
    u=stamp(signal['signalAt'])+3*FIVE
    if stamp(update['eventTime'])!=u:raise ValueError('Acceptance clock mismatch')
    atr=signal['ATR'];side=signal['side']
    if atr<=0 or side not in (-1,1):raise ValueError('Invalid signal')
    # Candle dictionary keys are OPEN timestamps. No candle after U can enter this window.
    needed=[u-k*FIVE for k in range(13,0,-1)]
    missing=[t.isoformat() for t in needed if t not in candles]
    if missing:return dict(status='missing_primary_window',missingOpenTimes=missing)
    chosen=[candles[t] for t in needed]
    closes=[c['row'][4] for c in chosen]
    current=closes[-1]
    m3=side*(current-closes[-4])/atr;m12=side*(current-closes[0])/atr
    denominator=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
    efficiency=abs(current-closes[0])/denominator if denominator>0 else None
    a,b=sign(m3),sign(m12)
    agreement='zero' if not a or not b else ('with_BOS' if a==b==1 else 'against_BOS' if a==b==-1 else 'disagree')
    normalized=side*(current-signal['level'])/atr
    if not math.isclose(normalized,update['distanceATR'],rel_tol=1e-10,abs_tol=1e-10):raise ValueError('Source acceptance price mismatch')
    if (normalized>=1)!=update['accepted']:raise ValueError('Source acceptance flag mismatch')
    availability=max([stamp(signal['observedAt']),stamp(update['observedAt'])]+[stamp(c['observedAt']) for c in chosen])
    m48=None
    extra=[u-k*FIVE for k in range(49,0,-1)]
    if all(t in candles for t in extra):m48=side*(current-candles[extra[0]]['row'][4])/atr
    minute=u.hour*60+u.minute
    return dict(status='complete' if efficiency is not None else 'zero_path_denominator',decisionAt=u.isoformat(),
        baseline=dict(accepted=update['accepted'],signedDistanceATR=normalized,priorATR=atr,logPriorATR=math.log(atr),
            inversePriorATR=1/atr,timeSin=math.sin(2*math.pi*minute/1440),timeCos=math.cos(2*math.pi*minute/1440)),
        candidate=dict(momentum15ATR=m3,momentum60ATR=m12,agreement15_60=agreement,efficiency60=efficiency,
            modeledRoundTripCostToATR={name:(c['spread']+2*c['slippage']+c['commission'])/atr for name,c in costs.items()}),
        descriptive=dict(momentum240ATR=m48),featuresAvailableAt=availability.isoformat(),
        primaryInputDigest=digest(chosen),descriptiveInputDigest=digest([candles[t] for t in extra]) if m48 is not None else None)

def first_seen(parent):
    # Parent baseline existed before collection. Later candles use first response timestamps.
    result={'1m':{},'5m':{}}
    for tf,spec in parent['baseline'].items():
        for row in json.loads(Path(spec['path']).read_text())['candles']:
            t=stamp(row[0]);result[tf][t]=dict(row=row,observedAt=parent['frozenAtUTC'])
    path=SOURCE/'candle_observations.jsonl'
    if path.exists():
        for line in path.read_text().splitlines():
            r=json.loads(line)
            if r['kind']!='first_seen':continue
            tf=r['timeframe'];t=stamp(r['row'][0])
            value=dict(row=r['row'],observedAt=r['observedAt'])
            if t in result[tf] and result[tf][t]['row'][1:]!=r['row'][1:]:raise ValueError('Conflicting first-seen candle')
            result[tf].setdefault(t,value)
    return result

def label(signal,update,minutes,now):
    u=stamp(signal['signalAt'])+3*FIVE;end=stamp(signal['signalAt'])+120*MINUTE
    if now<end:return None
    needed=[u+k*MINUTE for k in range(105)]
    if any(t not in minutes for t in needed):return None
    records=[minutes[t] for t in needed]
    if any(stamp(r['observedAt'])>now for r in records):return None
    rows=[r['row'] for r in records];p0=rows[0][1];atr=signal['ATR'];s=signal['side']
    mfe=max(0,max(s*((r[2] if s==1 else r[3])-p0) for r in rows))/atr
    mae=max(0,max(-s*((r[3] if s==1 else r[2])-p0) for r in rows))/atr
    hit='neither'
    for r in rows:
        favorable=s*((r[2] if s==1 else r[3])-p0)>=atr
        adverse=-s*((r[3] if s==1 else r[2])-p0)>=atr
        if favorable or adverse:
            hit='ambiguous' if favorable and adverse else 'favorable' if favorable else 'adverse';break
    return dict(kind='outcome_label',signalId=signal['signalId'],targetBegin=u.isoformat(),targetEnd=end.isoformat(),
        remainingSignedATR=s*(rows[-1][4]-p0)/atr,MFE_ATR=mfe,MAE_ATR=mae,firstHit_1ATR=hit,
        outcomeAvailableAt=max(stamp(r['observedAt']) for r in records).isoformat(),inputDigest=digest(records),
        executionLabel='First-seen Twelve Data reference prices; not broker fills')

def capture(p,parent,now):
    path=SOURCE/'events.jsonl'
    if not path.exists():return dict(status='awaiting_parent_signals',newFeatures=0,newLabels=0)
    events=[json.loads(line) for line in path.read_text().splitlines()]
    signals={r['signalId']:r for r in events if r['kind']=='signal'}
    updates={r['signalId']:r for r in events if r['kind']=='acceptance_update'}
    observations=first_seen(parent)
    store=Store(OUT/'features.jsonl');labels=Store(OUT/'labels.jsonl')
    from accept01_engine import rollover_overlap
    newF=newL=0;gaps=[];missing_labels=[]
    for sid,signal in signals.items():
        if sid not in updates or stamp(signal['signalAt'])<=stamp(p['cohortStartUTC']):continue
        update=updates[sid]
        if max(stamp(update['observedAt']),stamp(signal['observedAt']))>now:raise ValueError('Parent clock ahead of current time')
        f=features(signal,update,observations['5m'],parent['costScenarios'])
        if f['status']=='missing_primary_window':gaps.append(dict(signalId=sid,**f));continue
        if stamp(f['featuresAvailableAt'])>now:raise ValueError('Feature clock ahead of processing')
        signal_time=stamp(signal['signalAt'])
        stable=dict(kind='features',signalId=sid,**f,signalWasLate=signal['lateObservation'],acceptanceWasLate=update['lateObservation'],
                    calendarEligible=not rollover_overlap(signal_time-FIVE,signal_time+135*MINUTE))
        if sid not in store.rows:
            u=stamp(f['decisionAt']);late=(now-u).total_seconds()>90
            row=dict(**stable,featureComputedAt=now.isoformat(),featureObservedLagSeconds=(now-u).total_seconds(),
                     lateFeatureObservation=late,timelyPrimary=not(late or signal['lateObservation'] or update['lateObservation']) and f['status']=='complete')
            store.emit(sid,row,now);newF+=1
        else:store.emit(sid,stable,now)
        target=label(signal,update,observations['1m'],now)
        if target:
            if sid not in labels.rows:newL+=1
            labels.emit(sid,target,now)
        elif now>=signal_time+120*MINUTE:missing_labels.append(sid)
    return dict(status='captured',newFeatures=newF,newLabels=newL,missingFeatureWindows=gaps,
                missingMatureOutcomeSignals=missing_labels,totalFeatures=len(store.rows),totalLabels=len(labels.rows))

def main():
    p,parent=verify()
    if '--verify-only' in sys.argv:print('STATE and ACCEPT hashes verified');return
    now=datetime.now(UTC);lock=OUT/'capture.lock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY);os.close(fd)
    try:
        result=capture(p,parent,now)
        Store(OUT/'operations.jsonl').emit(now.isoformat(),dict(kind='run',**result),now)
        print(json.dumps(result))
    except Exception as exc:
        Store(OUT/'operations.jsonl').emit(now.isoformat(),dict(kind='failure',errorType=type(exc).__name__,reason=str(exc)),now)
        raise
    finally:lock.unlink()

if __name__=='__main__':main()
