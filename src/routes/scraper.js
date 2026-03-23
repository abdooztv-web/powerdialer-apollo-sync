const express = require('express');
const router = express.Router();
const { runGoogleMapsScrape, getJobStatus, fetchResults } = require('../scrapers/apify');
const { scoreLeads } = require('../enrichment/scorer');
const { saveLeads, getLeads, updateLead, getStats, exportCSV, generateId } = require('../store/leads');
const { findContactByEmail, addToSequence } = require('../handlers/apollo');
const logger = require('../utils/logger');

// Active scrape jobs tracked in memory (runId -> status)
const activeJobs = new Map();

function fallbackScore(lead) {
  let score = 0;
  const cat = (lead.category || '').toLowerCase();
  if (cat.includes('orthodox') || cat.includes('eastern') || cat.includes('coptic') || cat.includes('armenian')) score += 3;
  if (!lead.hasWebsite) score += 3;
  if ((lead.reviewCount || 0) < 30) score += 2;
  if (lead.phone) score += 1;
  return Math.max(1, Math.min(10, score));
}

// POST /api/scraper/run
router.post('/run', async (req, res) => {
  try {
    const { searchType = 'orthodox', location = 'United States', maxResults = 200, customKeyword = null } = req.body;

    if (!process.env.APIFY_API_TOKEN) {
      return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
    }

    const { runId, datasetId } = await runGoogleMapsScrape({ searchType, location, maxResults: Number(maxResults), customKeyword });

    activeJobs.set(runId, { status: 'RUNNING', datasetId, startedAt: new Date().toISOString(), scored: false });

    logger.info('Scrape job started', { runId, searchType, location, maxResults });
    res.json({ success: true, runId, datasetId });
  } catch (err) {
    const detail = err.response?.data || err.message;
    logger.error('Failed to start scrape', { error: err.message, apify: detail });
    res.status(500).json({ success: false, error: err.message, detail });
  }
});

// GET /api/scraper/status/:runId
router.get('/status/:runId', async (req, res) => {
  const { runId } = req.params;
  try {
    const job = activeJobs.get(runId) || {};
    const apifyStatus = await getJobStatus(runId);

    if (apifyStatus.status === 'SUCCEEDED' && !job.scored) {
      // Mark scored immediately to prevent double-processing on concurrent polls
      activeJobs.set(runId, { ...job, status: 'PROCESSING', scored: true });

      // Synchronous: fetch + score + save within this request (required for Vercel)
      try {
        const raw = await fetchResults(apifyStatus.datasetId);
        const withIds = raw.map(r => ({ ...r, id: generateId(), status: 'new', scrapedAt: new Date().toISOString() }));

        let scored;
        if (process.env.ANTHROPIC_API_KEY) {
          try {
            scored = await scoreLeads(withIds);
          } catch (scoreErr) {
            logger.error('Claude scoring failed', { error: scoreErr.message, response: scoreErr.response?.data });
            scored = withIds.map(l => ({ ...l, score: fallbackScore(l), scoreReason: 'Auto-scored (Claude error: ' + scoreErr.message + ')', suggestedSequence: 'skip' }));
          }
        } else {
          logger.warn('ANTHROPIC_API_KEY not set — using fallback scoring');
          scored = withIds.map(l => ({ ...l, score: fallbackScore(l), scoreReason: 'Auto-scored (no API key)', suggestedSequence: 'skip' }));
        }

        const added = saveLeads(scored);
        activeJobs.set(runId, { ...job, status: 'DONE', scored: true, count: added });
        logger.info('Scrape complete', { runId, total: raw.length, added });
        return res.json({ success: true, status: 'DONE', count: added });
      } catch (err) {
        activeJobs.set(runId, { ...job, status: 'ERROR', scored: true, error: err.message });
        logger.error('Post-scrape processing failed', { runId, error: err.message });
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    const localStatus = job.status || apifyStatus.status;
    res.json({
      success: true,
      status: localStatus,
      apifyStatus: apifyStatus.status,
      itemCount: apifyStatus.itemCount,
      count: job.count || 0,
      error: job.error || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/leads
router.get('/leads', (req, res) => {
  try {
    const { minScore, maxScore, location, hasWebsite, status, sort, limit, offset } = req.query;
    const result = getLeads({ minScore, maxScore, location, hasWebsite, status, sort, limit, offset });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/stats
router.get('/stats', (req, res) => {
  try {
    res.json({ success: true, stats: getStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scraper/push
// Body: { leads: [{ id, email? }], sequenceId, sequenceName }
router.post('/push', async (req, res) => {
  const { leads: leadsToPush = [], sequenceId, sequenceName } = req.body;
  if (!sequenceId) return res.status(400).json({ success: false, error: 'sequenceId is required' });
  if (!leadsToPush.length) return res.status(400).json({ success: false, error: 'No leads provided' });

  const results = [];

  for (const item of leadsToPush) {
    try {
      let contactId = item.apolloContactId;

      if (!contactId && item.email) {
        const contact = await findContactByEmail(item.email);
        if (contact) contactId = contact.id;
      }

      if (!contactId) {
        updateLead(item.id, { status: 'error', errorMsg: 'No Apollo contact found' });
        results.push({ id: item.id, success: false, error: 'No Apollo contact found' });
        continue;
      }

      await addToSequence(contactId, sequenceId);
      updateLead(item.id, {
        status: 'pushed',
        pushedAt: new Date().toISOString(),
        pushedToSequence: sequenceName || sequenceId,
        apolloContactId: contactId,
      });
      results.push({ id: item.id, success: true });
    } catch (err) {
      updateLead(item.id, { status: 'error', errorMsg: err.message });
      results.push({ id: item.id, success: false, error: err.message });
    }
  }

  const pushed = results.filter(r => r.success).length;
  res.json({ success: true, pushed, failed: results.length - pushed, results });
});

// POST /api/scraper/skip
router.post('/skip', (req, res) => {
  const { ids = [] } = req.body;
  ids.forEach(id => updateLead(id, { status: 'skipped' }));
  res.json({ success: true, skipped: ids.length });
});

// GET /api/scraper/export
router.get('/export', (req, res) => {
  try {
    const { minScore, maxScore, location, hasWebsite, status, sort } = req.query;
    const csv = exportCSV({ minScore, maxScore, location, hasWebsite, status, sort });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="church-leads-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
