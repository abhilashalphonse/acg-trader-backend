'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarize}=require('../scripts/ai-workspace-benchmark');
test('benchmark groups actual successful usage, separates missing timing from zero, and estimates cost',()=>{
 const out=summarize([
   {aiOutcome:'ANSWERED',aiIntent:'STRUCTURE',aiInputTokens:3000,aiOutputTokens:400,aiDurationMs:4000,aiStreamRequested:true,aiDeltaCount:5,aiFirstDeltaMs:1200,aiAccountUsed:false},
   {aiOutcome:'ANSWERED',aiIntent:'STRUCTURE',aiInputTokens:4000,aiOutputTokens:200,aiDurationMs:6000,aiStreamRequested:true,aiDeltaCount:0,aiFirstDeltaMs:null,aiAccountUsed:false},
   {aiOutcome:'ANSWERED',aiInputTokens:8000,aiOutputTokens:500},
   {aiOutcome:'FAILED',aiInputTokens:123,aiOutputTokens:456},
   {aiOutcome:'ANSWERED',aiInputTokens:-1,aiOutputTokens:0}
 ]);
 assert.equal(out.ALL.successfulRequests,3);
 assert.equal(out.STRUCTURE.inputTokens.mean,3500);
 assert.equal(out.STRUCTURE.durationMs.p95,6000);
 assert.deepEqual(out.STRUCTURE.firstDeltaMs,{n:1,mean:1200,p50:1200,p95:1200});
 assert.equal(out.STRUCTURE.estimatedMeanCostUsd,0.0005);
 assert.equal(out.STRUCTURE.accountUsageKnownCount,2);
 assert.equal(out.STRUCTURE.accountUsedCount,0);
 assert.equal(out.UNCLASSIFIED.durationMs,null);
 assert.equal(out.UNCLASSIFIED.firstDeltaMs,null);
 assert.deepEqual(summarize([]),{});
});
