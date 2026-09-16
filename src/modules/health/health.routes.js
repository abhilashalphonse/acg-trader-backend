'use strict';

const express = require('express');
const { databaseHealth } = require('../../config/database');

const router = express.Router();

router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'acg-trader-backend',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

router.get('/ready', (_req, res) => {
  const database = databaseHealth();
  const ready = database.connected;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database,
    timestamp: new Date().toISOString(),
  });
});

module.exports = { healthRouter: router };
