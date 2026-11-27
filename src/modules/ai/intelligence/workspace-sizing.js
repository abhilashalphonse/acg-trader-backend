'use strict';
// Narrow, explicit calculation intent. No inferred stop distance, trade side,
// symbol, risk basis, or order authority. All sizing values are decimal strings.
const {normalizeDecimal,multiplyDecimal,divideDecimal,compareDecimal,quantizeToStep,subtractDecimal,addDecimal,ROUNDING}=require('../../../shared/decimal/decimal');
const {calculateRequiredMargin}=require('../../trading/execution-planner');
const {calculateCommission}=require('../../trading/trading-costs');
const min=(...v)=>v.reduce((a,b)=>compareDecimal(a,b)<=0?a:b);
function positive(v){try{if(v==null||!Number.isFinite(Number(v))||Number(v)>1e15||compareDecimal(v,'0')<=0)return null;return normalizeDecimal(v);}catch{return null;}}
function parseSizingQuestion(question,symbol){
  if(typeof question!=='string'||!symbol||!/\b(?:lot size|position size|position sizing|how many lots)\b/i.test(question))return null;
  // Require exactly one explicit percentage, one explicit pip distance, and
  // a named selected instrument (or unambiguous current-chart wording).
  const rates=[...question.matchAll(/(?:^|[^\d.])(\d{1,3}(?:\.\d{1,6})?)\s*%/g)];
  const stops=[...question.matchAll(/(?:^|[^\d.])(\d{1,5}(?:\.\d{1,6})?)\s*[- ]?\s*pips?\b/gi)];
  if(/[-−]\s*\d+(?:\.\d+)?\s*(?:%|[- ]?\s*pips?\b)/i.test(question)||rates.length!==1||stops.length!==1||!/\b(?:stop loss|stop-loss|SL)\b/i.test(question))return {status:'NEEDS_EXPLICIT_RISK_AND_STOP'};
  const names=[...question.matchAll(/\b[A-Z][A-Z0-9]{4,11}\b/g)].map(m=>m[0]);
  if(names.some(x=>x!==symbol)||(!names.includes(symbol)&&!/\b(?:current chart|current instrument|selected instrument)\b/i.test(question)))return {status:'NEEDS_SELECTED_SYMBOL'};
  const balance=/\bbalance\b/i.test(question),equity=/\bequity\b/i.test(question);
  if(balance===equity)return {status:'NEEDS_RISK_BASIS'};
  const riskPercent=positive(rates[0][1]),stopPips=positive(stops[0][1]);
  if(!riskPercent||!stopPips||compareDecimal(riskPercent,'100')>0)return {status:'INVALID_RISK_OR_STOP'};
  return {status:'PARSED',riskPercent,stopPips,basis:balance?'balance':'equity'};
}
function sizingEvidence({question,market,account}){
  const intent=parseSizingQuestion(question,market?.symbol);
  if(!intent)return null;
  const base={method:'ACG_DECIMAL_SIZING_V1',executionAllowed:false,symbol:market.symbol};
  if(intent.status!=='PARSED')return {...base,...intent};
  const {riskPercent,stopPips,basis}=intent,i=market.instrument?.sizingSpecifications;
  const fail=status=>({...base,riskPercent,stopPips,basis,status});
  const capital=positive(account?.state?.[basis]),free=positive(account?.state?.freeMargin);
  const pip=positive(i?.pipSize),contract=positive(i?.contractSize),step=positive(i?.volumeStep),minVolume=positive(i?.minVolume),maxVolume=positive(i?.maxVolume);
  if(!capital||!account?.currency)return fail('ACCOUNT_CONTEXT_UNAVAILABLE');
  if(!pip||!contract||!step||!minVolume||!maxVolume||compareDecimal(minVolume,maxVolume)>0)return fail('INSTRUMENT_SPECIFICATIONS_UNAVAILABLE');
  if(i.pnlCurrency!==account.currency)return fail('CROSS_CURRENCY_RISK_NOT_SUPPORTED');
  try{
    const plannedRisk=divideDecimal(multiplyDecimal(capital,riskPercent),'100');
    const stopDistance=multiplyDecimal(stopPips,pip);
    const lossPerLot=multiplyDecimal(stopDistance,contract);
    const theoreticalLots=divideDecimal(plannedRisk,lossPerLot,{scale:12,rounding:ROUNDING.DOWN});
    const cap=positive(account.riskPolicy?.maxPositionVolume);
    const riskRounded=quantizeToStep(min(theoreticalLots,maxVolume,...(cap?[cap]:[])),step,ROUNDING.DOWN);
    const riskLimitedLots=compareDecimal(riskRounded,minVolume)<0?'0':riskRounded;
    const result={...base,status:'PRE_COST_ESTIMATE',riskPercent,stopPips,basis,capital,plannedRisk,stopDistance,
      pipSize:pip,contractSize:contract,lossPerLot,volumeStep:step,minVolume,maxVolume,accountCurrency:account.currency,
      theoreticalLots,riskLimitedLots,estimatedStopLoss:multiplyDecimal(lossPerLot,riskLimitedLots),
      accountSnapshotMayBeStale:true,accountUpdatedAt:account.updatedAt,freeMargin:account?.state?.freeMargin??null,
      marginStatus:'RECENT_SESSION_VERIFIED_QUOTE_REQUIRED',limitations:['HYPOTHETICAL_NOT_ORDER_APPROVAL','STOP_FILL_NOT_GUARANTEED','OTHER_ACCOUNT_RISK_LIMITS_NOT_EVALUATED']};
    const q=market.quote;
    if(q?.status!=='RECENT_PROVIDER_EVENT'||!positive(q.ask)||!positive(q.bid))return result;
    if(i.marginCurrency!==account.currency||i.quoteCurrency!==account.currency)return {...result,marginStatus:'CROSS_CURRENCY_MARGIN_NOT_SUPPORTED'};
    if(!positive(account.leverage)||!positive(i.defaultLeverage)||!free)return {...result,marginStatus:'LEVERAGE_OR_FREE_MARGIN_UNAVAILABLE'};
    // Use ask as conservative notional reference for either side; apply the
    // actual trading-engine margin formula, commission schedule and lot step.
    const price=normalizeDecimal(q.ask);
    const marginPerLot=calculateRequiredMargin({account,instrument:i,volume:'1',fillPrice:price});
    const commissionPerSide=calculateCommission(i,'1',{account,fillPrice:price});
    const roundTripCommission=multiplyDecimal(commissionPerSide,'2');
    const costAdjustedLoss=addDecimal(lossPerLot,roundTripCommission);
    const spreadCost=multiplyDecimal(subtractDecimal(normalizeDecimal(q.ask),normalizeDecimal(q.bid)),contract);
    const initialCollateralPerLot=addDecimal(addDecimal(marginPerLot,commissionPerSide),spreadCost);
    if(!positive(marginPerLot)||compareDecimal(commissionPerSide,'0')<0||!positive(initialCollateralPerLot))return {...result,marginStatus:'MARGIN_CALCULATION_UNAVAILABLE'};
    const byRisk=divideDecimal(plannedRisk,costAdjustedLoss,{scale:12,rounding:ROUNDING.DOWN});
    const byMargin=divideDecimal(free,initialCollateralPerLot,{scale:12,rounding:ROUNDING.DOWN});
    const bounded=quantizeToStep(min(riskLimitedLots,byRisk,byMargin),step,ROUNDING.DOWN);
    const lots=compareDecimal(bounded,minVolume)<0?'0':bounded;
    return {...result,status:'HYPOTHETICAL_COST_AND_MARGIN_ESTIMATE',marginStatus:'ESTIMATED_FROM_SNAPSHOT',
      quoteReferencePrice:price,quoteObservedAtMs:q.observedAtMs,marginPerLot,roundTripCommissionPerLot:roundTripCommission,
      estimatedOpeningSpreadCostPerLot:spreadCost,marginLimitedLots:quantizeToStep(byMargin,step,ROUNDING.DOWN),
      estimatedLots:lots,estimatedRiskAtLots:multiplyDecimal(lots,costAdjustedLoss),
      estimatedRequiredMargin:multiplyDecimal(lots,marginPerLot),
      estimatedInitialCollateral:multiplyDecimal(lots,initialCollateralPerLot),
      limitations:[...result.limitations,'COMMISSION_ESTIMATED_AT_OBSERVED_PRICE','NO_SLIPPAGE_OR_GAP_ESTIMATE','FREE_MARGIN_IS_PERSISTED_NOT_LIVE']};
  }catch{return fail('CALCULATION_UNAVAILABLE');}
}
module.exports={parseSizingQuestion,sizingEvidence};
