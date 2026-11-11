import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from datetime import datetime, timedelta
import accept01_engine as e

COST=dict(spread=.5,slippage=.1,commission=0)
T=datetime(2026,11,16,9,tzinfo=e.UTC)

def candle(t,step=e.M,op=102,hi=103,lo=101,cl=102):
    return e.Candle(t,t+step,op,hi,lo,cl)

class RecorderTests(unittest.TestCase):
    def test_timeliness_boundary(self):
        self.assertFalse(e.timing(T,T+timedelta(seconds=90))['lateObservation'])
        self.assertTrue(e.timing(T,T+timedelta(seconds=91))['lateObservation'])
        with self.assertRaises(ValueError):e.timing(T,T-e.M)

    def test_duplicate_record_preserves_arrival(self):
        with TemporaryDirectory() as d:
            path=Path(d)/'events.jsonl'
            a=e.Journal(path,T+e.M)
            a.emit('x',dict(kind='decision',decision='enter'),T)
            b=e.Journal(path,T+10*e.M)
            row=b.emit('x',dict(kind='decision',decision='enter'),T)
            self.assertEqual(row['observedAt'],(T+e.M).isoformat())
            self.assertEqual(b.new,0)
            self.assertEqual(len(path.read_text().splitlines()),1)
            with self.assertRaisesRegex(ValueError,'consistency'):
                b.emit('x',dict(kind='decision',decision='reject'),T)

    def test_acceptance_exact_third_bar_and_missing(self):
        bars={T+k*e.FIVE:candle(T+k*e.FIVE,e.FIVE,cl=101) for k in range(3)}
        self.assertTrue(e.acceptance(bars,T,1,100,1)['accepted'])
        bars.pop(T+e.FIVE)
        self.assertIsNone(e.acceptance(bars,T,1,100,1))

    def test_short_acceptance(self):
        bars={T+k*e.FIVE:candle(T+k*e.FIVE,e.FIVE,cl=99) for k in range(3)}
        self.assertTrue(e.acceptance(bars,T,-1,100,1)['accepted'])

    def test_stop_floor_and_invalid_entry(self):
        terms=e.entry_terms(102,1,100,1,5,COST)
        self.assertEqual(terms['riskPerOunce'],5)
        self.assertAlmostEqual(terms['target']-terms['entryFillProxy'],7.5)
        self.assertIsNone(e.entry_terms(99,1,100,1,5,COST))

    def test_ambiguous_stop_first_long_and_short(self):
        for side in (1,-1):
            terms=dict(entryFillProxy=100,stop=100-side*2,target=100+side*3,riskPerOunce=2)
            rows={T:candle(T,op=100,hi=105,lo=95)}
            result=e.settle(T,side,terms,rows,T+e.M,COST)
            self.assertEqual(result['exitReason'],'ambiguous')
            self.assertAlmostEqual(result['netR'],-1.05)

    def test_stop_gap_and_target_gap(self):
        terms=dict(entryFillProxy=100,stop=98,target=103,riskPerOunce=2)
        result=e.settle(T,1,terms,{T:candle(T,op=95,hi=96,lo=94)},T+e.M,COST)
        self.assertEqual(result['exitReason'],'stop_gap')
        self.assertAlmostEqual(result['exitFillProxy'],94.65)
        result=e.settle(T,1,terms,{T:candle(T,op=105,hi=106,lo=104)},T+e.M,COST)
        self.assertEqual(result['exitFillProxy'],103)

    def test_missing_candle_blocks_outcome(self):
        terms=dict(entryFillProxy=100,stop=90,target=115,riskPerOunce=10)
        result=e.settle(T,1,terms,{},T+e.M,COST)
        self.assertEqual(result['status'],'data_gap')

    def test_no_future_bar_and_120_minute_timeout(self):
        terms=dict(entryFillProxy=100,stop=90,target=115,riskPerOunce=10)
        rows={T+k*e.M:candle(T+k*e.M,op=100,hi=101,lo=99,cl=100) for k in range(120)}
        self.assertEqual(e.settle(T,1,terms,rows,T,COST)['status'],'open')
        result=e.settle(T,1,terms,rows,T+120*e.M,COST)
        self.assertEqual(result['exitAt'],(T+120*e.M).isoformat())
        self.assertEqual(result['exitReason'],'time')

    def test_same_bucket_exclusion(self):
        closed=dict(status='closed',exitEvidenceBarOpen=(T+2*e.M).isoformat())
        self.assertTrue(e.busy(closed,T))
        self.assertFalse(e.busy(closed,T+e.FIVE))
        self.assertTrue(e.busy(dict(status='data_gap'),T))

    def test_common_horizon_and_costs(self):
        rows={T+k*e.M:candle(T+k*e.M,op=100,hi=102,lo=99,cl=101) for k in range(120)}
        result=e.diagnostic(T,1,1,True,rows,T+120*e.M,{'central':COST})
        self.assertEqual(result['begin'],(T+15*e.M).isoformat())
        self.assertAlmostEqual(result['netUSDPerOunce']['central'],.3)
        rows.pop(T+30*e.M)
        self.assertEqual(e.diagnostic(T,1,1,True,rows,T+120*e.M,{'central':COST})['status'],'data_gap')

    def test_pipeline_a_stops_b_enters_and_arrivals(self):
        bars=[candle(T+k*e.FIVE,e.FIVE) for k in range(45)]
        bars[14]=candle(T+14*e.FIVE,e.FIVE,op=100,hi=102,lo=99,cl=102)
        bars[17]=candle(T+17*e.FIVE,e.FIVE,op=102,hi=104,lo=101,cl=103)
        signal=bars[14].end
        fine=[candle(T+k*e.M) for k in range(300)]
        fine[75]=candle(signal,op=102,hi=103,lo=98,cl=99)
        proto=dict(cohortStartUTC=T.isoformat(),costScenarios={'central':COST})
        breaks=[(14,1,'BOS',SimpleNamespace(price=100.5),None)]
        with TemporaryDirectory() as d,patch.object(e,'structure',return_value=([],breaks)),patch.object(e,'wilder_atr',return_value=[1]*len(bars)):
            directory=Path(d)
            now=signal+timedelta(seconds=70)
            e.process([b for b in bars if b.end<=now],[b for b in fine if b.end<=now],proto,directory,now)
            now=signal+15*e.M+timedelta(seconds=80)
            e.process([b for b in bars if b.end<=now],[b for b in fine if b.end<=now],proto,directory,now)
            rows=e.Journal(directory/'events.jsonl',now).rows
            sid=signal.isoformat()+'/long'
            self.assertFalse(rows[sid+'/signal']['lateObservation'])
            self.assertFalse(rows[sid+'/acceptance']['lateObservation'])
            self.assertEqual(rows[sid+'/central/A/outcome']['exitReason'],'stop')
            self.assertEqual(rows[sid+'/central/B/decision']['entryScheduledAt'],(signal+15*e.M).isoformat())
            self.assertFalse(rows[sid+'/central/B/decision']['lateObservation'])
            now=signal+140*e.M
            e.process([b for b in bars if b.end<=now],[b for b in fine if b.end<=now],proto,directory,now)
            rows=e.Journal(directory/'events.jsonl',now).rows
            self.assertEqual(rows[sid+'/diagnostic']['status'],'complete')
            count=len(rows)
            e.process([b for b in bars if b.end<=now],[b for b in fine if b.end<=now],proto,directory,now)
            self.assertEqual(len(e.Journal(directory/'events.jsonl',now).rows),count)

    def test_late_first_processing_is_not_backdated(self):
        with TemporaryDirectory() as d:
            journal=e.Journal(Path(d)/'events.jsonl',T+20*e.M)
            for name,event in [('A',T),('B',T+15*e.M)]:
                self.assertTrue(journal.emit(name,dict(kind='decision'),event)['lateObservation'])

if __name__=='__main__':unittest.main(verbosity=2)
