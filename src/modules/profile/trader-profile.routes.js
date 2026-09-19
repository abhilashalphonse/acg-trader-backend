'use strict';

const express = require('express');
const { z } = require('zod');
const { requireTraderSession } = require('../auth/auth.middleware');

const MAX_PHOTO_DATA_URL_LENGTH = 420000;
const photoDataUrl = z.string()
  .max(MAX_PHOTO_DATA_URL_LENGTH)
  .refine(value => /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value), 'Profile image must be a JPEG, PNG, or WebP data URL');

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  sharePhotoDataUrl: photoDataUrl.nullable(),
  shareTemplate: z.enum(['PERFORMANCE', 'PHOTO']),
}).strict();

function createTraderProfileRouter({ authService, profileService }) {
  const router = express.Router();

  router.get('/', requireTraderSession(authService), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ profile: await profileService.getProfile(req.traderPrincipal) });
  });

  router.put('/', requireTraderSession(authService), async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const error = new Error('Invalid trader profile');
      error.statusCode = 400;
      error.code = 'INVALID_TRADER_PROFILE';
      error.details = parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
      throw error;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ profile: await profileService.updateProfile(req.traderPrincipal, parsed.data) });
  });

  return router;
}

module.exports = { createTraderProfileRouter, updateProfileSchema, MAX_PHOTO_DATA_URL_LENGTH };
