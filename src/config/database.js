'use strict';

const mongoose = require('mongoose');
const { env } = require('./env');
const { logger } = require('../infrastructure/logger/logger');

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

let listenersAttached = false;

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
    mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
    mongoose.connection.on('error', error => logger.error({ err: error }, 'MongoDB connection error'));
  }

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: env.mongoServerSelectionTimeoutMs,
    maxPoolSize: 20,
    minPoolSize: 1,
    autoIndex: false,
  });

  return mongoose.connection;
}

async function verifyTransactionSupport() {
  if (mongoose.connection.readyState !== 1) throw new Error('MongoDB must be connected before transaction verification');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection('tenants').findOne({}, { session });
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return true;
  } catch (error) {
    const message = String(error?.message || '');
    if (error?.code === 20 || /Transaction numbers are only allowed|replica set|mongos/i.test(message)) {
      const wrapped = new Error('MongoDB transactions are unavailable; ACG Trader requires MongoDB Atlas or a replica-set deployment');
      wrapped.code = 'MONGODB_TRANSACTIONS_UNAVAILABLE';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

function databaseHealth() {
  return {
    readyState: mongoose.connection.readyState,
    connected: mongoose.connection.readyState === 1,
  };
}

module.exports = { connectDatabase, verifyTransactionSupport, disconnectDatabase, databaseHealth };
