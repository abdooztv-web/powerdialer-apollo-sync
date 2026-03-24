const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 10;

function buildPrompt(lead) {
  return `Score this church lead 1-10 for cold outreach relevance (PowerDialer church software sales).

Scoring guide — add points:
- Orthodox/Eastern/Coptic/Armenian/Greek Orthodox church: +3
- No website listed: +3
- Under 30 Google reviews (small congregation): +2
- Has a phone number: +1
- Located outside a major metro (not NYC/LA/Chicago/Houston/Phoenix): +1

Church data:
- Name: ${lead.name}
- Category: ${lead.category || 'Unknown'}
- Website: ${lead.website || 'NONE'}
- Phone: ${lead.phone || 'NONE'}
- Reviews: ${lead.reviewCount || 0}
- Location: ${[lead.city, lead.state].filter(Boolean).join(', ') || 'Unknown'}

Return ONLY valid JSON, no other text:
{"score": <number 1-10>, "reason": "<one sentence explanation>", "suggestedSequence": "<pastors|directors|skip>"}

Routing: score 8-10 = pastors, 5-7 = directors, 1-4 = skip`;
}

async function scoreLeads(leads) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const results = [];

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    const scored = await Promise.all(batch.map(lead => scoreSingle(lead, apiKey)));
    results.push(...scored);
  }

  return results;
}

async function scoreSingle(lead, apiKey) {
  try {
    const res = await axios.post(
      CLAUDE_API,
      {
        model: MODEL,
        max_tokens: 150,
        messages: [{ role: 'user', content: buildPrompt(lead) }],
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
    const parsed = JSON.parse(text);

    return {
      ...lead,
      score: Math.max(1, Math.min(10, Number(parsed.score) || 5)),
      scoreReason: parsed.reason || '',
      suggestedSequence: parsed.suggestedSequence || 'skip',
    };
  } catch (err) {
    const errDetail = err.response?.data || err.message;
    console.error('Claude scoring error:', JSON.stringify(errDetail));
    return {
      ...lead,
      score: fallbackScore(lead),
      scoreReason: 'Auto-scored (API error: ' + (err.response?.data?.error?.message || err.message) + ')',
      suggestedSequence: fallbackScore(lead) >= 8 ? 'pastors' : fallbackScore(lead) >= 5 ? 'directors' : 'skip',
    };
  }
}

function fallbackScore(lead) {
  let score = 0;
  const cat = (lead.category || '').toLowerCase();
  if (cat.includes('orthodox') || cat.includes('eastern') || cat.includes('coptic') || cat.includes('armenian')) score += 3;
  if (!lead.hasWebsite) score += 3;
  if ((lead.reviewCount || 0) < 30) score += 2;
  if (lead.phone) score += 1;
  return Math.max(1, Math.min(10, score));
}

module.exports = { scoreLeads };
