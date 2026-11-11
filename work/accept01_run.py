"""Verified, locked, on-demand collection. No scheduler or broker order API."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[1]
DIR=ROOT/'outputs/ACG_ACCEPT01'

def verify():
    def check(path,expected):
        actual=hashlib.sha256(path.read_bytes()).hexdigest()
        if actual!=expected:
            raise ValueError(f'Hash mismatch {path.name}: expected {expected}, actual {actual}')
    check(DIR/'protocol.json',(DIR/'protocol.sha256').read_text().strip())
    check(DIR/'manifest.json',(DIR/'manifest.sha256').read_text().strip())
    manifest=json.loads((DIR/'manifest.json').read_text())
    for name,digest in manifest['files'].items():
        check(ROOT/name,digest)
    protocol=json.loads((DIR/'protocol.json').read_text())
    for spec in protocol['baseline'].values():
        check(Path(spec['path']),spec['sha256'])
    return protocol

def audit(payload):
    with (DIR/'operations.jsonl').open('a',encoding='utf-8') as f:
        f.write(json.dumps(dict(observedAt=datetime.now(timezone.utc).isoformat(),**payload))+'\n')
        f.flush()
        os.fsync(f.fileno())

def main():
    protocol=verify()
    if '--verify-only' in sys.argv:
        print('All protocol, runtime, frozen dependency and baseline hashes verified')
        return
    lock=DIR/'collection.lock'
    fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    os.close(fd)
    try:
        now=datetime.now(timezone.utc)
        start=datetime.fromisoformat(protocol['cohortStartUTC'].replace('Z','+00:00'))
        # Operational readiness is recorded before the boundary. Catch-up after it
        # cannot turn a never-started experiment into a prospective collection.
        readiness=DIR/'readiness.json'
        if now>=start and not readiness.exists():
            raise ValueError('Collector was not operational before boundary; create a separately versioned future protocol')
        proc=subprocess.run(['node',str(ROOT/'work/accept01_pull.mjs')],cwd=ROOT,capture_output=True,text=True,
                            env={**os.environ,'ACG_ACCEPT_PYTHON':sys.executable})
        if proc.returncode:
            # Do not echo raw subprocess output, which could include credentials.
            raise RuntimeError('Provider collection failed; credential-safe failure recorded')
        verify()
        engine=importlib.import_module('accept01_engine')
        now=datetime.now(timezone.utc)
        bars=engine.load('5m',protocol,DIR,now)
        fine=engine.load('1m',protocol,DIR,now)
        result=engine.process(bars,fine,protocol,DIR,now)
        if now<start:
            if not bars or not fine:
                raise ValueError('Warm-up unavailable')
            fresh=(now-bars[-1].end).total_seconds()<=390 and (now-fine[-1].end).total_seconds()<=150
            if not engine.session(now) or not fresh:
                raise ValueError('Pre-boundary readiness requires fresh in-session source data')
            if not readiness.exists():
                with readiness.open('x',encoding='utf-8') as f:
                    json.dump(dict(observedAt=now.isoformat(),status='manual collection verified; no scheduler'),f)
        audit(dict(status='success',result=result))
        print(json.dumps(result))
    except Exception as e:
        audit(dict(status='failure',errorType=type(e).__name__,reason=str(e)))
        raise
    finally:
        lock.unlink()

if __name__=='__main__':
    main()
