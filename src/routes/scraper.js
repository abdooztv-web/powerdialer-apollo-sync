const express = require('express');
const router = express.Router();
const { runGoogleMapsScrape, getJobStatus, fetchResults } = require('../scrapers/apify');
const { scoreLeads } = require('../enrichment/scorer');
const { enrichWebsite, startEnrichCrawl, getEnrichStatus, extractContactsFromDataset,
        startBatchEnrichCrawl, fetchAllDatasetItems, groupItemsByDomain, extractContactsForChurch, getDomain } = require('../enrichment/websiteEnricher');
const { saveLeads, getLeads, updateLead, deleteLeads, getStats, exportCSV, generateId,
        getRunResult, getBatchProgress, markBatchLeads } = require('../store/leads');
const { findContactByEmail, addToSequence } = require('../handlers/apollo');
const { DENOMINATIONS, importFromDirectory } = require('../enrichment/denominationDirectories');
const { TIMEZONES, STATE_NAMES, scrapeStateClergy } = require('../enrichment/ocaScraper');
const logger = require('../utils/logger');

// Active scrape jobs tracked in memory (runId -> status)
const activeJobs = new Map();

// Active enrich jobs tracked in memory (enrichRunId -> { leadId, status, datasetId })
const enrichJobs = new Map();

// Directory import jobs
const directoryJobs = new Map();

// Batch enrich jobs: batchRunId -> { domainToLeadId, datasetId, status, items? }
const batchJobs = new Map();

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
    const { searchType = 'orthodox', location = 'United States', maxResults = 200, customKeyword = null, websiteFilter = 'all' } = req.body;

    if (!process.env.APIFY_API_TOKEN) {
      return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
    }

    const { runId, datasetId } = await runGoogleMapsScrape({ searchType, location, maxResults: Number(maxResults), customKeyword });

    activeJobs.set(runId, { status: 'RUNNING', datasetId, startedAt: new Date().toISOString(), scored: false, websiteFilter });

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

    if (apifyStatus.status === 'SUCCEEDED') {
      // DB-backed dedup: if leads already saved for this runId (Vercel cold-start safe), return immediately
      const alreadySaved = await getRunResult(runId);
      if (alreadySaved > 0) {
        return res.json({ success: true, status: 'DONE', count: alreadySaved, skipped: 0, total: alreadySaved });
      }
      if (job.scored) {
        return res.json({ success: true, status: job.status || 'PROCESSING', count: job.count || 0, skipped: job.skipped || 0 });
      }

      // Mark scored immediately to prevent double-processing on concurrent polls
      activeJobs.set(runId, { ...job, status: 'PROCESSING', scored: true });

      // Synchronous: fetch + score + save within this request (required for Vercel)
      try {
        let raw = await fetchResults(apifyStatus.datasetId);
        // Apply website filter
        if (job.websiteFilter === 'no-website') raw = raw.filter(r => !r.hasWebsite);
        else if (job.websiteFilter === 'has-website') raw = raw.filter(r => r.hasWebsite);
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

        const { added, skipped } = await saveLeads(scored, runId);
        activeJobs.set(runId, { ...job, status: 'DONE', scored: true, count: added, skipped });
        logger.info('Scrape complete', { runId, total: raw.length, added, skipped });
        return res.json({ success: true, status: 'DONE', count: added, skipped, total: raw.length });
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

// GET /api/scraper/claude-test
router.get('/claude-test', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY is not set in Vercel env vars' });
  try {
    const axios = require('axios');
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Reply with: ok' }] },
      { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    res.json({ ok: true, response: r.data.content[0].text });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data || err.message });
  }
});

