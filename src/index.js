require('dotenv').config();
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const axios   = require('axios');
const logger  = require('./utils/logger');
const store   = require('./store');
const { findContactByEmail, addToSequence, removeFromSequences } = require('./handlers/apollo');
const scraperRoutes = require('./routes/scraper');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── KNOWN SEQUENCES ────────────────────────────────────────
const SEQUENCES = [
  { key: 'new',            id: '69af119c98528e0011c32d0a', name: 'New Sequence',                   active: true  },
  { key: 'small_central',  id: '69b70f0984a4d90011a97bdf', name: 'Small Churches Central Time',    active: false },
  { key: 'pastors',        id: '693bf8101177c400190c7168', name: 'Copy - Pastors High Positions',   active: true  },
  { key: 'directors_copy', id: '6964b139a6984e0015e7b4cd', name: 'Copy - Directors High Positions', active: false },
  { key: 'directors',      id: '68df994e01bcfc001d51f6ba', name: 'Directors High Positions',        active: true  },
];

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

// ── SCRAPER ROUTES ──────────────────────────────────────────
app.use('/api/scraper', scraperRoutes);

// ── HEALTH ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'PowerDialer → Apollo sync is running', timestamp: new Date().toISOString() });
});

// ── SEQUENCES LIST ─────────────────────────────────────────
app.get('/api/sequences', (req, res) => {
  res.json({ sequences: SEQUENCES });
});

// ── INBOX + ACTIVITY DATA ──────────────────────────────────
app.get('/api/activity', (req, res) => {
  res.json({
    success: true,
    stats:   store.getStats(),
    pending: store.getPending(),
    events:  store.getProcessed()
  });
});

// ── ANALYTICS: live sequence stats from Apollo ─────────────
app.get('/api/analytics', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.apollo.io/v1/emailer_campaigns/search',
      { per_page: 25 },
      {
        headers: {
          'X-Api-Key':      process.env.APOLLO_API_KEY,
          'Content-Type':   'application/json',
          'Cache-Control':  'no-cache'
        }
      }
    );

    const campaigns = response.data.emailer_campaigns || [];

    const sequences = SEQUENCES.map(seq => {
      const c = campaigns.find(x => x.id === seq.id) || {};
      return {
        id:               seq.id,
        name:             c.name             || seq.name,
        active:           c.active           !== undefined ? c.active : seq.active,
        delivered:        c.num_contacts      || 0,
        openRate:         c.email_open_rate   || 0,
        replyRate:        c.email_reply_rate  || 0,
        bounceRate:       c.email_bounce_rate || 0,
        demoRate:         c.meetings_booked_rate || c.demos_rate || 0,
        isPerformingPoorly: c.is_performing_poorly || false,
      };
    });

    res.json({ success: true, sequences });
  } catch (error) {
    logger.error('Analytics fetch failed', { error: error.message });
    // Return skeleton data so UI doesn't break
    res.json({
      success: false,
      error: error.message,
      sequences: SEQUENCES.map(seq => ({
        id: seq.id, name: seq.name, active: seq.active,
        delivered: 0, openRate: 0, replyRate: 0, bounceRate: 0, demoRate: 0,
        isPerformingPoorly: false
      }))
    });
  }
});

