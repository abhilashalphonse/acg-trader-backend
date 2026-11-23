'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { AlertShadowWorker } = require('./alert-worker');

// This entrypoint intentionally cannot send notifications or trading commands.
if (process.env.ACG_ALERTS_STAGE2_SHADOW_WORKER !== 'true') {
  process.stderr.write('Shadow alert worker disabled. Set ACG_ALERTS_STAGE2_SHADOW_WORKER=true explicitly.\n');
  process.exit(1);
}

const mongoUri = process.env.ACG_MONGO_RAILWAY_CUTOVER === 'true'
  ? process.env.RAILWAY_MONGODB_URI : process.env.MONGODB_URI;
if (!mongoUri) {
  process.stderr.write('No configured Trader database URI.\n');
  process.exit(1);
}

async function main() {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 });
  const worker = new AlertShadowWorker({
    logger: {
      error: (obj, message) => process.stderr.write(JSON.stringify({ level: 'error', message,
        reason: obj?.err?.message || null, ruleId: obj?.ruleId || null }) + '\n'),
    },
  });
  let running = true;
  const halt = () => { running = false; };
  process.on('SIGTERM', halt);
  process.on('SIGINT', halt);
  while (running) {
    try {
      const status = await worker.pumpOnce();
      if (!status.ownsLease) process.stdout.write('Alert shadow evaluator is standby (lease held elsewhere).\n');
    } catch (error) {
      process.stderr.write('Alert shadow evaluator error: ' + String(error?.message || error) + '\n');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await mongoose.disconnect();
}
main().catch(error => {
  process.stderr.write('Alert shadow worker failed to start: ' + String(error?.message || error) + '\n');
  process.exitCode = 1;
});
