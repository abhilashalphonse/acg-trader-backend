"""Portable IO adapter around unchanged sealed ACCEPT and STATE engines.
No order capabilities. Default verification only. Continuous mode requires --serve.
"""
import argparse,hashlib,importlib,json,math,os,shutil,sys,time
from datetime import datetime,timedelta,timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
UTC=timezone.utc
DATA=Path(os.environ.get('ACG_DATA_DIR',str(ROOT/'work/cloud_runtime_test_data'))).resolve()

class ProviderFailure(Exception):pass
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text())
def now():return datetime.now(UTC)
def iso(t):return t.isoformat(timespec='milliseconds').replace('+00:00','Z')
def stamp(s):return datetime.fromisoformat(s.replace('Z','+00:00')).astimezone(UTC)
def append(p,row):
    with p.open('a',encoding='utf-8') as f:
        f.write(json.dumps(row,allow_nan=False)+'\n');f.flush();os.fsync(f.fileno())
def atomic(p,obj):
    temp=p.with_suffix(p.suffix+'.tmp')
    with temp.open('w',encoding='utf-8') as f:json.dump(obj,f,allow_nan=False);f.flush();os.fsync(f.fileno())
    os.replace(temp,p)

def verify():
    protocols={}
    for study,manifestname in [('ACG_ACCEPT01','manifest'),('ACG_STATE01','runtime_manifest')]:
        d=ROOT/'outputs'/study
        for name in ('protocol',manifestname):
            if sha(d/(name+'.json'))!=(d/(name+'.sha256')).read_text().strip():raise ValueError('Frozen seal mismatch '+study+'/'+name)
        for name,h in read(d/(manifestname+'.json'))['files'].items():
            if sha(ROOT/name)!=h:raise ValueError('Frozen runtime mismatch '+name)
        protocols[study]=read(d/'protocol.json')
    parent=protocols['ACG_ACCEPT01'];state=protocols['ACG_STATE01']
    if state['acceptanceProtocolSHA256']!=sha(ROOT/'outputs/ACG_ACCEPT01/protocol.json'):raise ValueError('Parent link mismatch')
    bound=json.loads(json.dumps(parent))
    for tf,spec in bound['baseline'].items():
        # This explicit map is operational only. Stored sealed JSON is unchanged.
        filename=spec['path'].replace('\\','/').rsplit('/',1)[-1]
        path=ROOT/'outputs'/filename
        if sha(path)!=spec['sha256']:raise ValueError('Baseline mismatch '+filename)
        spec['path']=str(path)
    deployed=ROOT/'cloud/runtime_manifest.json'
    if deployed.exists():
        if sha(deployed)!=(ROOT/'cloud/runtime_manifest.sha256').read_text().strip():raise ValueError('Cloud seal mismatch')
        for name,h in read(deployed)['files'].items():
            if sha(ROOT/name)!=h:raise ValueError('Cloud file mismatch '+name)
    return parent,state,bound

def initialize(parent):
    DATA.mkdir(parents=True,exist_ok=True)
    marker=DATA/'storage_identity.json'
    expected=dict(study='ACG_ACCEPT01',protocolSHA256=sha(ROOT/'outputs/ACG_ACCEPT01/protocol.json'))
    if marker.exists():
        if read(marker)!=expected:raise ValueError('Persistent-volume protocol identity mismatch')
    else:
        if any(DATA.iterdir()):raise ValueError('Unidentified nonempty persistent directory')
        atomic(marker,expected)
    for name,names in [('ACG_ACCEPT01',['protocol.json','protocol.sha256','manifest.json','manifest.sha256']),
                       ('ACG_STATE01',['protocol.json','protocol.sha256','runtime_manifest.json','runtime_manifest.sha256'])]:
        dest=DATA/name;dest.mkdir(exist_ok=True)
        for n in names:
            original=ROOT/'outputs'/name/n;target=dest/n
            if target.exists():
                if sha(target)!=sha(original):raise ValueError('Persistent frozen metadata changed '+n)
            else:shutil.copyfile(original,target)

def validate_rows(body,tf,cursor,end):
    if body.get('status')=='error' or not isinstance(body.get('values'),list):raise ProviderFailure('Provider returned no valid candle list')
    if body.get('meta',{}).get('symbol')!='XAU/USD':raise ProviderFailure('Unexpected provider symbol')
    step=timedelta(minutes=1 if tf=='1m' else 5);rows=[]
    for v in body['values']:
        t=stamp(v['datetime'].replace(' ','T')+'Z')
        prices=[float(v[k]) for k in ('open','high','low','close')]
        o,h,l,c=prices
        if not(all(math.isfinite(x) for x in prices) and l>0 and l<=min(o,c)<=max(o,c)<=h):raise ProviderFailure('Invalid OHLC')
        if not(cursor<=t<end) or t.second or t.microsecond or t.minute%(1 if tf=='1m' else 5):raise ProviderFailure('Invalid candle timestamp')
        rows.append([iso(t),*prices])
    return sorted(rows,key=lambda r:r[0])

