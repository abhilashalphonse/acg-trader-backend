'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { TraderProfile } = require('./trader-profile.model');

class TraderProfileService {
  constructor({ profileModel = TraderProfile } = {}) {
    this.profileModel = profileModel;
  }

  async getProfile(principal) {
    const identity = profileIdentity(principal);
    const record = await this.profileModel.findOne({
      tenantId: identity.tenantId,
      principalKey: identity.principalKey,
    }).lean();

    return publicProfile(record, identity);
  }

  async updateProfile(principal, patch) {
    const identity = profileIdentity(principal);
    const update = {
      displayName: String(patch.displayName || '').trim(),
      shareTemplate: patch.shareTemplate,
      sharePhotoDataUrl: patch.sharePhotoDataUrl || null,
      ownerExternalRef: identity.ownerExternalRef,
    };

    const record = await this.profileModel.findOneAndUpdate(
      { tenantId: identity.tenantId, principalKey: identity.principalKey },
      {
        $set: update,
        $setOnInsert: {
          tenantId: identity.tenantId,
          principalKey: identity.principalKey,
        },
      },
      { new: true, upsert: true, runValidators: true },
    ).lean();

    return publicProfile(record, identity);
  }
}

function profileIdentity(principal) {
  const tenantId = required(principal?.tenantId, 'tenantId');
  const ownerExternalRef = optional(principal?.ownerExternalRef);
  const firstAccountId = Array.isArray(principal?.accountIds) ? optional(principal.accountIds[0]) : null;
  if (!ownerExternalRef && !firstAccountId) {
    throw new AppError('Trader profile identity is unavailable', {
      statusCode: 400,
      code: 'TRADER_PROFILE_IDENTITY_UNAVAILABLE',
    });
  }

  return {
    tenantId,
    ownerExternalRef,
    principalKey: ownerExternalRef ? `owner:${ownerExternalRef}` : `account:${firstAccountId}`,
  };
}

function publicProfile(record, identity) {
  return {
    displayName: String(record?.displayName || 'Trader'),
    sharePhotoDataUrl: record?.sharePhotoDataUrl || null,
    shareTemplate: record?.shareTemplate === 'PHOTO' ? 'PHOTO' : 'PERFORMANCE',
    ownerExternalRef: identity.ownerExternalRef,
    updatedAt: record?.updatedAt ? new Date(record.updatedAt).toISOString() : null,
  };
}

function required(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new AppError(`${field} is required`, { statusCode: 400, code: 'TRADER_PROFILE_IDENTITY_UNAVAILABLE' });
  return text;
}

function optional(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

module.exports = { TraderProfileService, profileIdentity, publicProfile };
