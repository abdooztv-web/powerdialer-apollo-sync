const axios = require('axios');

// Supported denomination directories with their URLs and metadata
// Each denomination lists multiple fallback URLs to try in order.
// We use root/sitemap pages only — state filtering is done by Claude from the full text.
// JS-heavy sites include a Google cache fallback.
const DENOMINATIONS = {
  oca: {
    name: 'OCA — Orthodox Church in America',
    icon: '☦️',
    category: 'Orthodox Church',
    getUrls: () => [
      'https://www.oca.org/parishes',
      'https://www.oca.org/parishes/find',
    ],
  },
  goarch: {
    name: 'GOARCH — Greek Orthodox Archdiocese',
    icon: '☦️',
    category: 'Greek Orthodox Church',
    getUrls: () => [
      'https://www.goarch.org/parishes',
      'https://www.goarch.org/directory',
    ],
  },
  antiochian: {
    name: 'Antiochian Orthodox Archdiocese',
    icon: '☦️',
    category: 'Antiochian Orthodox Church',
    getUrls: () => [
      'https://www.antiochian.org/parishes',
      'https://www.antiochian.org/find-a-parish',
    ],
  },
  rocor: {
    name: 'ROCOR — Russian Orthodox Church Outside Russia',
    icon: '☦️',
    category: 'Russian Orthodox Church',
    getUrls: () => [
      'https://www.synod.com/synod/eng2/enindex.html',
      'https://www.synod.com/parishes',
    ],
  },
  coptic: {
    name: 'Coptic Orthodox Diocese of the Southern USA',
    icon: '✝️',
    category: 'Coptic Orthodox Church',
    getUrls: () => [
      'https://copticchurch.net/parishes.html',
      'https://www.copticorthodox.church/locations',
    ],
  },
  sbc: {
    name: 'Southern Baptist Convention',
    icon: '✝️',
    category: 'Baptist Church',
    getUrls: (location) => location
      ? [`https://churches.sbc.net/?s=${encodeURIComponent(location)}`, 'https://churches.sbc.net/']
      : ['https://churches.sbc.net/'],
  },
  episcopal: {
    name: 'Episcopal Church',
    icon: '✝️',
    category: 'Episcopal Church',
    getUrls: () => [
      'https://www.episcopalchurch.org/parish-locator/',
      'https://www.episcopalchurch.org/find-a-church/',
    ],
  },
  pcusa: {
    name: 'Presbyterian Church USA (PCUSA)',
    icon: '✝️',
    category: 'Presbyterian Church',
    getUrls: () => [
      'https://www.pcusa.org/find-a-congregation/',
      'https://www.pcusa.org/congregations/',
    ],
  },
};

// Helper: extract a 2-letter state code or short location string from longer input
// Used by Claude prompt to focus extraction on a specific location
function extractState(location) {
  if (!location) return null;
  const s = location.trim();
  if (s.length === 2 && /^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const MAP = {
    'ohio': 'OH', 'new york': 'NY', 'california': 'CA', 'texas': 'TX',
    'florida': 'FL', 'illinois': 'IL', 'pennsylvania': 'PA', 'michigan': 'MI',
    'georgia': 'GA', 'north carolina': 'NC', 'new jersey': 'NJ', 'virginia': 'VA',
    'washington': 'WA', 'arizona': 'AZ', 'massachusetts': 'MA', 'indiana': 'IN',
    'colorado': 'CO', 'maryland': 'MD', 'kentucky': 'KY', 'oregon': 'OR',
    'minnesota': 'MN', 'wisconsin': 'WI', 'missouri': 'MO', 'connecticut': 'CT',
    'south carolina': 'SC', 'louisiana': 'LA', 'alabama': 'AL', 'arkansas': 'AR',
    'new mexico': 'NM', 'nevada': 'NV', 'utah': 'UT', 'kansas': 'KS',
    'iowa': 'IA', 'oklahoma': 'OK', 'tennessee': 'TN', 'mississippi': 'MS',
  };
  return MAP[s.toLowerCase()] || s; // return as-is if not found
}

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    timeout: 12000,
    maxRedirects: 5,
    validateStatus: (s) => s < 400, // treat 4xx as errors to try next fallback
  });
  if (!res.data || typeof res.data !== 'string') return '';
  return res.data;
}

async function extractChurchesWithClaude(pageText, denomination, location) {
  const locationHint = location ? `\nFocus on churches in: ${location}` : '';
  const text = pageText.slice(0, 14000); // stay under Claude context

  const prompt = `You are reading text extracted from a church denomination directory website.
Extract ALL churches/parishes listed in this text.${locationHint}

For each church, extract EVERY field you can find:
- name: full official church name
- address: street address
- city: city name
- state: 2-letter US state code
- phone: church office phone number (digits or formatted)
- website: church website URL
- pastorName: priest/pastor/rector full name INCLUDING honorific (Fr., Rev., Pastor, Deacon, etc.)
- pastorTitle: their role (Rector, Senior Pastor, Vicar, Priest-in-Charge, etc.)
- email: any email address

Rules:
- Include ALL churches you find, even if some fields are missing
- If no pastor is listed, set pastorName to null
- If no phone is listed, set phone to null
- Return ONLY a JSON object, no extra text

Return JSON:
{
  "churches": [
    { "name": "...", "address": "...", "city": "...", "state": "...", "phone": "...", "website": "...", "pastorName": "...", "pastorTitle": "...", "email": "..." }
  ]
}

Directory text:
${text}`;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const content = res.data.content[0].text;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return (parsed.churches || []).filter(c => c.name && c.name.length > 2);
}

async function importFromDirectory(denomination, location) {
  const config = DENOMINATIONS[denomination];
  if (!config) throw new Error(`Unknown denomination: ${denomination}`);

  const urls = config.getUrls(location);
  let allChurches = [];
  let lastError = null;
  let anyPageLoaded = false;

  for (const url of urls) {
    try {
      const html = await fetchPage(url);
      const text = stripHtml(html);
      // Skip pages with too little content (JS-rendered shell pages return ~200 chars)
      if (!text || text.length < 300) continue;
      anyPageLoaded = true;
      const churches = await extractChurchesWithClaude(text, denomination, location);
      allChurches.push(...churches);
      // If we got useful results, stop trying fallbacks
      if (churches.length > 0) break;
    } catch (err) {
      lastError = err;
      // Try next URL on error
    }
  }

  if (!anyPageLoaded && lastError) {
    throw new Error(
      `Could not load the ${config.name} directory. ` +
      `The website may be unavailable or requires a browser to render. ` +
      `(${lastError.message})`
    );
  }

  // Deduplicate by name+city
  const seen = new Set();
  return allChurches.filter(c => {
    const key = ((c.name || '') + '|' + (c.city || '')).toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { DENOMINATIONS, importFromDirectory };