// GET /api/scraper/db-test  — quick connection diagnostic
router.get('/db-test', async (req, res) => {
  const uri = process.env.DATABASE_URL;
  if (!uri) return res.json({ ok: false, error: 'DATABASE_URL is not set in Vercel env vars' });
  try {
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: uri, ssl: { rejectUnauthorized: false } });
    await p.query('SELECT 1');
    await p.end();
    res.json({ ok: true, message: 'Database connected successfully' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/scraper/leads
router.get('/leads', async (req, res) => {
  try {
    const { minScore, maxScore, location, hasWebsite, status, sort, limit, offset } = req.query;
    const result = await getLeads({ minScore, maxScore, location, hasWebsite, status, sort, limit, offset });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('getLeads failed', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ success: true, stats });
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
        await updateLead(item.id, { status: 'error', errorMsg: 'No Apollo contact found' });
        results.push({ id: item.id, success: false, error: 'No Apollo contact found' });
        continue;
      }

      await addToSequence(contactId, sequenceId);
      await updateLead(item.id, {
        status: 'pushed',
        pushedAt: new Date().toISOString(),
        pushedToSequence: sequenceName || sequenceId,
        apolloContactId: contactId,
      });
      results.push({ id: item.id, success: true });
    } catch (err) {
      await updateLead(item.id, { status: 'error', errorMsg: err.message });
      results.push({ id: item.id, success: false, error: err.message });
    }
  }

  const pushed = results.filter(r => r.success).length;
  res.json({ success: true, pushed, failed: results.length - pushed, results });
});

// POST /api/scraper/skip
router.post('/skip', async (req, res) => {
  const { ids = [] } = req.body;
  await Promise.all(ids.map(id => updateLead(id, { status: 'skipped' })));
  res.json({ success: true, skipped: ids.length });
});

