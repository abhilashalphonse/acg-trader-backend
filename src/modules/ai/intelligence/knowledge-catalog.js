'use strict';
const {digest,freeze}=require('./candle-evidence');
// Original ACG engineering descriptions. Not imported strategy material,
// third-party documents, model memory or an externally verified trading edge.
const KNOWLEDGE_VERSION='acg-knowledge-v1';
const entries=[
  ['EVIDENCE_QUALITY','Evidence quality and scope','market-facts-v1',
    'Use only eligible closed bars for historical analysis. Missing or synthetic bars interrupt continuity. Recent closed bars are not live executable prices. Configured calendar agreement is not independent venue, coverage or provider-identity verification.'],
  ['MARKET_STRUCTURE','Structure and confirmation','structure-liquidity-v1',
    'A strict swing requires two lower highs or higher lows on each side. Confirmation occurs only after the second right candle closes. Initial close break establishes descriptive direction; a later continuation is BOS, an opposite break is MSS_PROXY. No displacement or predictive validation.'],
  ['LIQUIDITY','Potential liquidity references','structure-liquidity-v1',
    'Confirmed swing levels and exactly equal consecutive same-side swings are potential references, not evidence of resting orders. A sweep proxy opens on or inside a reference, trades strictly beyond it and closes strictly inside. A sweep is not proof of institutional activity.'],
  ['FVG','Three-bar gap geometry','structure-liquidity-v1',
    'Strict non-overlap of the first and third candle wicks forms a zone at the third close. Later observed near-edge touch, partial depth, distal touch and close-based invalidation are distinct. OHLC cannot prove fills, intrabar sequence or complete mitigation.'],
  ['SESSION_RANGE','Explicit time-window ranges','explicit-session-range-v1',
    'Session reports use explicit UTC bucket-aligned windows, not verified London, Asian or New York market sessions. Missing elapsed buckets qualify the observed range. Mixed providers suppress the range.'],
  ['MULTI_TIMEFRAME','Cross-timeframe structure','cross-timeframe-structure-v1',
    'Alignment requires at least two qualified frames for the same symbol and as-of time. Direction means observed break history, not a forecast or probability. Mixed or insufficient frames must not be recast as directional certainty.'],
  ['INDICATORS','Deterministic price indicators','market-facts-v1',
    'SMA_20 is the arithmetic mean of twenty eligible closes. MEAN_TRUE_RANGE_14 is a simple mean of fourteen true ranges using fifteen eligible bars; it is not Wilder ATR. The contiguous input segment defines the observed range.'],
  ['RISK_BOUNDARY','Financial and execution boundary','phase-1-read-only',
    'Analysis grants no execution authority. Do not represent historical facts as executable quotes, promise returns, fabricate position sizing or claim account risk is known without authoritative account and instrument inputs. Manual trading remains independent.'],
];
const catalog=freeze(entries.map(([id,title,methodVersion,text])=>{
  const item={id,title,methodVersion,text,version:1,origin:'ACG_INTERNAL_ORIGINAL',reviewStatus:'ENGINEERING_DRAFT',distribution:'INTERNAL_ONLY'};
  return {...item,knowledgeId:digest(item)};
}));
const byId=new Map(catalog.map(x=>[x.id,x]));
const core=['EVIDENCE_QUALITY','RISK_BOUNDARY'];
const profiles=freeze({
  MARKET_OVERVIEW:['MARKET_STRUCTURE','INDICATORS','MULTI_TIMEFRAME'],
  STRUCTURE:['MARKET_STRUCTURE','LIQUIDITY','FVG','MULTI_TIMEFRAME'],
  SESSION:['SESSION_RANGE','MARKET_STRUCTURE'],
  EDUCATION:['MARKET_STRUCTURE','LIQUIDITY','FVG','SESSION_RANGE','MULTI_TIMEFRAME','INDICATORS'],
});
function selectKnowledge(profile){
  if(typeof profile!=='string'||!Object.hasOwn(profiles,profile))throw Object.assign(Error('Unsupported knowledge profile'),{code:'KNOWLEDGE_PROFILE_INVALID'});
  return freeze({version:KNOWLEDGE_VERSION,profile,entries:[...core,...profiles[profile]].map(id=>byId.get(id))});
}
module.exports={selectKnowledge,KNOWLEDGE_VERSION,PROFILES:Object.freeze(Object.keys(profiles))};
