'use strict';
const {TextDecoder}=require('node:util');
const {performance}=require('node:perf_hooks');
const LIMITS=Object.freeze({totalBytes:262144,eventBytes:32768,events:1024,chunks:4096,timeoutMs:30000});
function fail(code){throw Object.assign(Error('Provider stream rejected'),{code});}
// Consumes injected fixture bytes only. No network. Overall deadline, not a
// per-chunk reset. Caller cancellation cannot guarantee upstream cancellation.
async function consumeBytes(chunks,{signal,timeoutMs=1000,onText}={}){
  if(!chunks||typeof chunks[Symbol.asyncIterator]!=='function'&&typeof chunks[Symbol.iterator]!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>LIMITS.timeoutMs||typeof onText!=='function')
    fail('INVALID_STREAM');
  if(signal?.aborted)fail('CANCELLED');
  const iterator=typeof chunks[Symbol.asyncIterator]==='function'?chunks[Symbol.asyncIterator]():chunks[Symbol.iterator]();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,count=0,timer,abortHandler,done=false,stopped=false;
  const start=performance.now();
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{stopped=true;reject(Object.assign(Error('Provider stream timeout'),{code:'TIMEOUT'}));},timeoutMs);
    if(signal){
      abortHandler=()=>{stopped=true;reject(Object.assign(Error('Provider stream cancelled'),{code:'CANCELLED'}));};
      signal.addEventListener('abort',abortHandler,{once:true});
      if(signal.aborted)abortHandler();
    }
  });
  try{
    for(;;){
      if(stopped||signal?.aborted)fail('CANCELLED');
      if(performance.now()-start>=timeoutMs)fail('TIMEOUT');
      const item=await Promise.race([Promise.resolve().then(()=>iterator.next()),deadline]);
      if(item.done){done=true;break;}
      if(!(item.value instanceof Uint8Array)||++count>LIMITS.chunks)fail('STREAM_LIMIT');
      bytes+=item.value.byteLength;if(bytes>LIMITS.totalBytes)fail('STREAM_LIMIT');
      await Promise.race([Promise.resolve().then(()=>onText(decoder.decode(item.value,{stream:true}))),deadline]);
    }
    await Promise.race([Promise.resolve().then(()=>onText(decoder.decode())),deadline]);
    if(signal?.aborted)fail('CANCELLED');
    if(performance.now()-start>=timeoutMs)fail('TIMEOUT');
  }finally{
    clearTimeout(timer);if(abortHandler)signal.removeEventListener('abort',abortHandler);
    // Do not wait indefinitely for an uncooperative injected iterator.
    if(!done&&typeof iterator.return==='function')Promise.resolve().then(()=>iterator.return()).catch(()=>{});
  }
}
async function consumeSse(chunks,{signal,timeoutMs,onEvent}={}){
  let pending='',data=[],event=null,eventBytes=0,count=0;
  async function line(value){
    if(value===''){
      if(data.length){
        if(++count>LIMITS.events)fail('STREAM_LIMIT');
        await onEvent({event,data:data.join('\n')});
      }
      data=[];event=null;eventBytes=0;return;
    }
    if(value.startsWith(':'))return;
    const i=value.indexOf(':'),field=i===-1?value:value.slice(0,i);
    let text=i===-1?'':value.slice(i+1);if(text.startsWith(' '))text=text.slice(1);
    if(field==='data'||field==='event'){
      eventBytes+=Buffer.byteLength(text,'utf8');if(eventBytes>LIMITS.eventBytes)fail('STREAM_LIMIT');
      if(field==='data')data.push(text);else event=text;
    }
  }
  await consumeBytes(chunks,{signal,timeoutMs,async onText(text){
    pending+=text;
    // Process CR, LF and CRLF, holding a trailing CR until the next chunk.
    let start=0;
    for(let i=0;i<pending.length;i++){
      if(pending[i]!=='\r'&&pending[i]!=='\n')continue;
      if(pending[i]==='\r'&&i===pending.length-1)break;
      const value=pending.slice(start,i);
      if(Buffer.byteLength(value,'utf8')>LIMITS.eventBytes)fail('STREAM_LIMIT');
      await line(value);
      if(pending[i]==='\r'&&pending[i+1]==='\n')i++;
      start=i+1;
    }
    pending=pending.slice(start);
    if(Buffer.byteLength(pending,'utf8')>LIMITS.eventBytes)fail('STREAM_LIMIT');
  }});
  if(pending.endsWith('\r')){await line(pending.slice(0,-1));pending='';}
  if(pending||data.length||event!==null)fail('TRUNCATED_STREAM');
}
module.exports={consumeBytes,consumeSse,LIMITS};
