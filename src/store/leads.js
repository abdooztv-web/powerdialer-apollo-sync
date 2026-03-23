const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
let client = null;
let db = null;

async function getCollection() {
  if (!MONGO_URI) throw new Error('MONGODB_URI env var is not set');
  if (!client) {
    client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
    await client.connect();
    db = client.db('churchleads');
  }
  return db.collection('leads');
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

async function saveLeads(newLeads) {
  const col = await getCollection();
  let added = 0;
  for (const lead of newLeads) {
    const filter = lead.placeId ? { placeId: lead.placeId } : { id: lead.id };
    const result = await col.updateOne(filter, { $setOnInsert: lead }, { upsert: true });
    if (result.upsertedCount > 0) added++;
  }
  return added;
}

async function getLeads(filters = {}) {
  const col = await getCollection();
  const query = {};

  if (filters.minScore !== undefined || filters.maxScore !== undefined) {
    query.score = {};
    if (filters.minScore !== undefined) query.score.$gte = Number(filters.minScore);
    if (filters.maxScore !== undefined) query.score.$lte = Number(filters.maxScore);
  }
  if (filters.location) {
    const loc = filters.location;
    query.$or = [
      { city: { $regex: loc, $options: 'i' } },
      { state: { $regex: loc, $options: 'i' } },
      { address: { $regex: loc, $options: 'i' } },
    ];
  }
  if (filters.hasWebsite === 'false') query.hasWebsite = false;
  else if (filters.hasWebsite === 'true') query.hasWebsite = true;
  if (filters.status) query.status = filters.status;

  const sort = filters.sort || 'score';
  const mongoSort = sort === 'score' ? { score: -1 }
    : sort === 'date' ? { scrapedAt: -1 }
    : sort === 'name' ? { name: 1 }
    : { score: -1 };

  const offset = filters.offset ? Number(filters.offset) : 0;
  const limit = filters.limit ? Number(filters.limit) : 0;

  const total = await col.countDocuments(query);
  const leads = await col.find(query).sort(mongoSort).skip(offset).limit(limit).toArray();

  // Remove MongoDB _id from response
  leads.forEach(l => { delete l._id; });

  return { leads, total };
}

async function updateLead(id, updates) {
  const col = await getCollection();
  const result = await col.findOneAndUpdate(
    { id },
    { $set: updates },
    { returnDocument: 'after' }
  );
  if (!result) return null;
  delete result._id;
  return result;
}

async function getStats() {
  const col = await getCollection();
  const [total, scored, pushed, skipped, newLeads] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({ score: { $ne: null } }),
    col.countDocuments({ status: 'pushed' }),
    col.countDocuments({ status: 'skipped' }),
    col.countDocuments({ status: 'new' }),
  ]);
  return { total, scored, pushed, skipped, new: newLeads };
}

async function exportCSV(filters = {}) {
  const { leads } = await getLeads(filters);
  const headers = ['Name', 'Phone', 'Website', 'Has Website', 'Category', 'Address', 'City', 'State', 'Reviews', 'Rating', 'Score', 'Score Reason', 'Suggested Sequence', 'Status', 'Scraped At'];
  const rows = leads.map(l => [
    l.name || '', l.phone || '', l.website || '', l.hasWebsite ? 'Yes' : 'No',
    l.category || '', l.address || '', l.city || '', l.state || '',
    l.reviewCount || 0, l.rating || '', l.score || '', l.scoreReason || '',
    l.suggestedSequence || '', l.status || '', l.scrapedAt || '',
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

module.exports = { saveLeads, getLeads, updateLead, getStats, exportCSV, generateId };
