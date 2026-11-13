'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const snapshotSchema = new Schema({
  _id: String,
  provider: { type: String, required: true },
  coverageFrom: { type: Date, required: true },
  coverageTo: { type: Date, required: true },
  fetchedAt: { type: Date, required: true },
  checksum: { type: String, required: true },
  events: { type: [Schema.Types.Mixed], required: true },
  verification: { type: Schema.Types.Mixed, default: null },
}, { versionKey: false });
// Snapshots are insert-only. Runtime health is derived from fetchedAt, never persisted into a snapshot.
snapshotSchema.pre('save', function(next) { next(this.isNew ? undefined : new Error('Calendar snapshots are immutable')); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  snapshotSchema.pre(operation, function(next) { next(new Error('Calendar snapshots are immutable')); });
}
const stateSchema = new Schema({
  _id: String,
  activeVersion: { type: String, default: null },
  leaseOwner: String,
  leaseUntil: { type: Date, default: () => new Date(0) },
  generation: { type: Number, default: 0 },
  nextRefreshAt: { type: Date, default: () => new Date(0) },
  lastError: { type: String, default: null },
}, { versionKey: false });

module.exports = {
  NewsCalendarSnapshot: mongoose.models.NewsCalendarSnapshot || mongoose.model('NewsCalendarSnapshot', snapshotSchema),
  NewsCalendarState: mongoose.models.NewsCalendarState || mongoose.model('NewsCalendarState', stateSchema),
};
