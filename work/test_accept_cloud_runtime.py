import json
from datetime import datetime,timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase,main
from unittest.mock import patch
import accept_cloud_runtime as c
T=datetime(2026,11,11,9,tzinfo=c.UTC)

def payload(tf,cursor,end,revision=False):
    step=timedelta(minutes=1 if tf=='1m' else 5);rows=[];t=cursor
    while t<end:
        cl=102 if revision and tf=='1m' and t==T+5*timedelta(minutes=1) else 101
        rows.append(dict(datetime=t.strftime('%Y-%m-%d %H:%M:%S'),open='100',high='103',low='99',close=str(cl)));t+=step
    return dict(meta=dict(symbol='XAU/USD'),values=rows)

class CloudTests(TestCase):
    def test_frozen_hashes_and_path_map(self):
        p,state,bound=c.verify()
        for tf in ('1m','5m'):
            self.assertEqual(c.sha(Path(bound['baseline'][tf]['path'])),p['baseline'][tf]['sha256'])
        self.assertEqual(p['strategies'],bound['strategies'])
        self.assertEqual(p['costScenarios'],bound['costScenarios'])

    def test_timestamp_and_geometry_validation(self):
        b=payload('1m',T,T+timedelta(minutes=2))
        rows=c.validate_rows(b,'1m',T,T+timedelta(minutes=2))
        self.assertEqual(rows[0],[c.iso(T),100,103,99,101])
        b['values'][0]['low']='102'
        with self.assertRaises(c.ProviderFailure):c.validate_rows(b,'1m',T,T+timedelta(minutes=2))

    def test_wrong_symbol_or_future_bar_rejected(self):
        b=payload('1m',T,T+timedelta(minutes=2));b['meta']['symbol']='EUR/USD'
        with self.assertRaises(c.ProviderFailure):c.validate_rows(b,'1m',T,T+timedelta(minutes=2))
        b=payload('1m',T,T+timedelta(minutes=2))
        with self.assertRaises(c.ProviderFailure):c.validate_rows(b,'1m',T,T+timedelta(minutes=1))

    def test_revision_and_cache_crash_recovery(self):
        with TemporaryDirectory() as d:
            folder=Path(d);bound={'baseline':{}}
            for tf in ('1m','5m'):
                path=folder/(tf+'.json');base=T if tf=='1m' else T-timedelta(minutes=5)
                path.write_text(json.dumps(dict(candles=[[c.iso(base),100,103,99,101]])))
                bound['baseline'][tf]=dict(path=str(path))
            end=T+timedelta(minutes=10,seconds=3)
            with patch.object(c,'now',return_value=end),patch.object(c,'request',side_effect=lambda tf,a,b,key:payload(tf,a,b)):
                c.pull({},bound,folder,'NOT_A_REAL_CREDENTIAL')
            observations=[json.loads(x) for x in (folder/'candle_observations.jsonl').read_text().splitlines()]
            first_count=sum(x['kind']=='first_seen' for x in observations)
            (folder/'provider_1m.json').unlink()
            with patch.object(c,'now',return_value=end+timedelta(seconds=30)),patch.object(c,'request',side_effect=lambda tf,a,b,key:payload(tf,a,b,True)):
                c.pull({},bound,folder,'NOT_A_REAL_CREDENTIAL')
            later=[json.loads(x) for x in (folder/'candle_observations.jsonl').read_text().splitlines()]
            self.assertEqual(sum(x['kind']=='first_seen' for x in later),first_count)
            self.assertTrue(any(x['kind']=='revision_not_applied' for x in later))
            rows=c.read(folder/'provider_1m.json')['candles']
            self.assertEqual(next(r[4] for r in rows if r[0]==c.iso(T+timedelta(minutes=5))),101)

    def test_storage_identity_and_metadata_guard(self):
        with TemporaryDirectory() as d:
            data=Path(d)/'data'
            with patch.object(c,'DATA',data):
                c.initialize({});c.initialize({})
                (data/'ACG_ACCEPT01/protocol.json').write_text('{}')
                with self.assertRaisesRegex(ValueError,'metadata'):c.initialize({})

    def test_network_error_never_echoes_key_or_url(self):
        with patch.object(c,'urlopen',side_effect=RuntimeError('secret in URL')):
            with self.assertRaises(c.ProviderFailure) as error:c.request('1m',T,T+timedelta(minutes=1),'SENSITIVE_TEST_VALUE')
        self.assertNotIn('SENSITIVE_TEST_VALUE',str(error.exception));self.assertNotIn('https://',str(error.exception))

if __name__=='__main__':main(verbosity=2)
