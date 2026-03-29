const express = require('express');
const router = express.Router();
const { runGoogleMapsScrape, getJobStatus, fetchResults } = require('../scrapers/apify');
const { scoreLeads } = require('../enrichment/scorer');
const { enrichWebsite, startEnrichCrawl, getEnrichStatus, extractContactsFromDataset,
        startBatchEnrichCrawl, fetchAllDatasetItems, groupItemsByDomain, extractContactsForChurch, getDomain } = require('../enrichment/websiteEnricher');
const { saveLeads, getLeads, updateLead, getStats, exportCSV, generateId, getRunResult, getBatchProgress, markBatchLeads } = require('../store/leads');
const { findContactByEmail, addToSequence } = require('../handlers/apollo');
const logger = require('../utils/logger');

// Active scrape jobs tracked in memory (runId -> status)
const activeJobs = new Map();

// Active Apify enrich jobs tracked in memory (enrichRunId -> { leadId, status, datasetId })
// Note: used only for same-instance polling; DB is the source of truth for completion
const enrichJobs = new Map();

// Batch enrich jobs: batchRunId -> { domainToLeadId, datasetId, status, items? }
// domainToLeadId: { 'church.org': { leadId, churchName } }
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
      // Check DB first — if this runId already has leads saved, return immediately.
      // This prevents reprocessing when Vercel spins up a new cold-start instance
      // and the in-memory activeJobs Map is empty (job.scored is lost).
      const alreadySaved = await getRunResult(runId);
      if (alreadySaved > 0) {
        return res.json({ success: true, status: 'DONE', count: alreadySaved, skipped: 0, total: alreadySaved });
      }

      // Also skip if already processing in this instance
      if (job.scored) {
        const localStatus = job.status || 'PROCESSING';
        return res.json({ success: true, status: localStatus, count: job.count || 0, skipped: job.skipped || 0 });
      }

      // Mark scored in memory to prevent concurrent polls in the same instance
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

