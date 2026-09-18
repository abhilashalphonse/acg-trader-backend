'use strict';

const express = require('express');
const { Instrument } = require('./instrument.model');
const { serializeInstrument } = require('./instrument-catalog.service');
const { isInstrumentSessionOpen } = require('./session-calendar');
const { normalizeSymbol } = require('../market-data/market.utils');
const { AppError } = require('../../shared/errors/app-error');

function createInstrumentRouter({ identityService } = {}) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const nowMs = Date.now();
    const instruments = await Instrument.find({ chartEnabled: true }).sort({ assetClass: 1, symbol: 1 }).lean();
    res.json({
      asOf: new Date(nowMs).toISOString(),
      instruments: instruments.map(document => ({ ...serializeInstrument(document), sessionOpen: isInstrumentSessionOpen(document, nowMs) })),
    });
  });

  router.get('/:symbol/identity', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const instrument = await Instrument.findOne({ symbol }).lean();
    if (!instrument) {
      throw new AppError(`Instrument not found: ${symbol || req.params.symbol}`, { statusCode: 404, code: 'INSTRUMENT_NOT_FOUND' });
    }

    const identity = identityService
      ? await identityService.resolve(instrument)
      : {
          provider: null,
          status: 'UNAVAILABLE',
          logoUrl: null,
          baseLogoUrl: null,
          quoteLogoUrl: null,
          checkedAt: null,
        };

    res.setHeader('Cache-Control', identity.status === 'READY' ? 'public, max-age=86400' : 'public, max-age=900');
    res.json({ symbol: instrument.symbol, identity });
  });

  router.get('/:symbol', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const instrument = await Instrument.findOne({ symbol }).lean();
    if (!instrument) {
      throw new AppError(`Instrument not found: ${symbol || req.params.symbol}`, { statusCode: 404, code: 'INSTRUMENT_NOT_FOUND' });
    }
    const nowMs = Date.now();
    res.json({
      asOf: new Date(nowMs).toISOString(),
      instrument: { ...serializeInstrument(instrument), sessionOpen: isInstrumentSessionOpen(instrument, nowMs) },
    });
  });

  return router;
}

module.exports = { createInstrumentRouter };
