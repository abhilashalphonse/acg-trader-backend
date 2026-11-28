'use strict';
// Provider-only, lossless serialization. Apply after existing prompt fitting
// so all budget trimming continues to operate on its established object shape.
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
const profiles=new Set(['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY']);
function packRows(parent,key,minimum){
  const rows=parent?.[key];
  if(!Array.isArray(rows)||rows.length<minimum||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)))return;
  const columns=Object.keys(rows[0]);
  if(!columns.length||rows.some(r=>Object.keys(r).length!==columns.length||columns.some(k=>!Object.hasOwn(r,k))))return;
  const colKey=key+'Columns',rowKey=key+'Rows';
  if(Object.hasOwn(parent,colKey)||Object.hasOwn(parent,rowKey))return;
  const packed=rows.map(r=>columns.map(k=>r[k]));
  // Keep every original value, including null, exact decimal strings,
  // timestamps and original record order. Heterogeneous records stay objects.
  if(bytes({[colKey]:columns,[rowKey]:packed})>=bytes({[key]:rows}))return;
  delete parent[key];parent[colKey]=columns;parent[rowKey]=packed;
}
function compactWorkspaceWireEvidence(market){
  if(market?.schemaVersion!=='adaptive-market-v1'||!profiles.has(market.contextSelection?.profile)||!Array.isArray(market.frames))return;
  for(const f of market.frames){
    // The quality/coverage and exact candle tuple contracts are untouched.
    if(!f.advanced)continue;
    packRows(f.advanced,'displacements',2);
    packRows(f.advanced.liquidity,'levels',3);
  }
  // A schedule digest is an opaque identity, never a price or a proof of
  // coverage. Preserve the exact digest once and reference it from each frame.
  if(Object.hasOwn(market,'sharedScheduleHashes'))return;
  const groups=new Map();
  for(const f of market.frames){
    const c=f.coverage,h=c?.scheduleHash;
    if(typeof h!=='string'||!/^([a-f0-9]{64})$/.test(h)||Object.hasOwn(c,'scheduleHashRef'))continue;
    if(!groups.has(h))groups.set(h,[]);
    groups.get(h).push(c);
  }
  const shared={};
  for(const [h,rows] of groups){
    if(rows.length<2)continue;
    const id='S'+(Object.keys(shared).length+1);
    const before=rows.length*bytes({scheduleHash:h});
    const after=bytes({sharedScheduleHashes:{[id]:h}})+rows.length*bytes({scheduleHashRef:id});
    if(after>=before)continue;
    shared[id]=h;
    for(const c of rows){delete c.scheduleHash;c.scheduleHashRef=id;}
  }
  if(Object.keys(shared).length)market.sharedScheduleHashes=shared;
}
module.exports={compactWorkspaceWireEvidence};
