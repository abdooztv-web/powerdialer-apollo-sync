const MAX_EVENTS = 100;
const activityLog = [];
const stats = { total: 0, added: 0, removed: 0, noAction: 0 };

function addEvent(event) {
  activityLog.unshift({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    ...event,
    timestamp: new Date().toISOString()
  });
  if (activityLog.length > MAX_EVENTS) activityLog.pop();

  stats.total++;
  if (event.action === 'added_to_sequence') stats.added++;
  else if (event.action === 'removed_from_sequences') stats.removed++;
  else if (event.action === 'none') stats.noAction++;
}

function getEvents() {
  return [...activityLog];
}

function getStats() {
  return { ...stats };
}

module.exports = { addEvent, getEvents, getStats };
