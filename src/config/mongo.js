const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

let isConnected = false;

async function connectMongo() {
  try {
    await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 3000,
    });
    isConnected = true;
    logger.info('MongoDB connected');
  } catch (err) {
    isConnected = false;
    // MongoDB is used for logs/events only — the API must stay usable
    // even if the log store is temporarily unreachable.
    logger.warn('MongoDB connection failed, continuing without log persistence', {
      error: err.message,
    });
  }
}

function isMongoConnected() {
  return isConnected;
}

module.exports = { connectMongo, isMongoConnected, mongoose };
