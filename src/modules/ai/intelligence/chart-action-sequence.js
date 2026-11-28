'use strict';
// Bounded, deterministic, direct-user chart-only sequencing. No model text,
// price geometry or financial actions can expand the permitted vocabulary.
const ORDER=Object.freeze({
 LIQUIDITY:Object.freeze(['LIQUIDITY_REFERENCE']),
 FVG:Object.freeze(['FVG_ZONE']),
 LIQUIDITY_THEN_FVG:Object.freeze(['LIQUIDITY_REFERENCE','FVG_ZONE']),
 FVG_THEN_LIQUIDITY:Object.freeze(['FVG_ZONE','LIQUIDITY_REFERENCE'])
});
function planChartActionSequence(command,registry){
 if(typeof command!=='string'||!Object.hasOwn(ORDER,command)||typeof registry?.list!=='function')throw new TypeError('Unsupported chart action sequence');
 const kinds=ORDER[command],candidates=registry.list({limit:20});
 const perKind=kinds.length===1?6:3;
 const ids=new Set(),actions=[];
 for(const kind of kinds){
  for(const c of candidates.filter(c=>c.kind===kind).slice(0,perKind)){
   if(ids.has(c.sourceId))throw new Error('Duplicate chart action');
   ids.add(c.sourceId);actions.push(Object.freeze({action:'draw',sourceId:c.sourceId}));
  }
 }
 return Object.freeze(actions);
}
module.exports={planChartActionSequence};
