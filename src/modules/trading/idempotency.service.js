'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { IdempotencyRecord } = require('./idempotency.model');

function canonicalize(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === 'Decimal128' || value?.constructor?.name === 'Decimal128') return value.toString();
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function hashCommandPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

class IdempotencyService {
  constructor({ model = IdempotencyRecord } = {}) {
    this.model = model;
  }

  async reserve({ accountId, scope, key, payload, expiresAt }) {
    if (!accountId) throw new TypeError('accountId is required');
    if (!scope || !String(scope).trim()) throw new TypeError('idempotency scope is required');
    if (!key || !String(key).trim()) throw new TypeError('idempotency key is required');

    const requestHash = hashCommandPayload(payload);
    try {
      const record = await this.model.create({
        accountId,
        scope: String(scope).trim(),
        key: String(key).trim(),
        requestHash,
        ...(expiresAt ? { expiresAt } : {}),
      });
      return { created: true, replay: false, record };
    } catch (error) {
      if (error?.code !== 11000) throw error;

      const record = await this.model.findOne({ accountId, scope: String(scope).trim(), key: String(key).trim() });
      if (!record) throw error;
      if (record.requestHash !== requestHash) {
        throw new AppError('Idempotency key was already used with a different command payload', {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      return {
        created: false,
        replay: record.state === 'COMPLETED' || record.state === 'FAILED',
        inProgress: record.state === 'IN_PROGRESS',
        record,
      };
    }
  }

  async complete(recordId, { resourceType = null, resourceId = null, response = null } = {}, { session = null } = {}) {
    const query = this.model.findOneAndUpdate(
      { _id: recordId, state: 'IN_PROGRESS' },
      { $set: { state: 'COMPLETED', resourceType, resourceId, response, failureCode: null } },
      { new: true },
    );
    if (session) query.session(session);
    return query;
  }

  async fail(recordId, { failureCode, response = null } = {}, { session = null } = {}) {
    const query = this.model.findOneAndUpdate(
      { _id: recordId, state: 'IN_PROGRESS' },
      { $set: { state: 'FAILED', failureCode: failureCode || 'COMMAND_FAILED', response } },
      { new: true },
    );
    if (session) query.session(session);
    return query;
  }
}

module.exports = { IdempotencyService, hashCommandPayload, canonicalize };
