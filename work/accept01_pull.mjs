// Read-only provider requests. No broker orders, account mutations, or credential output.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'outputs','ACG_ACCEPT01');
const {execFileSync}=await import('node:child_process');
execFileSync(process.env.ACG_ACCEPT_PYTHON??'python',[path.join(root,'work','accept01_run.py'),'--verify-only'],{stdio:'pipe'});
const manifest=JSON.parse(await fs.readFile(path.join(dir,'protocol.json'),'utf8'));
const backend='C:/Users/Abhil/Documents/GitHub/acg-trader-backend';
const require=createRequire(backend+'/package.json');
require('dotenv').config({path:backend+'/.env',quiet:true});
const key=process.env.TWELVE_DATA_API_KEY;
if(!key)throw new Error('Configured Twelve Data credential unavailable');
const cutoff=Date.now();
const iso=n=>new Date(n).toISOString();
const dateArg=n=>iso(n).slice(0,19).replace('T',' ');
const results={};
for(const tf of ['1m','5m']){
 const step=tf==='1m'?60000:300000;
 const dest=path.join(dir,`provider_${tf}.json`);
 let previous={candles:[]};
 try{previous=JSON.parse(await fs.readFile(dest,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const base=JSON.parse(await fs.readFile(manifest.baseline[tf].path,'utf8'));
 const startBase=Date.parse(base.candles.at(-1)[0])+step;
 const existing=new Map(previous.candles.map(r=>[r[0],r]));
 let cursor=Math.max(startBase,previous.candles.length?Date.parse(previous.candles.at(-1)[0])-10*60000:startBase);
 const end=Math.floor(cutoff/step)*step;
 let pages=0;
 while(cursor<end){
   const url=new URL('https://api.twelvedata.com/time_series');
   url.search=new URLSearchParams({symbol:'XAU/USD',interval:tf==='1m'?'1min':'5min',timezone:'UTC',order:'asc',outputsize:'5000',start_date:dateArg(cursor),end_date:dateArg(end-1000),apikey:key});
   let response,body;
   try{response=await fetch(url,{signal:AbortSignal.timeout(25000)});body=await response.json();}
   catch{throw new Error('Provider network request failed; no credentials logged');}
   if(!response.ok||body.status==='error'||!Array.isArray(body.values))throw new Error('Provider request failed with status '+String(body.code??response.status));
   assert.equal(body.meta?.symbol,'XAU/USD');
   const receivedAt=iso(Date.now());
   const rows=body.values.map(v=>{
     const t=Date.parse(v.datetime.replace(' ','T')+'Z');
     const ohlc=[v.open,v.high,v.low,v.close].map(Number);
     assert.ok(Number.isFinite(t)&&t%step===0&&t>=cursor&&t<end);
     assert.ok(ohlc.every(Number.isFinite)&&ohlc[2]>0&&ohlc[1]>=Math.max(ohlc[0],ohlc[3])&&ohlc[2]<=Math.min(ohlc[0],ohlc[3]));
     return [iso(t),...ohlc];
   }).sort((a,b)=>a[0].localeCompare(b[0]));
   const observations=[];
   for(const row of rows){
     const old=existing.get(row[0]);
     if(!old){existing.set(row[0],row);observations.push({kind:'first_seen',observedAt:receivedAt,timeframe:tf,row});}
     else if(JSON.stringify(old)!==JSON.stringify(row))observations.push({kind:'revision_not_applied',observedAt:receivedAt,timeframe:tf,original:old,revision:row});
   }
   if(observations.length){const fh=await fs.open(path.join(dir,'candle_observations.jsonl'),'a');try{await fh.appendFile(observations.map(r=>JSON.stringify(r)).join('\n')+'\n');await fh.sync();}finally{await fh.close();}}
   pages++;
   if(!rows.length||rows.length<5000)break;
   const next=Date.parse(rows.at(-1)[0])+step;
   assert.ok(next>cursor);cursor=next;
   if(pages>=30)throw new Error('Catch-up exceeds safe page limit; manual data audit required');
 }
 const candles=[...existing.values()].sort((a,b)=>a[0].localeCompare(b[0]));
 const payload={source:'Twelve Data XAU/USD reference candles, NOT Bybit quotes',retrievedAt:iso(Date.now()),timeframe:tf,fields:['openTime','open','high','low','close'],candles};
 await fs.writeFile(dest+'.tmp',JSON.stringify(payload));
 await fs.rename(dest+'.tmp',dest);
 results[tf]={candles:candles.length,latestOpen:candles.at(-1)?.[0]??null,pages,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
}
await fs.appendFile(path.join(dir,'fetch_runs.jsonl'),JSON.stringify({observedAt:iso(Date.now()),results})+'\n');
console.log(JSON.stringify({status:'fetched',results}));