// POST /api/scraper/delete
router.post('/delete', async (req, res) => {
  const { ids = [] } = req.body;
  if (!ids.length) return res.status(400).json({ success: false, error: 'No IDs provided' });
  try {
    const count = await deleteLeads(ids);
    logger.info('Leads deleted', { count });
    res.json({ success: true, deleted: count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scraper/enrich/start
// Body: { leadId, method }  method='claude' (default, sync) | method='apify' (async)
router.post('/enrich/start', async (req, res) => {
  const { leadId, method = 'claude' } = req.body;
  if (!leadId) return res.status(400).json({ success: false, error: 'leadId is required' });

  try {
    const { leads } = await getLeads({ limit: 5000 });
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!lead.website) return res.status(400).json({ success: false, error: 'Lead has no website' });

    if (method === 'apify') {
      if (!process.env.APIFY_API_TOKEN) {
        return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
      }
      const { enrichRunId, datasetId } = await startEnrichCrawl(lead.website);
      enrichJobs.set(enrichRunId, { leadId, status: 'RUNNING', datasetId });
      await updateLead(leadId, { enrichRunId });
      logger.info('Apify enrich started', { enrichRunId, leadId });
      return res.json({ success: true, status: 'RUNNING', enrichRunId });
    }

    // Claude direct mode — synchronous, returns contacts immediately
    logger.info('Claude direct enrich', { leadId, website: lead.website });
    const contacts = await enrichWebsite(lead.website, lead.name);
    await updateLead(leadId, { contacts: JSON.stringify(contacts), enrichedAt: new Date().toISOString() });
    logger.info('Claude enrich complete', { leadId, contactCount: contacts.length });
    return res.json({ success: true, status: 'DONE', contacts, contactCount: contacts.length });

  } catch (err) {
    logger.error('Enrich failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/enrich/status/:enrichRunId
// Polls Apify; when SUCCEEDED fetches content, sends to Claude, saves contacts on the lead
router.get('/enrich/status/:enrichRunId', async (req, res) => {
  const { enrichRunId } = req.params;
  try {
    const job = enrichJobs.get(enrichRunId) || {};
    const apifyStatus = await getEnrichStatus(enrichRunId);

    if (apifyStatus.status === 'SUCCEEDED' && job.status !== 'DONE' && job.status !== 'PROCESSING') {
      // Mark as processing to prevent duplicate extraction
      enrichJobs.set(enrichRunId, { ...job, status: 'PROCESSING' });

      // Async: fetch content, extract contacts via Claude, save to lead
      const leadId = job.leadId;
      const { leads } = await getLeads({});
      const lead = leads.find(l => l.id === leadId);
      const churchName = lead ? lead.name : '';

      extractContactsFromDataset(apifyStatus.datasetId || job.datasetId, churchName)
        .then(contacts => {
          updateLead(leadId, { contacts: JSON.stringify(contacts), enrichedAt: new Date().toISOString() });
          enrichJobs.set(enrichRunId, { ...enrichJobs.get(enrichRunId), status: 'DONE', contactCount: contacts.length });
          logger.info('Enrich complete', { enrichRunId, leadId, contactCount: contacts.length });
        })
        .catch(err => {
          enrichJobs.set(enrichRunId, { ...enrichJobs.get(enrichRunId), status: 'ERROR', error: err.message });
          logger.error('Enrich extraction failed', { enrichRunId, error: err.message });
        });

      return res.json({ success: true, status: 'PROCESSING', message: 'Extracting contacts with Claude AI…' });
    }

    const localStatus = job.status || apifyStatus.status;
    res.json({
      success: true,
      status: localStatus,
      apifyStatus: apifyStatus.status,
      contactCount: job.contactCount || 0,
      error: job.error || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scraper/enrich/batch
router.post('/enrich/batch', async (req, res) => {
  try {
    if (!process.env.APIFY_API_TOKEN) {
      return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
    }
    const { leads: allLeads } = await getLeads({ hasWebsite: 'true', limit: 2000 });
    const toEnrich = allLeads.filter(l => !!l.website);
    if (!toEnrich.length) {
      return res.json({ success: false, error: 'No leads with websites found. Run a scrape first.' });
    }
    const { batchRunId, datasetId, domainToLeadId } = await startBatchEnrichCrawl(toEnrich);
    batchJobs.set(batchRunId, { domainToLeadId, datasetId, status: 'RUNNING', total: toEnrich.length });
    await markBatchLeads(toEnrich.map(l => l.id), batchRunId);
    const urlCount = Object.keys(domainToLeadId).length * 6;
    logger.info('Batch enrich started', { batchRunId, leads: toEnrich.length });
    res.json({ success: true, batchRunId, leadCount: toEnrich.length, urlCount });
  } catch (err) {
    logger.error('Batch enrich start failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/enrich/batch/status/:batchRunId
router.get('/enrich/batch/status/:batchRunId', async (req, res) => {
  const { batchRunId } = req.params;
  try {
    const { total, done } = await getBatchProgress(batchRunId);
    if (total > 0 && done >= total) {
      return res.json({ success: true, status: 'DONE', total, done });
    }
    let job = batchJobs.get(batchRunId);
    const apifyStatus = await getEnrichStatus(batchRunId);

    if (apifyStatus.status === 'RUNNING' || apifyStatus.status === 'READY') {
      return res.json({ success: true, status: 'CRAWLING', total, done });
    }
    if (apifyStatus.status === 'FAILED' || apifyStatus.status === 'ABORTED') {
      return res.json({ success: true, status: 'ERROR', error: 'Apify run ' + apifyStatus.status });
    }
    if (apifyStatus.status === 'SUCCEEDED') {
      if (!job || !job.items) {
        const items = await fetchAllDatasetItems(apifyStatus.datasetId || (job && job.datasetId));
        const itemsByDomain = groupItemsByDomain(items);
        job = { ...(job || { domainToLeadId: {}, total }), items, itemsByDomain, status: 'PROCESSING' };
        batchJobs.set(batchRunId, job);
      }
      const { leads: batchLeads } = await getLeads({ limit: 2000 });
      const pending = batchLeads.filter(l => l.batchEnrichRunId === batchRunId && !l.enrichedAt);
      if (!pending.length) {
        return res.json({ success: true, status: 'DONE', total, done });
      }
      const chunk = pending.slice(0, 4);
      await Promise.all(chunk.map(async lead => {
        try {
          const domain = getDomain(lead.website || '');
          const churchItems = (job.itemsByDomain || {})[domain] || [];
          const contacts = churchItems.length ? await extractContactsForChurch(churchItems, lead.name) : [];
          await updateLead(lead.id, { contacts: JSON.stringify(contacts), enrichedAt: new Date().toISOString() });
        } catch {
          await updateLead(lead.id, { enrichedAt: new Date().toISOString(), contacts: '[]' });
        }
      }));
      const newDone = done + chunk.length;
      return res.json({ success: true, status: pending.length > chunk.length ? 'PROCESSING' : 'DONE', total, done: newDone, pending: pending.length - chunk.length });
    }
    return res.json({ success: true, status: 'CRAWLING', total, done });
  } catch (err) {
    logger.error('Batch status failed', { batchRunId, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/export
router.get('/export', async (req, res) => {
  try {
    const { minScore, maxScore, location, hasWebsite, status, sort } = req.query;
    const csv = await exportCSV({ minScore, maxScore, location, hasWebsite, status, sort });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="church-leads-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/preview — estimate leads before running (checks DB + location)
router.get('/preview', async (req, res) => {
  try {
    const { location = '', searchType = 'orthodox' } = req.query;
    const { total: existing } = await getLeads({ location });
    res.json({
      success: true,
      existing,
      location: location || 'United States',
      searchType,
      estimate: searchType === 'orthodox' ? '10–60 per city' : '50–200 per city',
      message: `You already have ${existing} leads${location ? ' in ' + location : ''}. A new scrape will skip duplicates automatically.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/directory/timezones
// Returns all timezone options with their state lists
router.get('/directory/timezones', (req, res) => {
  const list = Object.entries(TIMEZONES).map(([id, { label, states }]) => ({
    id,
    label,
    stateCount: states.length,
    states,
  }));
  res.json({ success: true, timezones: list });
});

// POST /api/scraper/directory/oca/state
// Body: { state } — scrapes ONE US state from OCA clergy directory and saves leads.
// Called repeatedly by the frontend (one state per request) to stay under Vercel timeout.
router.post('/directory/oca/state', async (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ success: false, error: 'state is required' });

  try {
    const clergy = await scrapeStateClergy(state.toUpperCase());

    if (!clergy.length) {
      return res.json({ success: true, state, found: 0, saved: 0, skipped: 0 });
    }

    // Build lead objects — each clergy entry becomes a lead with contacts pre-filled
    const leads = clergy.map(c => ({
      id:          generateId(),
      name:        c.parishName,
      phone:       c.phone || null,
      city:        c.city || null,
      state:       c.state,
      address:     c.city ? `${c.city}, ${c.stateName}` : c.stateName,
      category:    'Orthodox Church',
      hasWebsite:  false,
      score:       8,
      scoreReason: `OCA directory${c.clergyName ? ` — ${c.clergyName}` : ''}`,
      denomination: 'OCA',
      source:      'directory-oca',
      status:      'new',
      scrapedAt:   new Date().toISOString(),
      contacts:    c.clergyName
        ? [{ name: c.clergyName, title: c.clergyTitle || 'Priest', phone: c.phone || null, email: null }]
        : [],
      enrichedAt:  c.clergyName ? new Date().toISOString() : null,
    }));

    const { added, skipped } = await saveLeads(leads);

    res.json({ success: true, state, found: clergy.length, saved: added, skipped });
  } catch (err) {
    logger.error('[directory/oca/state] error', { state, error: err.message });
    res.json({ success: false, state, error: err.message, found: 0, saved: 0, skipped: 0 });
  }
});

module.exports = router;
