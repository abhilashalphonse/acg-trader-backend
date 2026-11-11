import json,math
from datetime import datetime,timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase,main
from unittest.mock import patch
import state01_capture as s
T=datetime(2026,11,16,10,tzinfo=s.UTC);U=T+3*s.FIVE
COST={'central':dict(spread=.5,slippage=.1,commission=0),'stress':dict(spread=1,slippage=.25,commission=.06)}

def inputs(side=1):
    candles={}
    for k in range(49):
        op=U-(49-k)*s.FIVE;c=100+k*side
        candles[op]=dict(row=[op.isoformat(),c-side,c+1,c-1,c],observedAt=(op+s.FIVE+timedelta(seconds=20)).isoformat())
    signal=dict(signalId='signal',kind='signal',signalAt=T.isoformat(),ATR=2.,side=side,level=145 if side==1 else 55,
                observedAt=(T+timedelta(seconds=30)).isoformat(),lateObservation=False)
    distance=side*(candles[U-s.FIVE]['row'][4]-signal['level'])/2
    update=dict(signalId='signal',kind='acceptance_update',eventTime=U.isoformat(),distanceATR=distance,accepted=distance>=1,
                observedAt=(U+timedelta(seconds=40)).isoformat(),lateObservation=False)
    return signal,update,candles

class StateTests(TestCase):
    def test_momentum_windows_efficiency(self):
        sig,up,c=inputs();f=s.features(sig,up,c,COST)
        self.assertEqual(f['candidate']['momentum15ATR'],1.5)
        self.assertEqual(f['candidate']['momentum60ATR'],6)
        self.assertEqual(f['descriptive']['momentum240ATR'],24)
        self.assertEqual(f['candidate']['efficiency60'],1)
        self.assertEqual(f['candidate']['agreement15_60'],'with_BOS')

    def test_no_future_candle_in_features(self):
        sig,up,c=inputs();before=s.features(sig,up,c,COST)
        c[U]=dict(row=[U.isoformat(),1,1e9,0,1e9],observedAt=(U+s.FIVE).isoformat())
        self.assertEqual(before,s.features(sig,up,c,COST))

    def test_short_normalization(self):
        sig,up,c=inputs(-1);f=s.features(sig,up,c,COST)
        self.assertEqual(f['candidate']['momentum15ATR'],1.5)
        self.assertEqual(f['candidate']['agreement15_60'],'with_BOS')

    def test_missing_primary_window(self):
        sig,up,c=inputs();del c[U-7*s.FIVE]
        self.assertEqual(s.features(sig,up,c,COST)['status'],'missing_primary_window')

    def test_optional_240_missing_does_not_remove_primary(self):
        sig,up,c=inputs();del c[U-48*s.FIVE]
        f=s.features(sig,up,c,COST)
        self.assertEqual(f['status'],'complete');self.assertIsNone(f['descriptive']['momentum240ATR'])

    def test_cost_ratio_redundancy(self):
        sig,up,c=inputs();f=s.features(sig,up,c,COST)
        self.assertAlmostEqual(f['candidate']['modeledRoundTripCostToATR']['central'],.7*f['baseline']['inversePriorATR'])
        self.assertAlmostEqual(f['candidate']['modeledRoundTripCostToATR']['stress'],1.56*f['baseline']['inversePriorATR'])

    def test_acceptance_consistency(self):
        sig,up,c=inputs();up['distanceATR']+=.01
        with self.assertRaisesRegex(ValueError,'price mismatch'):s.features(sig,up,c,COST)

    def test_zero_efficiency_denominator(self):
        sig,up,c=inputs()
        for v in c.values():v['row'][1:]=[148,148,148,148]
        self.assertEqual(s.features(sig,up,c,COST)['status'],'zero_path_denominator')

    def test_record_idempotency_and_mutation_detection(self):
        with TemporaryDirectory() as d:
            p=Path(d)/'events';a=s.Store(p);a.emit('x',{'feature':1},U)
            b=s.Store(p);b.emit('x',{'feature':1},U+s.FIVE)
            self.assertEqual(len(p.read_text().splitlines()),1)
            self.assertEqual(b.rows['x']['recordedAt'],U.isoformat())
            with self.assertRaisesRegex(ValueError,'changed'):b.emit('x',{'feature':2},U)

    def test_outcome_horizon_and_first_hit_ambiguity(self):
        sig,up,c=inputs();minutes={}
        for j in range(105):
            t=U+j*s.MINUTE
            minutes[t]=dict(row=[t.isoformat(),100,103,97,101],observedAt=(t+s.MINUTE).isoformat())
        end=T+120*s.MINUTE
        self.assertIsNone(s.label(sig,up,minutes,end-s.MINUTE))
        label=s.label(sig,up,minutes,end)
        self.assertEqual(label['remainingSignedATR'],.5)
        self.assertEqual(label['firstHit_1ATR'],'ambiguous')
        self.assertEqual(label['targetEnd'],end.isoformat())
        del minutes[U+20*s.MINUTE]
        self.assertIsNone(s.label(sig,up,minutes,end))

    def test_arrival_time_labels_duplicates_and_mature_outcome(self):
        sig,up,c=inputs();minutes={}
        for j in range(105):
            t=U+j*s.MINUTE
            minutes[t]=dict(row=[t.isoformat(),148,149,147,148],observedAt=(t+s.MINUTE).isoformat())
        with TemporaryDirectory() as d:
            root=Path(d);source=root/'parent';source.mkdir();out=root/'state';out.mkdir()
            (source/'events.jsonl').write_text(json.dumps(sig)+'\n'+json.dumps(up)+'\n')
            p=dict(cohortStartUTC=(T-s.FIVE).isoformat());parent=dict(costScenarios=COST)
            with patch.object(s,'SOURCE',source),patch.object(s,'OUT',out),patch.object(s,'first_seen',return_value={'5m':c,'1m':minutes}):
                result=s.capture(p,parent,U+timedelta(seconds=90))
                self.assertEqual(result['newFeatures'],1)
                f=json.loads((out/'features.jsonl').read_text());self.assertTrue(f['timelyPrimary'])
                result=s.capture(p,parent,T+120*s.MINUTE)
                self.assertEqual(result['newFeatures'],0);self.assertEqual(result['newLabels'],1)
                result=s.capture(p,parent,T+121*s.MINUTE)
                self.assertEqual(result['newLabels'],0)
                self.assertEqual(len((out/'features.jsonl').read_text().splitlines()),1)

    def test_late_capture_is_preserved_as_late(self):
        sig,up,c=inputs()
        with TemporaryDirectory() as d:
            root=Path(d);(root/'events.jsonl').write_text(json.dumps(sig)+'\n'+json.dumps(up)+'\n')
            with patch.object(s,'SOURCE',root),patch.object(s,'OUT',root),patch.object(s,'first_seen',return_value={'5m':c,'1m':{}}):
                s.capture(dict(cohortStartUTC=(T-s.FIVE).isoformat()),dict(costScenarios=COST),U+timedelta(seconds=91))
                row=json.loads((root/'features.jsonl').read_text());self.assertFalse(row['timelyPrimary'])

if __name__=='__main__':main(verbosity=2)
