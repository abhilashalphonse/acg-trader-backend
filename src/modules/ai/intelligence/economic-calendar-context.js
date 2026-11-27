'use strict';
const {symbolAffectedByEvent}=require('../../trading/trading-permission-policy.service');
const HOUR=3600000,DAY=24*HOUR;
const dateMs=v=>typeof v==='string'||v instanceof Date?Date.parse(v):NaN;
const iso=ms=>Number.isFinite(ms)?new Date(ms).toISOString():null;
const statusSet=new Set(['FRESH','VALID_GRACE','PENDING_VALIDATION','EXPIRED','UNAVAILABLE']);
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v)?v:null;
function cleanTitle(value){
  if(typeof value!=='string')return null;
  const s=value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160);
  return s||null;
}
function projectEconomicCalendar({snapshot,market,nowMs=Date.now()}={}){
  const base={source:'EXISTING_HIGH_IMPACT_CALENDAR',asOfMs:nowMs,scope:'SELECTED_INSTRUMENT_RELATED_EVENTS',
    dataStatus:'UNAVAILABLE',coverageFrom:null,coverageTo:null,fetchedAt:null,events:[],omittedEvents:0,
    interpretation:'SCHEDULE_ONLY_NOT_REALIZED_NEWS_OR_TRADING_PERMISSION'};
  if(!snapshot||!market?.symbol||!Number.isSafeInteger(nowMs)||!statusSet.has(snapshot.dataStatus))return base;
  const from=dateMs(snapshot.coverageFrom),to=dateMs(snapshot.coverageTo),fetched=dateMs(snapshot.fetchedAt);
  const result={...base,dataStatus:snapshot.dataStatus,coverageFrom:iso(from),coverageTo:iso(to),fetchedAt:iso(fetched)};
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||!Number.isFinite(fetched)||fetched>nowMs||
    nowMs<from||nowMs>=to||!Array.isArray(snapshot.events)||snapshot.events.length>500){
    return {...result,dataStatus:'UNAVAILABLE'};
  }
  if(!['FRESH','VALID_GRACE','PENDING_VALIDATION'].includes(result.dataStatus))return result;
  const i=market.instrument||{},symbol=market.symbol;
  const windowStart=Math.max(from,nowMs-6*HOUR),windowEnd=Math.min(to,nowMs+DAY);
  const candidates=[];
  for(const event of snapshot.events){
    if(event?.impact!=='HIGH')continue;
    const title=cleanTitle(event.title),c=currency(event.currency);
    if(!title)continue;
    const policyRelated=symbolAffectedByEvent(symbol,i,event);
    const related=policyRelated||c!==null&&(c===i.quoteCurrency||c===i.baseCurrency);
    if(!related)continue;
    const allDay=event.allDay===true;
    const time=dateMs(event.timestamp);
    const day=typeof event.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(event.date)?dateMs(event.date+'T00:00:00Z'):NaN;
    if(allDay||!Number.isFinite(time)){
      if(!Number.isFinite(day)||day>=windowEnd||day+DAY<=windowStart)continue;
      candidates.push({title,currency:c,date:iso(day).slice(0,10),timestamp:null,allDay,
        timing:'NO_VERIFIED_INTRADAY_TIME',sort:Math.max(day,windowStart)});
      continue;
    }
    if(time<windowStart||time>=windowEnd)continue;
    candidates.push({title,currency:c,timestamp:iso(time),allDay:false,
      timing:time<nowMs?'SCHEDULED_TIME_PASSED':'UPCOMING',minutesFromNow:Math.trunc((time-nowMs)/60000),sort:time});
  }
  const nearest=candidates.sort((a,b)=>Math.abs(a.sort-nowMs)-Math.abs(b.sort-nowMs)||a.sort-b.sort);
  result.events=nearest.slice(0,6).sort((a,b)=>a.sort-b.sort).map(({sort,...event})=>event);
  result.omittedEvents=Math.max(0,nearest.length-result.events.length);
  result.windowFrom=iso(windowStart);result.windowTo=iso(windowEnd);
  result.officialBlsCrossCheck=snapshot.verification?.officialBls==='AVAILABLE'?'AVAILABLE':'NOT_ESTABLISHED';
  result.upstreamDiscrepancy=snapshot.verification?.upstreamDiscrepancy===true;
  result.noMatchingEventsInCoveredWindow=result.dataStatus==='FRESH'&&!result.upstreamDiscrepancy&&nearest.length===0;
  return result;
}
function attachEconomicCalendar(market,readCalendar,nowMs=Date.now()){
  if(!market)return null;
  let snapshot=null;
  try{snapshot=typeof readCalendar==='function'?readCalendar(nowMs):null;}catch{}
  const economicCalendar=projectEconomicCalendar({snapshot,market,nowMs});
  return {...market,economicCalendar,limitations:[...(market.limitations||[]).filter(x=>x!=='NO_NEWS_CONTEXT'),
    'SCHEDULED_HIGH_IMPACT_EVENTS_ONLY','NO_LIVE_NEWS_OR_RELEASE_ACTUALS']};
}
module.exports={projectEconomicCalendar,attachEconomicCalendar};
