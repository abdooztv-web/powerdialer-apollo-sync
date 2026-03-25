const axios = require('axios');

const PAGES_TO_TRY = ['', '/staff', '/about', '/leadership', '/clergy', '/contact', '/our-team', '/team', '/about-us', '/pastor', '/ministers', '/meet-the-staff'];

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxContentLength: 300000,
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      maxRedirects: 5,
    });
    return res.data;
  } catch {
    return null;
  }
}

function extractText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 3000);
}

async function gatherWebsiteContent(website) {
  const base = website.replace(/\/+$/, '');
  let combined = '';

  for (const page of PAGES_TO_TRY) {
    const html = await fetchPage(base + page);
    const text = extractText(html);
    if (text.length > 100) {
      combined += `\n--- ${page || '/'} ---\n${text}`;
      if (combined.length > 7000) break;
    }
  }

  return combined.substring(0, 7000);
}

async function extractContacts(content, churchName, apiKey) {
  const prompt = `Extract ALL staff/leadership contacts from this church website content for "${churchName}".

Find people with titles like: Pastor, Senior Pastor, Father, Reverend, Priest, Bishop, Director, Administrator, Minister, Deacon, Office Manager, Secretary, Youth Director, Music Director.

Website content:
${content}

Return ONLY a valid JSON array, no other text:
[{"name":"Full Name","title":"Their Title","email":"email or null","phone":"phone or null"}]

If no contacts found return: []`;

  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-haiku-4-5-20251001', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  let text = res.data.content[0].text.trim();
  // Strip markdown code blocks
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Extract JSON array
  const match = text.match(/\[[\s\S]*\]/);
  return match ? JSON.parse(match[0]) : [];
}

module.exports = { gatherWebsiteContent, extractContacts };
