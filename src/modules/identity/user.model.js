'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// A person is global; organization membership and trading rights are separate.
const userSchema = new Schema({
  status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE', required: true, index: true },
}, { timestamps: true, optimisticConcurrency: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
module.exports = { User, userSchema };