def request(tf,cursor,end,key):
    url='https://api.twelvedata.com/time_series?'+urlencode(dict(symbol='XAU/USD',interval='1min' if tf=='1m' else '5min',
        timezone='UTC',order='asc',outputsize=5000,start_date=cursor.strftime('%Y-%m-%d %H:%M:%S'),
        end_date=(end-timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S'),apikey=key))
    try:
        with urlopen(url,timeout=25) as response:body=json.load(response)
    except Exception:raise ProviderFailure('Market-data request failed; URL and credentials suppressed') from None
    return body

def pull(parent,bound,folder,key):
    cutoff=now();obs=folder/'candle_observations.jsonl';canonical={'1m':{},'5m':{}}
    # The append-only first-seen ledger is authoritative after interrupted cache writes.
    if obs.exists():
        for line in obs.read_text().splitlines():
            r=json.loads(line)
            if r['kind']=='first_seen':
                old=canonical[r['timeframe']].get(r['row'][0])
                if old is not None and old!=r['row']:raise ValueError('Conflicting first-seen ledger')
                canonical[r['timeframe']].setdefault(r['row'][0],r['row'])
    summary={}
    for tf in ('1m','5m'):
        dest=folder/f'provider_{tf}.json';step=timedelta(minutes=1 if tf=='1m' else 5)
        existing={r[0]:r for r in read(dest)['candles']} if dest.exists() else {}
        for t,r in canonical[tf].items():
            if t in existing and existing[t]!=r:raise ValueError('Cache differs from immutable observation')
            existing[t]=r
        base=read(Path(bound['baseline'][tf]['path']))['candles']
        start=stamp(base[-1][0])+step
        cursor=max(start,stamp(max(existing))-timedelta(minutes=10)) if existing else start
        end=cutoff.replace(second=0,microsecond=0)
        if tf=='5m':end=end.replace(minute=end.minute//5*5)
        pages=0
        while cursor<end:
            body=request(tf,cursor,end,key);received=now()
            rows=validate_rows(body,tf,cursor,end)
            for row in rows:
                old=existing.get(row[0])
                if old is None:
                    append(obs,dict(kind='first_seen',observedAt=iso(received),timeframe=tf,row=row));existing[row[0]]=row
                elif old!=row:append(obs,dict(kind='revision_not_applied',observedAt=iso(received),timeframe=tf,original=old,revision=row))
            pages+=1
            if not rows or len(rows)<5000:break
            cursor=stamp(rows[-1][0])+step
            if pages>=30:raise ProviderFailure('Catch-up page limit reached; audit required')
        candles=[r for t,r in sorted(existing.items())]
        atomic(dest,dict(source='Twelve Data proxy, not Bybit',retrievedAt=iso(now()),timeframe=tf,candles=candles))
        summary[tf]=dict(candles=len(candles),latestOpen=candles[-1][0] if candles else None,pages=pages)
    append(folder/'fetch_runs.jsonl',dict(observedAt=iso(now()),results=summary))
    return summary

def replay_cache(parent,state,bound):
    e=importlib.import_module('accept01_engine');s=importlib.import_module('state01_capture')
    folder=DATA/'ACG_ACCEPT01';t=now()
    bars=e.load('5m',bound,folder,t);fine=e.load('1m',bound,folder,t)
    result=e.process(bars,fine,parent,folder,t)
    # Explicitly bind source/output directories only; feature formulas remain sealed.
    s.SOURCE=folder;s.OUT=DATA/'ACG_STATE01'
    companion=s.capture(state,bound,now())
    return result,companion,bars,fine

def once():
    parent,state,bound=verify();initialize(parent)
    folder=DATA/'ACG_ACCEPT01';lock=folder/'collection.lock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY);os.close(fd)
    try:
        t=now();start=stamp(parent['cohortStartUTC']);ready=folder/'readiness.json'
        if t>=start and not ready.exists():raise ValueError('No cloud readiness before cohort boundary; version a future boundary')
        key=os.environ.get('TWELVE_DATA_API_KEY')
        if not key:raise ProviderFailure('Configured market-data key missing')
        fetch=pull(parent,bound,folder,key)
        verify()
        result,companion,bars,fine=replay_cache(parent,state,bound)
        t=now()
        if t<start:
            from accept01_engine import session
            if not bars or not fine or not session(t) or (t-bars[-1].end).total_seconds()>390 or (t-fine[-1].end).total_seconds()>150:
                raise ProviderFailure('Warm-up source is stale or outside research session')
            if not ready.exists():atomic(ready,dict(observedAt=iso(t),status='Cloud one-shot readiness only; inspect service heartbeat for continuity'))
        append(folder/'operations.jsonl',dict(observedAt=iso(t),status='success',result=result,companion=companion))
        atomic(DATA/'heartbeat.json',dict(observedAt=iso(t),status='success',latest5mClose=bars[-1].end.isoformat(),latest1mClose=fine[-1].end.isoformat(),companion=companion))
        print(json.dumps(dict(status='success',observedAt=iso(t),result=result,companion=companion,
            latest5mClose=bars[-1].end.isoformat(),latest1mClose=fine[-1].end.isoformat(),fetch=fetch,
            volumeMounted=os.path.ismount(DATA),storageIdentity=read(DATA/'storage_identity.json'),
            observationLedgerBytes=(folder/'candle_observations.jsonl').stat().st_size,
            readinessEstablished=ready.exists())),flush=True)
    except Exception as exc:
        append(folder/'operations.jsonl',dict(observedAt=iso(now()),status='failure',errorType=type(exc).__name__,reason=str(exc)))
        raise
    finally:lock.unlink()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');parser.add_argument('--serve',action='store_true');args=parser.parse_args()
    if not args.once and not args.serve:verify();print('Frozen cloud inputs verified; no collection started');return
    if args.once:once();return
    if os.environ.get('ACG_CONTINUOUS_CAPTURE')!='ENABLED':raise ValueError('Continuous mode requires explicit activation flag')
    if str(DATA)=='/data' and not os.path.ismount(DATA):raise ValueError('Persistent /data volume is not mounted')
    verify()
    while True:
        from accept01_engine import session
        if session(now()):
            try:once()
            except ProviderFailure:print('Provider failure recorded; retry next polling slot',flush=True)
        else:
            verify();initialize({});atomic(DATA/'heartbeat.json',dict(observedAt=iso(now()),status='research_session_closed'))
        time.sleep(max(1,30-time.time()%30))

if __name__=='__main__':main()
