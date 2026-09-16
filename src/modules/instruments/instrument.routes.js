'use strict';

const express = require('express');
const { Instrument } = require('./instrument.model');
const { serializeInstrument } = require('./instrument-catalog.service');
const { normalizeSymbol } = require('../market-data/market.utils');
const { AppError } = require('../../shared/errors/app-error');

function createInstrumentRouter() {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const instruments = await Instrument.find({ chartEnabled: true })
      .sort({ assetClass: 1, symbol: 1 })
      .lean();
    res.json({ instruments: instruments.map(serializeInstrument) });
  });

  router.get('/:symbol', async (req, res) => {
    const symbol = normalizeSymbol(req.params.symbol);
    const instrument = await Instrument.findOne({ symbol }).lean();
    if (!instrument) {
      throw new AppError(`Instrument not found: ${symbol || req.params.symbol}`, {
        statusCode: 404,
        code: 'INSTRUMENT_NOT_FOUND',
      });
    }
    res.json({ instrument: serializeInstrument(instrument) });
  });

  return router;
}

module.exports = { createInstrumentRouter };
