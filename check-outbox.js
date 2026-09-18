require("dotenv").config({ override: true });
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const rows = await mongoose.connection.db
    .collection("platformeventoutboxes")
    .find({
      aggregateId: "TRIAL-3AED89F2044C4218",
      eventType: "ACCOUNT_SNAPSHOT"
    })
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();

  console.dir(rows.map(x => ({
    eventId: x.eventId,
    status: x.status,
    attempts: x.attempts,
    lastError: x.lastError,
    occurredAt: x.occurredAt,
    payload: x.payload
  })), { depth: null });

  await mongoose.disconnect();
})();
