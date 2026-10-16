'use strict';

const express = require('express');
const { AppError } = require('../../shared/errors/app-error');

function createIdentityRouter(identityService) {
  const router = express.Router();
  router.post('/bootstrap', async (req, res) => {
    const header = String(req.headers.authorization || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1] || match[1].length > 16384) throw new AppError('Identity access token is required', {
      statusCode: 401, code: 'IDENTITY_TOKEN_REQUIRED',
    });
    const result = await identityService.bootstrap(match[1]);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  });
  return router;
}

module.exports = { createIdentityRouter };
