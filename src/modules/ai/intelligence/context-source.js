'use strict';
const mongoose=require('mongoose');
const {Instrument}=require('../../instruments/instrument.model');
const {Candle}=require('../../market-data/candle.model');
const {mapValue,defaultTwelveDataSymbol,decimalToNumber}=require('../../market-data/market.utils');
const {TIMEFRAME_MS}=require('../../market-data/market.constants');
const read=q=>q.read('primary').readConcern('majority').maxTimeMS(1500).lean();
// Deliberately bypass historyService: it can call providers and hydrate state.
// This port only reads configured runtime quotes and persisted Mongo rows.
function createMarketContextSource(runtime){
  return Object.freeze({
    async instrument(symbol){
      if(runtime?.enabled!==true||!runtime.symbols?.includes(symbol))return null;
      const live=runtime.instrumentRegistry.get(symbol);
      const doc=await read(Instrument.findOne({symbol}).select('symbol status chartEnabled quoteCurrency timezone tradingSessions tradingHolidays sessionOverrides scheduleVersion providerMappings maxQuoteAgeMs assetClass digits pipSize tickSize contractSize defaultLeverage'));
      if(!doc||!live?.configured||doc.status!=='ACTIVE'||doc.chartEnabled!==true||live.status!=='ACTIVE'||live.chartEnabled!==true)return null;
      const acc=mapValue(doc.providerMappings,'accelpix');
      const provider=acc?'accelpix':'twelve-data';
      const providerSymbol=acc||mapValue(doc.providerMappings,'twelveData')||mapValue(doc.providerMappings,'twelve-data')||defaultTwelveDataSymbol(symbol);
      if(provider!==live.provider||providerSymbol!==live.providerSymbol||doc.maxQuoteAgeMs!==live.maxQuoteAgeMs)return null;
      return {...doc,provider,providerSymbol};
    },
    quote(symbol){return runtime.quoteStore.get(symbol);},
    async candles({symbol,timeframe,asOfMs,limit}){
      if(!runtime.timeframes?.includes(timeframe))throw Error('Unsupported runtime timeframe');
      const rows=await read(Candle.find({symbol,timeframe,openTime:mongoose.trusted({$lte:new Date(asOfMs)})})
        .select('symbol timeframe openTime closeTime open high low close complete synthetic source provider')
        .sort({openTime:-1}).limit(limit));
      return rows.reverse().map(row=>({symbol:row.symbol,timeframe:row.timeframe,
        openTimeMs:row.openTime instanceof Date?row.openTime.getTime():NaN,
        closeTimeMs:row.closeTime instanceof Date?row.closeTime.getTime():NaN,
        open:decimalToNumber(row.open),high:decimalToNumber(row.high),low:decimalToNumber(row.low),close:decimalToNumber(row.close),
        complete:row.complete,synthetic:row.synthetic,source:row.source,provider:row.provider}));
    },
  });
}
module.exports={createMarketContextSource};
