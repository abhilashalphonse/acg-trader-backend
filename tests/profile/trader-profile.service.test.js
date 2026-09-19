'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TraderProfileService, profileIdentity } = require('../../src/modules/profile/trader-profile.service');

function fakeProfileModel(seed = null) {
  let record = seed ? { ...seed } : null;
  return {
    snapshot: () => record ? { ...record } : null,
    findOne(query) {
      return {
        lean: async () => {
          if (!record) return null;
          if (String(record.tenantId) !== String(query.tenantId)) return null;
          if (record.principalKey !== query.principalKey) return null;
          return { ...record };
        },
      };
    },
    findOneAndUpdate(query, update) {
      return {
        lean: async () => {
          record = {
            ...(record || {}),
            ...(update.$setOnInsert || {}),
            ...(update.$set || {}),
            tenantId: query.tenantId,
            principalKey: query.principalKey,
            updatedAt: new Date('2026-09-19T12:00:00.000Z'),
          };
          return { ...record };
        },
      };
    },
  };
}

test('profile identity follows owner across multiple trading accounts', () => {
  const identity = profileIdentity({
    tenantId: 'tenant-1',
    ownerExternalRef: 'funded-user-7',
    accountIds: ['account-1', 'account-2'],
  });
  assert.equal(identity.principalKey, 'owner:funded-user-7');
  assert.equal(identity.ownerExternalRef, 'funded-user-7');
});

test('profile identity falls back to account for native sessions without an owner ref', () => {
  const identity = profileIdentity({ tenantId: 'tenant-1', accountIds: ['account-9'] });
  assert.equal(identity.principalKey, 'account:account-9');
});

test('profile service returns safe defaults before a profile has been created', async () => {
  const service = new TraderProfileService({ profileModel: fakeProfileModel() });
  const profile = await service.getProfile({
    tenantId: 'tenant-1',
    ownerExternalRef: 'owner-1',
    accountIds: ['account-1'],
  });

  assert.equal(profile.displayName, 'Trader');
  assert.equal(profile.sharePhotoDataUrl, null);
  assert.equal(profile.shareTemplate, 'PERFORMANCE');
});

test('profile service persists display identity and share-card preferences', async () => {
  const model = fakeProfileModel();
  const service = new TraderProfileService({ profileModel: model });
  const principal = {
    tenantId: 'tenant-1',
    ownerExternalRef: 'owner-1',
    accountIds: ['account-1'],
  };

  const profile = await service.updateProfile(principal, {
    displayName: 'Nithin Alphonse',
    sharePhotoDataUrl: 'data:image/jpeg;base64,AAAA',
    shareTemplate: 'PHOTO',
  });

  assert.equal(profile.displayName, 'Nithin Alphonse');
  assert.equal(profile.shareTemplate, 'PHOTO');
  assert.equal(profile.sharePhotoDataUrl, 'data:image/jpeg;base64,AAAA');
  assert.equal(model.snapshot().principalKey, 'owner:owner-1');
});
