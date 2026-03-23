const axios = require('axios');

const APIFY_BASE = 'https://api.apify.com/v2';
// Google Maps Scraper actor maintained by Apify
const ACTOR_ID = 'nwua9Wd5YkwerdjjT';

function headers() {
  return { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` };
}

const SEARCH_PRESETS = {
  orthodox: ['Orthodox Church', 'Eastern Orthodox Church', 'Greek Orthodox Church', 'Russian Orthodox Church', 'Antiochian Orthodox', 'OCA Church'],
  small: ['Church', 'Baptist Church', 'Pentecostal Church', 'Assembly of God', 'Church of Christ', 'Methodist Church'],
  custom: null,
};

async function runGoogleMapsScrape({ searchType = 'orthodox', location = 'United States', maxResults = 200, customKeyword = null }) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN is not set');

  let searchTerms;
  if (searchType === 'custom' && customKeyword) {
    searchTerms = [`${customKeyword} ${location}`];
  } else {
    const keywords = SEARCH_PRESETS[searchType] || SEARCH_PRESETS.orthodox;
    searchTerms = keywords.map(k => `${k} ${location}`);
  }

  const input = {
    searchStringsArray: searchTerms,
    maxCrawledPlacesPerSearch: Math.ceil(maxResults / searchTerms.length),
    language: 'en',
    maxImages: 0,
    maxReviews: 0,
  };

  const res = await axios.post(
    `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${process.env.APIFY_API_TOKEN}`,
    input,
    { headers: { 'Content-Type': 'application/json' } }
  );

  const run = res.data.data;
  return { runId: run.id, datasetId: run.defaultDatasetId };
}

async function getJobStatus(runId) {
  const res = await axios.get(`${APIFY_BASE}/actor-runs/${runId}`, { headers: headers() });
  const run = res.data.data;
  return {
    status: run.status, // READY, RUNNING, SUCCEEDED, FAILED, ABORTED
    datasetId: run.defaultDatasetId,
    itemCount: run.stats?.itemCount || 0,
  };
}

async function fetchResults(datasetId) {
  const res = await axios.get(`${APIFY_BASE}/datasets/${datasetId}/items`, {
    headers: headers(),
    params: { format: 'json', clean: true, limit: 5000 },
  });

  return (res.data || []).map(place => ({
    placeId: place.placeId || place.cid || null,
    name: place.title || place.name || '',
    phone: place.phone || place.phoneUnformatted || null,
    website: place.website || null,
    hasWebsite: !!(place.website),
    category: place.categoryName || (place.categories && place.categories[0]) || '',
    address: place.address || place.street || '',
    city: place.city || extractCity(place.address) || '',
    state: place.state || extractState(place.address) || '',
    zip: place.postalCode || '',
    reviewCount: place.reviewsCount || place.totalScore?.reviewsCount || 0,
    rating: place.totalScore || place.stars || null,
    url: place.url || null,
  })).filter(p => p.name);
}

function extractCity(address) {
  if (!address) return '';
  const parts = address.split(',');
  return parts.length >= 2 ? parts[parts.length - 3]?.trim() || '' : '';
}

function extractState(address) {
  if (!address) return '';
  const match = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  return match ? match[1] : '';
}

module.exports = { runGoogleMapsScrape, getJobStatus, fetchResults };