// POST /api/scraper/enrich/start
// Body: { leadId, method }
//   method='claude' (default) — synchronous direct HTTP fetch, returns contacts immediately
//   method='apify'            — starts Apify website-content-crawler, returns enrichRunId for polling
router.post('/enrich/start', async (req, res) => {
  const { leadId, method = 'claude' } = req.body;
  if (!leadId) return res.status(400).json({ success: false, error: 'leadId is required' });

  try {
    const { leads } = await getLeads({ limit: 5000 });
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!lead.website) return res.status(400).json({ success: false, error: 'Lead has no website' });

    if (method === 'apify') {
      // ── APIFY MODE: async start → poll /enrich/status/:runId ──
      if (!process.env.APIFY_API_TOKEN) {
        return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
      }
      const { enrichRunId, datasetId } = await startEnrichCrawl(lead.website);
      enrichJobs.set(enrichRunId, { leadId, status: 'RUNNING', datasetId });
      await updateLead(leadId, { enrichRunId });
      logger.info('Apify enrich started', { enrichRunId, leadId, website: lead.website });
      return res.json({ success: true, status: 'RUNNING', enrichRunId });
    }

    // ── CLAUDE DIRECT MODE: synchronous, contacts returned immediately ──
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
// Used by Apify mode to poll completion. DB-backed: if lead already has enrichedAt, returns DONE.
router.get('/enrich/status/:enrichRunId', async (req, res) => {
  const { enrichRunId } = req.params;
  try {
    // DB-backed idempotency: check if this lead was already enriched (survives Vercel cold starts)
    const { leads } = await getLeads({ limit: 5000 });
    const lead = leads.find(l => l.enrichRunId === enrichRunId);

    if (lead && lead.enrichedAt) {
      // Already processed — return contacts from DB
      let contacts = lead.contacts || [];
      if (typeof contacts === 'string') { try { contacts = JSON.parse(contacts); } catch { contacts = []; } }
      return res.json({ success: true, status: 'DONE', contactCount: contacts.length });
    }

    // Check Apify status
    const apifyStatus = await getEnrichStatus(enrichRunId);

    if (apifyStatus.status === 'SUCCEEDED') {
      const job = enrichJobs.get(enrichRunId) || {};
      const leadId = job.leadId || (lead && lead.id);

      if (!leadId) {
        return res.json({ success: true, status: 'DONE', contactCount: 0 });
      }

      // Extract contacts from dataset and save — mark as PROCESSING in memory
      enrichJobs.set(enrichRunId, { ...job, status: 'PROCESSING' });

      const churchName = lead ? lead.name : '';
      extractContactsFromDataset(apifyStatus.datasetId || job.datasetId, churchName)
        .then(contacts => {
          updateLead(leadId, { contacts: JSON.stringify(contacts), enrichedAt: new Date().toISOString() });
          enrichJobs.set(enrichRunId, { ...enrichJobs.get(enrichRunId), status: 'DONE', contactCount: contacts.length });
          logger.info('Apify enrich complete', { enrichRunId, leadId, contactCount: contacts.length });
        })
        .catch(err => {
          enrichJobs.set(enrichRunId, { ...enrichJobs.get(enrichRunId), status: 'ERROR', error: err.message });
        });

      return res.json({ success: true, status: 'PROCESSING' });
    }

    if (apifyStatus.status === 'FAILED' || apifyStatus.status === 'ABORTED') {
      return res.json({ success: true, status: 'ERROR', error: 'Apify run ' + apifyStatus.status });
    }

    const memStatus = (enrichJobs.get(enrichRunId) || {}).status || apifyStatus.status;
    return res.json({ success: true, status: memStatus });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/scraper/enrich/batch
// Starts ONE Apify run crawling ALL church websites simultaneously.
// Body: { leadIds? } — if omitted, uses all leads with websites and no contacts yet.
router.post('/enrich/batch', async (req, res) => {
  try {
    if (!process.env.APIFY_API_TOKEN) {
      return res.status(400).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
    }

    // Fetch all leads with websites and no contacts yet
    const { leads: allLeads } = await getLeads({ hasWebsite: 'true', limit: 2000 });
    const toEnrich = allLeads.filter(l => {
      if (!l.website) return false;
      const c = l.contacts;
      if (!c) return true;
      if (Array.isArray(c)) return c.length === 0;
      if (typeof c === 'string') {
        try { return JSON.parse(c).length === 0; } catch { return true; }
      }
      return true;
    });

    if (!toEnrich.length) {
      return res.json({ success: false, error: 'No website leads without contacts found. All done!' });
    }

    logger.info('Starting batch enrich', { count: toEnrich.length });

    const { batchRunId, datasetId, domainToLeadId } = await startBatchEnrichCrawl(toEnrich);

    // Store the domain→lead mapping in memory and in DB
    batchJobs.set(batchRunId, {
      domainToLeadId,
      datasetId,
      status: 'RUNNING',
      total: toEnrich.length,
      startedAt: new Date().toISOString(),
    });

    // Mark all included leads with this batchRunId in DB (for progress tracking)
    await markBatchLeads(toEnrich.map(l => l.id), batchRunId);

    const urlCount = Object.keys(domainToLeadId).length * 6; // 6 paths per church
    logger.info('Batch enrich started', { batchRunId, leads: toEnrich.length, urls: urlCount });

    res.json({
      success: true,
      batchRunId,
      leadCount: toEnrich.length,
      urlCount,
      message: `Apify is crawling ${toEnrich.length} church websites (${urlCount} pages) in parallel`,
    });
  } catch (err) {
    logger.error('Batch enrich start failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/scraper/enrich/batch/status/:batchRunId
// Polls Apify. When SUCCEEDED, processes churches in chunks of 8 per request.
// Each poll call processes 8 more churches — distributes work to avoid Vercel timeouts.
router.get('/enrich/batch/status/:batchRunId', async (req, res) => {
  const { batchRunId } = req.params;
  try {
    // Get DB progress first — source of truth for how many are done
    const { total, done } = await getBatchProgress(batchRunId);

    // If all done per DB
    if (total > 0 && done >= total) {
      if (batchJobs.has(batchRunId)) {
        batchJobs.set(batchRunId, { ...batchJobs.get(batchRunId), status: 'DONE' });
      }
      return res.json({ success: true, status: 'DONE', total, done, found: done });
    }

    // Get or reconstruct job from memory
    let job = batchJobs.get(batchRunId);

    // Check Apify run status
    const apifyStatus = await getEnrichStatus(batchRunId);

    if (apifyStatus.status === 'RUNNING' || apifyStatus.status === 'READY') {
      return res.json({ success: true, status: 'CRAWLING', total, done, apifyStatus: apifyStatus.status });
    }

    if (apifyStatus.status === 'FAILED' || apifyStatus.status === 'ABORTED') {
      return res.json({ success: true, status: 'ERROR', error: 'Apify run ' + apifyStatus.status, total, done });
    }

    if (apifyStatus.status === 'SUCCEEDED') {
      // Fetch dataset items once and cache in memory
      if (!job || !job.items) {
        const items = await fetchAllDatasetItems(apifyStatus.datasetId || (job && job.datasetId));
        const itemsByDomain = groupItemsByDomain(items);
        const existing = job || { domainToLeadId: {}, total, status: 'SUCCEEDED' };
        job = { ...existing, items, itemsByDomain, status: 'PROCESSING' };
        batchJobs.set(batchRunId, job);
        logger.info('Batch dataset fetched', { batchRunId, itemCount: items.length, domains: Object.keys(itemsByDomain).length });
      }

      // Find leads NOT yet enriched in this batch (query DB)
      const { leads: batchLeads } = await getLeads({ limit: 2000 });
      const pending = batchLeads.filter(l =>
        l.batchEnrichRunId === batchRunId && !l.enrichedAt
      );

      if (!pending.length) {
        batchJobs.set(batchRunId, { ...job, status: 'DONE' });
        return res.json({ success: true, status: 'DONE', total, done, found: done });
      }

      // Process next chunk of 8 leads (stays under Vercel timeout)
      const chunk = pending.slice(0, 8);
      const itemsByDomain = job.itemsByDomain || {};

      await Promise.all(chunk.map(async lead => {
        try {
          const domain = getDomain(lead.website || '');
          const churchItems = itemsByDomain[domain] || [];
          const contacts = churchItems.length
            ? await extractContactsForChurch(churchItems, lead.name)
            : [];
          await updateLead(lead.id, {
            contacts: JSON.stringify(contacts),
            enrichedAt: new Date().toISOString(),
          });
          logger.info('Batch: church enriched', { leadId: lead.id, domain, contactCount: contacts.length });
        } catch (err) {
          // Mark as done even on error so it doesn't block progress
          await updateLead(lead.id, { enrichedAt: new Date().toISOString(), contacts: '[]' });
          logger.warn('Batch: church enrich failed', { leadId: lead.id, error: err.message });
        }
      }));

      const newDone = done + chunk.length;
      const stillPending = pending.length - chunk.length;

      return res.json({
        success: true,
        status: stillPending > 0 ? 'PROCESSING' : 'DONE',
        total,
        done: newDone,
        pending: stillPending,
      });
    }

    // Apify still in another state
    return res.json({ success: true, status: 'CRAWLING', total, done, apifyStatus: apifyStatus.status });

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

module.exports = router;
