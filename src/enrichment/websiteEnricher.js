const axios = require('axios');

const APIFY_BASE = 'https://api.apify.com/v2';
const WEBSITE_CRAWLER_ACTOR = 'apify~website-content-crawler';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function apifyHeaders() {
  return { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` };
}

/**
 * Start an Apify website-content-crawler run for a given URL.
 * Returns { enrichRunId, datasetId }
 */
// Pages most likely to contain pastor/staff contact info
const STAFF_PATHS = [
  '', '/staff', '/about', '/leadership', '/contact', '/our-team',
  '/team', '/clergy', '/pastor', '/ministers', '/meet-the-staff', '/about-us',
];

async function startEnrichCrawl(website) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN is not set');

  const base = website.replace(/\/+$/, '');
  const startUrls = STAFF_PATHS.map(path => ({ url: base + path }));

  const input = {
    startUrls,
    maxCrawlPages: 12,
    maxCrawlDepth: 0,        // 0 = only crawl the exact URLs given, no link following
    crawlerType: 'cheerio',
    htmlTransformer: 'markdown', // markdown preserves mailto:/tel: links so emails/phones survive
  };

  const res = await axios.post(
    `${APIFY_BASE}/acts/${WEBSITE_CRAWLER_ACTOR}/runs`,
    input,
    { headers: { ...apifyHeaders(), 'Content-Type': 'application/json' } }
  );

  const run = res.data.data;
  return { enrichRunId: run.id, datasetId: run.defaultDatasetId };
}

/**
 * Check the status of an Apify run.
 * Returns { status, datasetId, itemCount }
 */
async function getEnrichStatus(enrichRunId) {
  const res = await axios.get(`${APIFY_BASE}/actor-runs/${enrichRunId}`, {
    headers: apifyHeaders(),
  });
  const run = res.data.data;
  return {
    status: run.status,
    datasetId: run.defaultDatasetId,
    itemCount: run.stats?.itemCount || 0,
  };
}

/**
 * Fetch crawled page content from Apify dataset and extract contacts via Claude.
 * Returns array of contact objects: { name, title, email, phone }
 */
async function extractContactsFromDataset(datasetId, churchName) {
  const res = await axios.get(`${APIFY_BASE}/datasets/${datasetId}/items`, {
    headers: apifyHeaders(),
    params: { format: 'json', clean: true, limit: 50 },
  });

  const pages = res.data || [];
  if (!pages.length) return [];

  // Combine page content — prefer markdown (preserves mailto:/tel: links)
  // then fall back to plain text or raw html
  const combinedText = pages
    .map(p => {
      const url = p.url || p.loadedUrl || '';
      const content = p.markdown || p.text || p.html || '';
      return `URL: ${url}\n${content}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 14000); // slightly larger cap since markdown is more compact

  return callClaudeForContacts(combinedText, churchName);
}

async function callClaudeForContacts(pageText, churchName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const prompt = `You are analyzing church website content to find staff contacts.

Church: ${churchName || 'Unknown Church'}

Website content:
${pageText}

Extract all staff members / church leaders you can find (pastor, reverend, elder, deacon, administrator, director, minister, priest, secretary, etc.).

Return ONLY valid JSON array, no other text:
[{"name": "...", "title": "...", "email": "...", "phone": "..."}]

Rules:
- Use null for missing fields, not empty strings
- Only include real people, not departments
- If no contacts found, return []`;

  try {
    const res = await axios.post(
      CLAUDE_API,
      {
        model: MODEL,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const text = res.data.content[0].text.trim();
    // Extract JSON array even if wrapped in markdown
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

module.exports = { startEnrichCrawl, getEnrichStatus, extractContactsFromDataset };
