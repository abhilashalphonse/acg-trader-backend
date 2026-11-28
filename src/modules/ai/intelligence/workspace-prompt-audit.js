'use strict';
// Measure the exact final provider message content, not an earlier snapshot.
// This is local, deterministic byte accounting; provider usage reports only
// aggregate prompt tokens. Never persist the message strings or their values.
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const fields=Object.freeze(['System','Question','History','Knowledge','Account','Candles','Analysis','QuoteSession','Calendar','Instrument','Metadata']);
const profiles=new Set(['STRUCTURE','MARKET_OVERVIEW','BOS','FVG','LIQUIDITY','QUOTE','SESSION','CALENDAR']);
function measureWorkspacePrompt(body){
  if(typeof body?.messages?.[0]?.content!=='string'||typeof body?.messages?.[1]?.content!=='string')throw Error('Invalid workspace audit input');
  const system=body.messages[0].content,user=body.messages[1].content,data=JSON.parse(user);
  const market=data.market,frames=market?.frames??[];
  const result=Object.fromEntries(fields.map(f=>['aiPrompt'+f+'Bytes',0]));
  const add=(field,value)=>{
    if(value!==undefined&&value!==null)result['aiPrompt'+field+'Bytes']+=bytes(value);
  };
  result.aiPromptSystemBytes=Buffer.byteLength(system,'utf8');
  for(const [field,key] of [['Question','question'],['History','history'],['Knowledge','knowledge'],['Account','account']])add(field,data[key]);
  for(const f of frames){
    for(const k of ['closedCandles','activeCandle','candleColumns'])add('Candles',f[k]);
    for(const k of ['observations','advanced','quoteRangeLocation','closedPriceContext'])add('Analysis',f[k]);
  }
  for(const k of ['quote','quoteStatus','sessionClocks','sessionRanges','sessionRangeTimeframe','previousClosedDailyBar','observedUtcDayRange'])add('QuoteSession',market?.[k]);
  add('Calendar',market?.economicCalendar);
  add('Instrument',market?.instrument);
  add('Analysis',market?.sizingCalculation);
  const total=Buffer.byteLength(system,'utf8')+Buffer.byteLength(user,'utf8');
  // Each counted value is a disjoint subtree of the canonical JSON message.
  // Residual includes keys, separators, frame quality/coverage, omission
  // markers, shared limitations and any future unclassified fields.
  result.aiPromptMetadataBytes=total-fields.reduce((n,f)=>n+result['aiPrompt'+f+'Bytes'],0);
  if(result.aiPromptMetadataBytes<0||JSON.stringify(data)!==user)throw Error('Noncanonical workspace audit input');
  return Object.freeze({...result,aiPromptAuditVersion:1,aiPromptContentBytes:total,
    aiPromptWireBytes:bytes(body),aiPromptSchemaBytes:bytes(body.response_format??null),
    aiPromptFrameCount:frames.length,aiPromptCandleCount:frames.reduce((n,f)=>n+(f.closedCandles?.length??0),0),
    aiPromptObservationCount:frames.reduce((n,f)=>n+(f.observations?.length??0),0),
    aiPromptHistoryCount:data.history.length,aiPromptProfile:profiles.has(market?.contextSelection?.profile)?market.contextSelection.profile:'FULL'});
}
module.exports={measureWorkspacePrompt,fields};
