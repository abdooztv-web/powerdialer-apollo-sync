const axios = require('axios');

// Supported denomination directories with their URLs and metadata
const DENOMINATIONS = {
  oca: {
    name: 'OCA — Orthodox Church in America',
    icon: '☦️',
    category: 'Orthodox Church',
    getUrls: (location) => {
      const state = extractState(location);
      if (state) return [`https://oca.org/parishes?state=${encodeURIComponent(state)}`];
      return ['https://oca.org/parishes'];
    },
  },
  goarch: {
    name: 'GOARCH — Greek Orthodox Archdiocese',
    icon: '☦️',
    category: 'Greek Orthodox Church',
    getUrls: (location) => {
      const state = extractState(location);
      if (state) return [`https://www.goarch.org/parishes?state=${encodeURIComponent(state)}`];
      return ['https://www.goarch.org/parishes'];
    },
  },
  antiochian: {
    name: 'Antiochian Orthodox Archdiocese',
    icon: '☦️',
    category: 'Antiochian Orthodox Church',
    getUrls: () => ['https://www.antiochian.org/parishes'],
  },
  rocor: {
    name: 'ROCOR — Russian Orthodox Church Outside Russia',
    icon: '☦️',
    category: 'Russian Orthodox Church',
    getUrls: () => ['https://www.synod.com/synod/eng2/enindex.html'],
  },
  coptic: {
    name: 'Coptic Orthodox Diocese of the Southern USA',
    icon: '✝️',
    category: 'Coptic Orthodox Church',
    getUrls: () => ['https://www.copticorthodox.church/locations'],
  },
  sbc: {
    name: 'Southern Baptist Convention',
    icon: '✝️',
    category: 'Baptist Church',
    getUrls: (location) => location
      ? [`https://churches.sbc.net/?s=${encodeURIComponent(location)}`]
      : ['https://churches.sbc.net/'],
  },
  episcopal: {
    name: 'Episcopal Church',
    icon: '✝️',
    category: 'Episcopal Church',
    getUrls: (location) => {
      const state = extractState(location);
      return [`https://www.episcopalchurch.org/parish-locator/${state ? '?state=' + encodeURIComponent(state) : ''}`];
    },
  },
  pcusa: {
    name: 'Presbyterian Church USA (PCUSA)',
    icon: '✝️',
    category: 'Presbyterian Church',
    getUrls: (location) => {
      const state = extractState(location);
      return [`https://www.pcusa.org/find-a-congregation/${state ? '?state=' + encodeURIComponent(state) : ''}`];
    },
  },
};

// Helper: extract a 2-letter state code or short location string from longer input
function extractState(location) {
  if (!location) return null;
  const s = location.trim();
  if (s.length === 2 && /^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  // Map common state names
  const MAP = {
    'ohio': 'OH', 'new york': 'NY', 'california': 'CA', 'texas': 'TX',
    'florida': 'FL', 'illinois': 'IL', 'pennsylvania': 'PA', 'michigan': 'MI',
    'georgia': 'GA', 'north carolina': 'NC', 'new jersey': 'NJ', 'virginia': 'VA',
    'washington': 'WA', 'arizona': 'AZ', 'massachusetts': 'MA', 'indiana': 'IN',
    'colorado': 'CO', 'maryland': 'MD', 'kentucky': 'KY', 'oregon': 'OR',
    'minnesota': 'MN', 'wisconsin': 'WI', 'missouri': 'MO', 'connecticut': 'CT',
    'south carolina': 'SC', 'louisiana': 'LA', 'alabama': 'AL', 'arkansas': 'AR',
  };
  return MAP[s.toLowerCase()] || null;
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
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
    maxRedirects: 5,
  });
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

  for (const url of urls) {
    const html = await fetchPage(url);
    const text = stripHtml(html);
    if (!text || text.length < 100) continue;
    const churches = await extractChurchesWithClaude(text, denomination, location);
    allChurches.push(...churches);
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
