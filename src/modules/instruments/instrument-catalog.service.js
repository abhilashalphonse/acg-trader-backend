'use strict';

const { Instrument } = require('./instrument.model');
const { ACG_INSTRUMENT_CATALOG } = require('./instrument-catalog');

const EXECUTION_PROVISION_VERSION = 1;

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

async function enforceCatalogLeveragePolicy({ logger } = {}) {
  if (!ACG_INSTRUMENT_CATALOG.length) return { matched: 0, modified: 0 };

  const operations = ACG_INSTRUMENT_CATALOG.map(spec => ({
    updateOne: {
      filter: { symbol: spec.symbol },
      update: { $set: { defaultLeverage: spec.defaultLeverage } },
      upsert: false,
    },
  }));

  const result = await Instrument.bulkWrite(operations, { ordered: false });
  const summary = {
    matched: Number(result.matchedCount || 0),
    modified: Number(result.modifiedCount || 0),
  };
  logger?.info?.({ ...summary, leverage: 100 }, 'Catalog leverage policy enforced');
  return summary;
}

async function provisionCatalogExecution({ logger } = {}) {
  if (!ACG_INSTRUMENT_CATALOG.length) return { matched: 0, modified: 0 };

  // Do not use symbol: { $in: [...] } here. The symbol schema uses Mongoose's
  // uppercase string setter, which attempts to cast the query-operator object
  // itself as a string during updateMany(). Exact-string filters avoid that
  // casting path while keeping schema normalization and operator safety intact.
  const operations = ACG_INSTRUMENT_CATALOG.map(spec => ({
    updateOne: {
      filter: {
        symbol: spec.symbol,
        $or: [
          { executionProvisionVersion: { $exists: false } },
          { executionProvisionVersion: { $lt: EXECUTION_PROVISION_VERSION } },
        ],
      },
      update: {
        $set: {
          executionEnabled: true,
          executionProvisionVersion: EXECUTION_PROVISION_VERSION,
        },
      },
      upsert: false,
    },
  }));

  const result = await Instrument.bulkWrite(operations, { ordered: false });
  const summary = {
    matched: Number(result.matchedCount || 0),
    modified: Number(result.modifiedCount || 0),
  };
  logger?.info?.({ ...summary, executionProvisionVersion: EXECUTION_PROVISION_VERSION }, 'Catalog execution provisioning verified');
  return summary;
}

async function syncInstrumentCatalog({ logger } = {}) {
  const operations = ACG_INSTRUMENT_CATALOG.map(spec => {
    const { executionEnabled: _catalogExecutionDefault, status, ...managedSpec } = spec;
    return {
      updateOne: {
        filter: { symbol: spec.symbol },
        update: {
          $set: managedSpec,
          $setOnInsert: { executionEnabled: true, status, executionProvisionVersion: EXECUTION_PROVISION_VERSION },
        },
        upsert: true,
      },
    };
  });

  if (!operations.length) return { matched: 0, modified: 0, inserted: 0, executionProvisioned: 0 };
  const result = await Instrument.bulkWrite(operations, { ordered: false });

  // One-time launch migration: catalog instruments created before execution
  // provisioning were intentionally seeded disabled. Enable each exactly once,
  // then preserve any later operator disable/halt decision on future restarts.
  const provision = await provisionCatalogExecution({ logger });

  const summary = {
    matched: Number(result.matchedCount || 0),
    modified: Number(result.modifiedCount || 0),
    inserted: Number(result.upsertedCount || 0),
    executionProvisioned: Number(provision.modified || 0),
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
    identity: doc.identity ? {
      provider: doc.identity.provider || null,
      status: doc.identity.status || 'UNKNOWN',
      logoUrl: doc.identity.logoUrl || null,
      baseLogoUrl: doc.identity.baseLogoUrl || null,
      quoteLogoUrl: doc.identity.quoteLogoUrl || null,
      checkedAt: doc.identity.checkedAt ? new Date(doc.identity.checkedAt).toISOString() : null,
    } : null,
    softQuoteAgeMs: doc.softQuoteAgeMs,
    maxQuoteAgeMs: doc.maxQuoteAgeMs,
    chartEnabled: doc.chartEnabled,
    executionEnabled: doc.executionEnabled,
    executionProvisionVersion: Number(doc.executionProvisionVersion || 0),
    status: doc.status,
  };
}

module.exports = {
  ensureInstrumentCatalog,
  syncInstrumentCatalog,
  provisionCatalogExecution,
  enforceCatalogLeveragePolicy,
  serializeInstrument,
  EXECUTION_PROVISION_VERSION,
};
