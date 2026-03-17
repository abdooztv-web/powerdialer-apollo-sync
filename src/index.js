require('dotenv').config();
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const logger  = require('./utils/logger');
const store   = require('./store');
const { findContactByEmail, addToSequence, removeFromSequences } = require('./handlers/apollo');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, validate: { xForwardedForHeader: false } });
app.use('/webhook', limiter);

// ── HEALTH ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PowerDialer → Apollo sync is running',
    timestamp: new Date().toISOString()
  });
});

// ── SEQUENCES (available options for the UI) ───────────────
app.get('/api/sequences', (req, res) => {
  res.json({
    sequences: [
      { key: 'pastors',   id: process.env.PASTORS_SEQUENCE_ID,   name: 'Pastors High Positions' },
      { key: 'directors', id: process.env.DIRECTORS_SEQUENCE_ID, name: 'Directors High Positions' },
      { key: 'new',       id: process.env.NEW_SEQUENCE_ID,       name: 'New Contacts' }
    ]
  });
});

// ── DASHBOARD DATA ─────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  res.json({
    success: true,
    stats:   store.getStats(),
    pending: store.getPending(),
    events:  store.getProcessed()
  });
});

// ── APPROVE A PENDING CONTACT ──────────────────────────────
app.post('/api/approve/:id', async (req, res) => {
  const { action, sequenceId, sequenceName } = req.body;
  const item = store.getPendingById(req.params.id);

  if (!item) {
    return res.status(404).json({ success: false, error: 'Pending item not found' });
  }

  if (!action) {
    return res.status(400).json({ success: false, error: 'action is required' });
  }

  try {
    if (action === 'added_to_sequence') {
      if (!sequenceId) return res.status(400).json({ success: false, error: 'sequenceId required for add action' });
      const contact = await findContactByEmail(item.contactEmail);
      if (!contact) throw new Error(`Contact ${item.contactEmail} not found in Apollo`);
      await addToSequence(contact.id, sequenceId);

    } else if (action === 'removed_from_sequences') {
      const contact = await findContactByEmail(item.contactEmail);
      if (!contact) throw new Error(`Contact ${item.contactEmail} not found in Apollo`);
      await removeFromSequences(contact.id, item.disposition);
    }
    // action === 'none' → no Apollo call needed

    store.removePending(req.params.id);
    const processed = store.addToProcessed(item, action, sequenceId, sequenceName, 'approved', null);

    logger.info('✅ Approved', { id: req.params.id, action, contactEmail: item.contactEmail });
    res.json({ success: true, processed });

  } catch (error) {
    logger.error('❌ Approve failed', { error: error.message, id: req.params.id });

    // Still move out of pending on Apollo error so it doesn't get stuck
    store.removePending(req.params.id);
    store.addToProcessed(item, action, sequenceId, sequenceName, 'error', error.message);

    res.status(500).json({ success: false, error: error.message });
  }
});

// ── IGNORE A PENDING CONTACT ───────────────────────────────
app.post('/api/ignore/:id', (req, res) => {
  const item = store.getPendingById(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found' });

  store.removePending(req.params.id);
  store.addToProcessed(item, 'none', null, null, 'ignored', null);

  logger.info('🚫 Ignored', { id: req.params.id, contactEmail: item.contactEmail });
  res.json({ success: true });
});

// ── WEBHOOK: PowerDialer → queue for approval ──────────────
app.post('/webhook/powerdialer', (req, res) => {
  const body = req.body;

  // Log full body so we can debug field names from PowerDialer
  logger.info('📞 Incoming webhook — raw body', body);

  const d = body.data || body;
  const contact_email   = d.contact?.metadata?.email || d.contact_email || d.email;
  const contact_name    = d.contact?.name || d.contact_name || d.name || 'Unknown';
  const disposition     = d.disposition?.type || d.dispositionType || d.disposition || d.event;
  const notes           = d.disposition?.notes || d.notes || null;
  const contact_phone   = d.contact?.phoneNumber || d.phoneNumber || null;
  const contact_id_pd   = d.contact?.id || d.contactId || null;
  const call_sid        = d.callSid || d.callHistory?.callSid || null;
  const call_transcript = d.callHistory?.transcript || null;

  if (!contact_email || !disposition) {
    logger.error('❌ Missing fields', { received_fields: Object.keys(body), body });
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: contact_email and disposition',
      received_fields: Object.keys(body),
      received_body: body
    });
  }

  const item = store.addToPending({
    contactName:    contact_name,
    contactEmail:   contact_email,
    disposition:    disposition,
    notes:          notes,
    contactPhone:   contact_phone,
    contactIdPd:    contact_id_pd,
    callSid:        call_sid,
    callTranscript: call_transcript
  });

  logger.info('✅ Queued for approval', { contactEmail: contact_email, disposition, id: item.id });

  res.json({
    success: true,
    message: 'Queued for admin approval',
    id: item.id
  });
});

// ── DEBUG: shows exactly what was received ─────────────────
app.post('/webhook/debug', (req, res) => {
  logger.info('🔍 Debug webhook', req.body);
  res.json({
    success: true,
    received_fields: Object.keys(req.body),
    received_body: req.body
  });
});

// ── TEST ENDPOINT ──────────────────────────────────────────
app.post('/webhook/test', (req, res) => {
  logger.info('🧪 Test webhook', req.body);

  const item = store.addToPending({
    contactName:  req.body.contact_name  || 'Test User',
    contactEmail: req.body.contact_email || 'test@example.com',
    disposition:  req.body.disposition   || 'Test',
    notes:        req.body.notes         || null
  });

  res.json({ success: true, message: 'Test queued for approval', id: item.id });
});

// ── ERROR HANDLERS ─────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// ── START ──────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
