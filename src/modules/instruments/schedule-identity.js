'use strict';
const crypto = require('crypto');
function scheduleHash(instrument) {
  const sessions = values => (values || []).map(item => ({ days: [...(item.days || [])].map(Number).sort(), open: item.open, close: item.close }));
  return crypto.createHash('sha256').update(JSON.stringify({ timezone: instrument?.timezone || 'UTC',
    sessions: sessions(instrument?.tradingSessions), holidays: [...(instrument?.tradingHolidays || [])].map(String).sort(),
    overrides: (instrument?.sessionOverrides || []).map(item => ({ date: item.date, closed: Boolean(item.closed), sessions: sessions(item.sessions) })).sort((a, b) => a.date.localeCompare(b.date)),
  })).digest('hex');
}
module.exports = { scheduleHash };
