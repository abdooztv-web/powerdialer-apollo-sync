const axios = require('axios');
const https = require('https');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// Pages most likely to have pastor/staff contact info
const STAFF_PATHS = [
  '/staff',
  '/about',
  '/leadership',
  '/clergy',
  '/contact',
  '/our-team',
  '/team',
  '/pastor',
  '/ministers',
  '/meet-the-staff',
  '/about-us',
  '/',
];

// Shared axios instance: bypass SSL cert issues on old church websites
const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  },
});

/**
 * Strip HTML tags and collapse whitespace to get readable plain text.
 * Also extracts mailto: and tel: links before stripping.
 */
function htmlToText(html) {
  if (!html) return '';

  // Pull out email addresses from mailto: links before stripping
  const emails = [];
  html.replace(/href=["']mailto:([^"']+)["']/gi, (_, e) => emails.push(e));

  // Pull out phone numbers from tel: links
  const phones = [];
  html.replace(/href=["']tel:([^"']+)["']/gi, (_, p) => phones.push(p));

  // Remove script/style blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');

  // Replace block tags with newlines
  text = text.replace(/<\/?(p|div|li|h[1-6]|br|tr|td|th)[^>]*>/gi, '\n');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Append found emails/phones so Claude can see them
  if (emails.length) text += '\n\nEmails found: ' + emails.join(', ');
  if (phones.length) text += '\nPhones found: ' + phones.join(', ');

  return text;
}

/**
 * Fetch one page. Returns plain text or '' on failure.
 */
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

/**
 * Scrape a church website and extract staff contacts using Claude.
 * Returns array of { name, title, email, phone }
 * This is synchronous — no Apify, no polling needed.
 */
async function enrichWebsite(website, churchName) {
  const base = (website || '').replace(/\/+$/, '');
  if (!base) return [];

  // Fetch all staff pages in parallel
  const results = await Promise.allSettled(
    STAFF_PATHS.map(path => fetchPage(base + path))
  );

  // Combine non-empty page texts, label with their path
  const chunks = [];
  results.forEach((r, i) => {
    const text = r.status === 'fulfilled' ? r.value : '';
    if (text && text.length > 80) {
      chunks.push(`--- ${STAFF_PATHS[i] || '/'} ---\n${text.slice(0, 1200)}`);
    }
  });

  if (!chunks.length) return [];

  const combinedText = chunks.join('\n\n').slice(0, 14000);
  return callClaudeForContacts(combinedText, churchName);
}

async function callClaudeForContacts(pageText, churchName) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const prompt = `You are analyzing church website content to find staff contacts.

Church: ${churchName || 'Unknown Church'}

Website content:
${pageText}

Extract all staff members / church leaders you can find (pastor, reverend, father, elder, deacon, administrator, director, minister, priest, secretary, etc.).

Return ONLY a valid JSON array, no other text:
[{"name": "...", "title": "...", "email": "...", "phone": "..."}]

Rules:
- Use null for missing fields, not empty strings
- Only include real people, not departments or generic roles
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
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = { enrichWebsite };
