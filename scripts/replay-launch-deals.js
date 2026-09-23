'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { PlatformEventOutbox } = require('../src/modules/integration/platform-event-outbox.model');

const ids = String(process.env.REPLAY_PLATFORM_EVENT_IDS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

if (!ids.length) throw new Error('REPLAY_PLATFORM_EVENT_IDS is required.');

async function main() {
  await connectDatabase();

  const records = [];
  for (const eventId of ids) {
    const record = await PlatformEventOutbox.findOne({ eventId }).lean();
    if (!record) throw new Error(`Outbox event ${eventId} was not found.`);
    if (record.status !== 'DEAD') {
      throw new Error(`Outbox event ${eventId} is not DEAD (status=${record.status}).`);
    }
    if (record.eventType !== 'DEAL_CREATED') {
      throw new Error(`Outbox event ${eventId} is not DEAL_CREATED (eventType=${record.eventType}).`);
    }
    records.push(record);
  }

  let revived = 0;
  for (const record of records) {
    const result = await PlatformEventOutbox.updateOne(
      { _id: record._id, status: 'DEAD', eventType: 'DEAL_CREATED' },
      {
        $set: {
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: new Date(),
          lastAttemptAt: null,
          lastError: null,
          expiresAt: null,
        },
      },
    );
    if (Number(result.modifiedCount || 0) !== 1) {
      throw new Error(`Outbox event ${record.eventId} changed before replay could be scheduled.`);
    }
    revived += 1;
  }

  console.log('[launch-readiness] replay-scheduled', JSON.stringify({
    eventIds: records.map(record => record.eventId),
    eventTypes: [...new Set(records.map(record => record.eventType))],
    count: revived,
  }));
}

main()
  .catch(error => {
    console.error('[launch-readiness] replay-schedule FAIL', JSON.stringify({
      message: error?.message || String(error),
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => {});
  });
