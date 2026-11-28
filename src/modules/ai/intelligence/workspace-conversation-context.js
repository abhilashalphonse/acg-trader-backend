'use strict';
// Conversation history is untrusted, already bounded and scoped by the
// workspace caller. Never synthesize memory, reinterpret financial levels,
// or turn historical assistant statements into verified market observations.
const HISTORY_TARGET_BYTES=6144;
const bytes=history=>Buffer.byteLength(JSON.stringify(history),'utf8');
const isPair=(a,b)=>a?.role==='user'&&b?.role==='assistant';
function dropOldestExchange(history){
  if(!history.length)return false;
  // A client may submit a suffix starting with an assistant. Remove that
  // orphan as one message; otherwise remove a complete exchange together.
  history.splice(0,isPair(history[0],history[1])?2:1);
  return true;
}
function protectedTailSize(history){
  if(!history.length)return 0;
  // Preserve the latest complete exchange verbatim if the suffix is ordered.
  return isPair(history.at(-2),history.at(-1))?2:1;
}
function compactWorkspaceHistory(history){
  const selected=history.map(m=>({role:m.role,text:m.text}));
  const tail=protectedTailSize(selected);
  // Only evict older history under pressure; the latest exchange may exceed
  // the soft target. No summaries, keyword extraction or numeric rounding.
  while(selected.length>tail&&bytes(selected)>HISTORY_TARGET_BYTES){
    const count=isPair(selected[0],selected[1])?2:1;
    if(selected.length-count<tail)break;
    dropOldestExchange(selected);
  }
  return selected;
}
module.exports={compactWorkspaceHistory,dropOldestExchange,protectedTailSize,HISTORY_TARGET_BYTES};
