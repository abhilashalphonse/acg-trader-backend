'use strict';
// Transport receipt time is not the market event time. A late or repeated
// provider event must not become fresh merely because it arrived just now.
// Preserve the existing receipt-age fallback for legacy timestamp-less feeds;
// AI's stricter evidence gate independently rejects missing/invalid event time.
function quoteAgeMs(quote,now=Date.now()){
  const received=quote?.receivedAtMs;
  if(!Number.isFinite(received)||received<=0)return Infinity;
  const provider=quote?.providerTimestampMs;
  const effective=Number.isFinite(provider)&&provider>0?Math.min(received,provider):received;
  return Math.max(0,now-effective);
}
module.exports={quoteAgeMs};
