const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '../../data/leads.json');

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(leads) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

function saveLeads(newLeads) {
  const existing = readAll();
  const existingIds = new Set(existing.map(l => l.placeId).filter(Boolean));
  const toAdd = newLeads.filter(l => !existingIds.has(l.placeId));
  const combined = [...existing, ...toAdd];
  writeAll(combined);
  return toAdd.length;
}

function getLeads(filters = {}) {
  let leads = readAll();

  if (filters.minScore !== undefined) leads = leads.filter(l => l.score >= Number(filters.minScore));
  if (filters.maxScore !== undefined) leads = leads.filter(l => l.score <= Number(filters.maxScore));
  if (filters.location) {
    const loc = filters.location.toLowerCase();
    leads = leads.filter(l =>
      (l.city && l.city.toLowerCase().includes(loc)) ||
      (l.state && l.state.toLowerCase().includes(loc)) ||
      (l.address && l.address.toLowerCase().includes(loc))
    );
  }
  if (filters.hasWebsite === 'false' || filters.hasWebsite === false) {
    leads = leads.filter(l => !l.hasWebsite);
  } else if (filters.hasWebsite === 'true' || filters.hasWebsite === true) {
    leads = leads.filter(l => l.hasWebsite);
  }
  if (filters.status) leads = leads.filter(l => l.status === filters.status);

  const sort = filters.sort || 'score';
  leads.sort((a, b) => {
    if (sort === 'score') return (b.score || 0) - (a.score || 0);
    if (sort === 'date') return new Date(b.scrapedAt) - new Date(a.scrapedAt);
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    return 0;
  });

  const limit = filters.limit ? Number(filters.limit) : undefined;
  const offset = filters.offset ? Number(filters.offset) : 0;
  const paginated = limit ? leads.slice(offset, offset + limit) : leads.slice(offset);

  return { leads: paginated, total: leads.length };
}

function updateLead(id, updates) {
  const leads = readAll();
  const idx = leads.findIndex(l => l.id === id);
  if (idx === -1) return null;
  leads[idx] = { ...leads[idx], ...updates };
  writeAll(leads);
  return leads[idx];
}

function getStats() {
  const leads = readAll();
  return {
    total: leads.length,
    scored: leads.filter(l => l.score != null).length,
    pushed: leads.filter(l => l.status === 'pushed').length,
    skipped: leads.filter(l => l.status === 'skipped').length,
    new: leads.filter(l => l.status === 'new').length,
  };
}

function exportCSV(filters = {}) {
  const { leads } = getLeads(filters);
  const headers = ['Name', 'Phone', 'Website', 'Has Website', 'Category', 'Address', 'City', 'State', 'Reviews', 'Rating', 'Score', 'Score Reason', 'Suggested Sequence', 'Status', 'Scraped At'];
  const rows = leads.map(l => [
    l.name || '',
    l.phone || '',
    l.website || '',
    l.hasWebsite ? 'Yes' : 'No',
    l.category || '',
    l.address || '',
    l.city || '',
    l.state || '',
    l.reviewCount || 0,
    l.rating || '',
    l.score || '',
    l.scoreReason || '',
    l.suggestedSequence || '',
    l.status || '',
    l.scrapedAt || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

module.exports = { saveLeads, getLeads, updateLead, getStats, exportCSV, generateId };
