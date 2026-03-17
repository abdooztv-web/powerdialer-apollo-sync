const MAX_PROCESSED = 100;

const pendingQueue = [];
const processedLog = [];
const stats = { total: 0, added: 0, removed: 0, noAction: 0, ignored: 0 };

function addToPending(event) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const item = {
    id,
    contactName:    event.contactName    || 'Unknown',
    contactEmail:   event.contactEmail   || '',
    contactPhone:   event.contactPhone   || null,
    contactCompany: event.contactCompany || null,
    contactTitle:   event.contactTitle   || null,
    contactIdPd:    event.contactIdPd    || null,
    disposition:    event.disposition    || '',
    notes:          event.notes          || null,
    callTime:       event.callTime       || null,
    callTranscript: event.callTranscript || null,
    callSid:        event.callSid        || null,
    receivedAt:     new Date().toISOString(),
    status: 'pending'
  };
  pendingQueue.unshift(item);
  stats.total++;
  return item;
}

function getPendingById(id) {
  return pendingQueue.find(p => p.id === id) || null;
}

function removePending(id) {
  const idx = pendingQueue.findIndex(p => p.id === id);
  if (idx === -1) return null;
  return pendingQueue.splice(idx, 1)[0];
}

function getPending() {
  return [...pendingQueue];
}

function addToProcessed(item, action, sequenceId, sequenceName, status, error) {
  const processed = {
    ...item,
    action,
    sequenceId:   sequenceId   || null,
    sequenceName: sequenceName || null,
    processedAt:  new Date().toISOString(),
    status,
    error: error || null
  };
  processedLog.unshift(processed);
  if (processedLog.length > MAX_PROCESSED) processedLog.pop();

  if (action === 'added_to_sequence')        stats.added++;
  else if (action === 'removed_from_sequences') stats.removed++;
  else if (action === 'none')                stats.noAction++;
  else if (status === 'ignored')             stats.ignored++;

  return processed;
}

function getProcessed() {
  return [...processedLog];
}

function getStats() {
  return { ...stats, pending: pendingQueue.length };
}

module.exports = {
  addToPending,
  getPendingById,
  removePending,
  getPending,
  addToProcessed,
  getProcessed,
  getStats
};
