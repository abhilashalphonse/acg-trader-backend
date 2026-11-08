'use strict';

// India/NSE distribution is on hold until the required market-data licence is secured.
// Keep stored instrument and trading records intact; only customer discovery is gated.
function isPausedIndiaInstrument(instrument, indiaEnabled = false) {
  if (indiaEnabled || !instrument) return false;
  const mappings = instrument.providerMappings;
  const accelpix = mappings instanceof Map ? mappings.get('accelpix') : mappings?.accelpix;
  return Boolean(accelpix)
    || (String(instrument.assetClass || '').toUpperCase() === 'EQUITY'
      && String(instrument.timezone || '').toLowerCase() === 'asia/kolkata');
}

module.exports = { isPausedIndiaInstrument };
