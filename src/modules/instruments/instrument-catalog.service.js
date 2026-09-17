'use strict';

const { Instrument } = require('./instrument.model');
const { ACG_INSTRUMENT_CATALOG } = require('./instrument-catalog');

async function ensureInstrumentCatalog({ logger } = {}) {
  const operations = ACG_INSTRUMENT_CATALOG.map(spec => ({
    updateOne: {
      filter: { symbol: spec.symbol },
      update: { $setOnInsert: spec },
      upsert: true,
    },
  }));

  if (!operations.length) return { inserted: 0 };
  const result = await Instrument.bulkWrite(operations, { ordered: false });
  const inserted = Number(result.upsertedCount || 0);
  logger?.info?.({ inserted, catalogSize: ACG_INSTRUMENT_CATALOG.length }, 'Instrument catalog ensured');
  return { inserted };
}

async function syncInstrumentCatalog({ logger } = {}) {
  const operations = ACG_INSTRUMENT_CATALOG.map(spec => {
    const { executionEnabled, status, ...managedSpec } = spec;
    return {
      updateOne: {
        filter: { symbol: spec.symbol },
        update: {
          $set: managedSpec,
          $setOnInsert: { executionEnabled, status },
        },
        upsert: true,
      },
    };
  });

  if (!operations.length) return { matched: 0, modified: 0, inserted: 0 };
  const result = await Instrument.bulkWrite(operations, { ordered: false });
  const summary = {
    matched: Number(result.matchedCount || 0),
    modified: Number(result.modifiedCount || 0),
    inserted: Number(result.upsertedCount || 0),
  };
  logger?.info?.({ ...summary, catalogSize: ACG_INSTRUMENT_CATALOG.length }, 'Instrument catalog synchronized');
  return summary;
}

function serializeInstrument(document) {
  if (!document) return null;
  const doc = typeof document.toObject === 'function' ? document.toObject() : document;
  const decimal = value => value == null ? null : String(value?.toString?.() ?? value);
  const providerMappings = doc.providerMappings instanceof Map
    ? Object.fromEntries(doc.providerMappings.entries())
    : { ...(doc.providerMappings || {}) };

  return {
    id: String(doc._id),
    symbol: doc.symbol,
    displaySymbol: doc.displaySymbol,
    name: doc.name,
    assetClass: doc.assetClass,
    baseCurrency: doc.baseCurrency,
    quoteCurrency: doc.quoteCurrency,
    pnlCurrency: doc.pnlCurrency || doc.quoteCurrency,
    marginCurrency: doc.marginCurrency || doc.quoteCurrency,
    digits: doc.digits,
    tickSize: decimal(doc.tickSize),
    pipSize: decimal(doc.pipSize),
    contractSize: decimal(doc.contractSize),
    minVolume: decimal(doc.minVolume),
    maxVolume: decimal(doc.maxVolume),
    volumeStep: decimal(doc.volumeStep),
    defaultLeverage: doc.defaultLeverage,
    marginRate: decimal(doc.marginRate),
    commissionPerLot: decimal(doc.commissionPerLot),
    swapLong: decimal(doc.swapLong),
    swapShort: decimal(doc.swapShort),
    spread: {
      mode: doc.spread?.mode || 'MARKET',
      fixedPoints: decimal(doc.spread?.fixedPoints),
      markupPoints: decimal(doc.spread?.markupPoints),
    },
    tradingSessions: doc.tradingSessions || [],
    tradingHolidays: doc.tradingHolidays || [],
    timezone: doc.timezone,
    providerMappings,
    maxQuoteAgeMs: doc.maxQuoteAgeMs,
    chartEnabled: doc.chartEnabled,
    executionEnabled: doc.executionEnabled,
    status: doc.status,
  };
}

module.exports = { ensureInstrumentCatalog, syncInstrumentCatalog, serializeInstrument };
