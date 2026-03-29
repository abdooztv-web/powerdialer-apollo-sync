const axios = require('axios');
const https = require('https');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL     = 'claude-haiku-4-5-20251001';
const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_ENRICH_ACTOR = 'apify~website-content-crawler';

// Pages most likely to have pastor/staff contact info
const STAFF_PATHS = [
  '/staff', '/about', '/leadership', '/clergy', '/contact',
  '/our-team', '/team', '/pastor', '/ministers',
  '/meet-the-staff', '/about-us', '/',
];

// Shared axios instance: bypass SSL cert issues on old church websites
const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  },
});

function apifyHeaders() {
  return { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` };
}

// ── HTML → TEXT ───────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  const emails = [];
  html.replace(/href=["']mailto:([^"']+)["']/gi, (_, e) => emails.push(e));
  const phones = [];
  html.replace(/href=["']tel:([^"']+)["']/gi, (_, p) => phones.push(p));

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');

  text = text.replace(/<\/?(p|div|li|h[1-6]|br|tr|td|th)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/&[a-z]+;/g, ' ');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (emails.length) text += '\n\nEmails found: ' + emails.join(', ');
  if (phones.length) text += '\nPhones found: ' + phones.join(', ');
  return text;
}

async function fetchPage(url) {
  try {
    const res = await httpClient.get(url);
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('html')) return '';
    return htmlToText(res.data || '');
  } catch {
    return '';
  }
}

// ── CLAUDE CONTACT EXTRACTION ─────────────────────────────────

async function callClaudeForContacts(pageText, churchName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const prompt = `You are a specialized data extractor for church websites. Extract contact information for church leaders.

Church: ${churchName || 'Unknown Church'}

Website content:
${pageText}

Look for people with these roles: Pastor, Reverend, Father, Priest, Elder, Deacon, Bishop, Archbishop, Administrator, Office Manager, Director, Secretary, Minister, Vicar, Rector.

For each person found, extract:
1. Full name (required)
2. Title/role (required — use their church title like "Senior Pastor", "Parish Priest", etc.)
3. Email address (look for: mailto: links, patterns like name@domain.com, text near "email:" or "contact:")
4. Phone number (look for: tel: links, patterns like (xxx) xxx-xxxx or xxx-xxx-xxxx near their name)

Return ONLY a valid JSON array. No extra text, no markdown, just the array:
[{"name": "...", "title": "...", "email": "...", "phone": "..."}]

Rules:
- Use null for any field not found
- Only real named people, not generic roles like "Office" or "Info"
- Prefer direct/personal emails over generic info@church.org
- If absolutely nothing found, return []`;

  try {
    const res = await axios.post(
      CLAUDE_API,
      { model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const text = res.data.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── CLAUDE DIRECT MODE (synchronous) ─────────────────────────

async function enrichWebsite(website, churchName) {
  const base = (website || '').replace(/\/+$/, '');
  if (!base) return [];

  const results = await Promise.allSettled(
    STAFF_PATHS.map(path => fetchPage(base + path))
  );

  const chunks = [];
  results.forEach((r, i) => {
    const text = r.status === 'fulfilled' ? r.value : '';
    if (text && text.length > 80) {
      chunks.push(`--- ${STAFF_PATHS[i] || '/'} ---\n${text.slice(0, 1400)}`);
    }
  });

  if (!chunks.length) return [];
  return callClaudeForContacts(chunks.join('\n\n').slice(0, 14000), churchName);
}

// ── APIFY MODE (async, start + poll + extract) ────────────────

async function startEnrichCrawl(website) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN is not set');

  // Build start URLs targeting staff/contact pages
  const base = website.replace(/\/+$/, '');
  const startUrls = [
    base + '/',
    base + '/staff',
    base + '/about',
    base + '/leadership',
    base + '/clergy',
    base + '/contact',
    base + '/our-team',
    base + '/pastor',
  ].map(url => ({ url }));

  const input = {
    startUrls,
    maxCrawlDepth: 1,
    maxCrawlPages: 12,
    crawlerType: 'cheerio',
    htmlTransformer: 'readableText',
    readableTextCharThreshold: 100,
  };

  const res = await axios.post(
    `${APIFY_BASE}/acts/${APIFY_ENRICH_ACTOR}/runs`,
    input,
    { headers: { ...apifyHeaders(), 'Content-Type': 'application/json' } }
  );

  const run = res.data.data;
  return { enrichRunId: run.id, datasetId: run.defaultDatasetId };
}

async function getEnrichStatus(runId) {
  const res = await axios.get(
    `${APIFY_BASE}/actor-runs/${runId}`,
    { headers: apifyHeaders() }
  );
  const run = res.data.data;
  return { status: run.status, datasetId: run.defaultDatasetId };
}

async function extractContactsFromDataset(datasetId, churchName) {
  const res = await axios.get(
    `${APIFY_BASE}/datasets/${datasetId}/items`,
    { headers: apifyHeaders(), params: { format: 'json', clean: true, limit: 20 } }
  );

  const items = res.data || [];
  const textChunks = items
    .filter(item => item.text || item.markdown)
    .map(item => `--- ${item.url || ''} ---\n${(item.text || item.markdown || '').slice(0, 1500)}`)
    .join('\n\n')
    .slice(0, 14000);

  if (!textChunks.trim()) return [];
  return callClaudeForContacts(textChunks, churchName);
}

// ── BATCH MODE — one Apify run for ALL churches ───────────────

/**
 * Extract hostname from a URL for domain-based matching.
 * e.g. "https://www.holytrinitychurch.org/staff" → "holytrinitychurch.org"
 */
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return (url || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

/**
 * Start ONE Apify run with ALL church website URLs at once.
 * Each church gets: home + /staff + /about + /clergy + /contact + /leadership
 * Apify crawls all of them in parallel — much faster than individual runs.
 *
 * @param {Array} leads - array of { id, website, name }
 * @returns {{ batchRunId, datasetId, domainToLeadId }}
 */
async function startBatchEnrichCrawl(leads) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN is not set');

  const BATCH_PATHS = ['/', '/staff', '/about', '/clergy', '/contact', '/leadership'];

  // Build startUrls for all churches, deduplicated
  const startUrls = [];
  const domainToLeadId = {};

  for (const lead of leads) {
    const base = (lead.website || '').replace(/\/+$/, '');
    if (!base) continue;
    const domain = getDomain(base);
    if (!domain) continue;
    domainToLeadId[domain] = { leadId: lead.id, churchName: lead.name || '' };
    for (const path of BATCH_PATHS) {
      startUrls.push({ url: base + path });
    }
  }

  if (!startUrls.length) throw new Error('No valid websites to crawl');

  const input = {
    startUrls,
    maxCrawlDepth: 0,
    maxCrawlPages: startUrls.length + 50,
    crawlerType: 'cheerio',
    htmlTransformer: 'readableText',
    readableTextCharThreshold: 80,
  };

  const res = await axios.post(
    `${APIFY_BASE}/acts/${APIFY_ENRICH_ACTOR}/runs`,
    input,
    { headers: { ...apifyHeaders(), 'Content-Type': 'application/json' } }
  );

  const run = res.data.data;
  return { batchRunId: run.id, datasetId: run.defaultDatasetId, domainToLeadId };
}

/**
 * Fetch ALL items from an Apify dataset.
 * Returns array of { url, text, markdown }
 */
async function fetchAllDatasetItems(datasetId) {
  const res = await axios.get(
    `${APIFY_BASE}/datasets/${datasetId}/items`,
    {
      headers: apifyHeaders(),
      params: { format: 'json', clean: true, limit: 2000 },
    }
  );
  return res.data || [];
}

/**
 * Group Apify dataset items by their domain.
 * Returns { 'holytrinitychurch.org': [ ...items ], ... }
 */
function groupItemsByDomain(items) {
  const groups = {};
  for (const item of items) {
    const domain = getDomain(item.url || '');
    if (!domain) continue;
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(item);
  }
  return groups;
}

/**
 * Extract contacts from Apify items for a single church.
 * Combines text from all its pages, sends to Claude.
 */
async function extractContactsForChurch(items, churchName) {
  const combined = items
    .filter(i => i.text || i.markdown)
    .map(i => `--- ${i.url || ''} ---\n${(i.text || i.markdown || '').slice(0, 1400)}`)
    .join('\n\n')
    .slice(0, 12000);

  if (!combined.trim()) return [];
  return callClaudeForContacts(combined, churchName);
}

module.exports = {
  enrichWebsite,
  startEnrichCrawl,
  getEnrichStatus,
  extractContactsFromDataset,
  // Batch exports
  startBatchEnrichCrawl,
  fetchAllDatasetItems,
  groupItemsByDomain,
  extractContactsForChurch,
  getDomain,
};
