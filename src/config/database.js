'use strict';

const mongoose = require('mongoose');
const { env } = require('./env');
const { logger } = require('../infrastructure/logger/logger');

mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', error => logger.error({ err: error }, 'MongoDB connection error'));

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: env.mongoServerSelectionTimeoutMs,
    maxPoolSize: 20,
    minPoolSize: 1,
    autoIndex: !env.isProduction,
  });

  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

function databaseHealth() {
  return {
    readyState: mongoose.connection.readyState,
    connected: mongoose.connection.readyState === 1,
    name: mongoose.connection.name || null,
    host: mongoose.connection.host || null,
  };
}

module.exports = { connectDatabase, disconnectDatabase, databaseHealth };
