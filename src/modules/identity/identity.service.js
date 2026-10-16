'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { User } = require('./user.model');
const { LoginIdentity } = require('./login-identity.model');

// Creates a person, never a trading account or a trader session.
// A deterministic candidate ID makes concurrent first logins retry-safe without relying on email.
class IdentityService {
  constructor({ verifier, userModel = User, identityModel = LoginIdentity } = {}) {
    if (!verifier) throw new Error('Token verifier is required');
    Object.assign(this, { verifier, userModel, identityModel });
  }

  async bootstrap(token) {
    const { issuer, subject } = await this.verifier.verify(token);
    const candidateId = new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`SUPABASE\0${issuer}\0${subject}`).digest('hex').slice(0, 24));
    const query = { provider: 'SUPABASE', issuer, subject };
    let identity;
    try {
      identity = await this.identityModel.findOneAndUpdate(query, {
        $setOnInsert: { userId: candidateId, provider: 'SUPABASE', issuer, subject, status: 'ACTIVE' },
      }, { upsert: true, new: true, runValidators: true }).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      identity = await this.identityModel.findOne(query).lean();
    }
    if (!identity || identity.status !== 'ACTIVE') throw identityDenied();
    const userId = identity.userId;
    let user;
    try {
      user = await this.userModel.findOneAndUpdate({ _id: userId }, {
        $setOnInsert: { status: 'ACTIVE' },
      }, { upsert: true, new: true, runValidators: true }).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      user = await this.userModel.findOne({ _id: userId }).lean();
    }
    if (!user || user.status !== 'ACTIVE') throw identityDenied();
    return { userId: String(user._id), status: 'SETUP_REQUIRED' };
  }
}

function identityDenied() {
  return new AppError('Identity access is disabled', { statusCode: 403, code: 'IDENTITY_DISABLED' });
}

module.exports = { IdentityService };