// ── APPROVE ────────────────────────────────────────────────
app.post('/api/approve/:id', async (req, res) => {
  const { action, sequenceId, sequenceName } = req.body;
  const item = store.getPendingById(req.params.id);

  if (!item) return res.status(404).json({ success: false, error: 'Pending item not found' });
  if (!action) return res.status(400).json({ success: false, error: 'action is required' });

  try {
    if (action === 'added_to_sequence') {
      if (!sequenceId) return res.status(400).json({ success: false, error: 'sequenceId required' });
      const contact = await findContactByEmail(item.contactEmail);
      if (!contact) throw new Error(`Contact ${item.contactEmail} not found in Apollo`);
      await addToSequence(contact.id, sequenceId);
    } else if (action === 'removed_from_sequences') {
      const contact = await findContactByEmail(item.contactEmail);
      if (!contact) throw new Error(`Contact ${item.contactEmail} not found in Apollo`);
      await removeFromSequences(contact.id, item.disposition);
    }

    store.removePending(req.params.id);
    const processed = store.addToProcessed(item, action, sequenceId, sequenceName, 'approved', null);
    logger.info('✅ Approved', { id: req.params.id, action, email: item.contactEmail });
    res.json({ success: true, processed });

  } catch (error) {
    logger.error('❌ Approve failed', { error: error.message });
    store.removePending(req.params.id);
    store.addToProcessed(item, action, sequenceId, sequenceName, 'error', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── IGNORE ─────────────────────────────────────────────────
app.post('/api/ignore/:id', (req, res) => {
  const item = store.getPendingById(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: 'Not found' });

  store.removePending(req.params.id);
  store.addToProcessed(item, 'none', null, null, 'ignored', null);
  logger.info('🚫 Ignored', { id: req.params.id });
  res.json({ success: true });
});

// ── WEBHOOK: PowerDialer → inbox ───────────────────────────
app.post('/webhook/powerdialer', (req, res) => {
  const body = req.body;
  logger.info('📞 Incoming webhook', body);

  const d = body.data || body;
  const contact_email   = d.contact?.metadata?.email    || d.contact_email || d.email;
  const contact_name    = d.contact?.name               || d.contact_name  || d.name || 'Unknown';
  const contact_phone   = d.contact?.phoneNumber        || d.phoneNumber   || null;
  const contact_company = d.contact?.metadata?.company  || d.company       || null;
  const contact_title   = d.contact?.metadata?.title    || d.title         || null;
  const contact_id_pd   = d.contact?.id                 || d.contactId     || null;
  const disposition     = d.disposition?.type           || d.dispositionType || d.disposition || d.event;
  const notes           = d.disposition?.notes          || d.notes         || null;
  const call_time       = d.callHistory?.callTime       || d.callTime      || null;
  const call_transcript = d.callHistory?.transcript     || d.transcript    || null;
  const call_sid        = d.callSid || d.callHistory?.callSid || null;

  if (!contact_email || !disposition) {
    logger.error('❌ Missing fields', { fields: Object.keys(body), body });
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
    contactPhone:   contact_phone,
    contactCompany: contact_company,
    contactTitle:   contact_title,
    contactIdPd:    contact_id_pd,
    disposition:    disposition,
    notes:          notes,
    callTime:       call_time,
    callTranscript: call_transcript,
    callSid:        call_sid
  });

  logger.info('✅ Queued', { email: contact_email, disposition, id: item.id });
  res.json({ success: true, message: 'Queued for review', id: item.id });
});

// ── DEBUG ──────────────────────────────────────────────────
app.post('/webhook/debug', (req, res) => {
  logger.info('🔍 Debug', req.body);
  res.json({ success: true, received_fields: Object.keys(req.body), received_body: req.body });
});

// ── TEST ───────────────────────────────────────────────────
app.post('/webhook/test', (req, res) => {
  logger.info('🧪 Test webhook', req.body);
  const item = store.addToPending({
    contactName:    req.body.contact_name    || 'Pastor John Smith',
    contactEmail:   req.body.contact_email   || 'john@testchurch.org',
    contactPhone:   req.body.contact_phone   || '+1 (555) 123-4567',
    contactCompany: req.body.contact_company || 'First Baptist Church',
    contactTitle:   req.body.contact_title   || 'Senior Pastor',
    disposition:    req.body.disposition     || 'Interested',
    notes:          req.body.notes           || 'Very interested in the demo',
    callTime:       req.body.call_time       || 154,
    callTranscript: req.body.transcript      || 'Hi this is a test transcript snippet from the call recording...',
    callSid:        null,
    contactIdPd:    null
  });
  res.json({ success: true, message: 'Test queued', id: item.id });
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
  logger.info(`🚀 Server on port ${PORT}`);
  logger.info(`📊 Dashboard: http://localhost:${PORT}`);
});

module.exports = app;
