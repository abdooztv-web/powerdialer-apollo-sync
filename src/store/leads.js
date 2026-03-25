const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL env var is not set');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
  }
  return pool;
}

async function initTable() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        "placeId" TEXT UNIQUE,
        name TEXT,
        phone TEXT,
        website TEXT,
        "hasWebsite" BOOLEAN DEFAULT false,
        category TEXT,
        address TEXT,
        contacts JSONB DEFAULT '[]',
        city TEXT,
        state TEXT,
        "reviewCount" INTEGER DEFAULT 0,
        rating NUMERIC,
        score INTEGER,
        "scoreReason" TEXT,
        "suggestedSequence" TEXT,
        status TEXT DEFAULT 'new',
        "scrapedAt" TIMESTAMPTZ DEFAULT NOW(),
        "apolloId" TEXT,
        data JSONB
      );
      CREATE INDEX IF NOT EXISTS leads_score_idx ON leads(score DESC);
      CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
    `);
    // Migration: add contacts column if it doesn't exist yet
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacts JSONB DEFAULT '[]'`);
  } finally {
    client.release();
  }
}

let tableReady = false;
async function ensureTable() {
  if (!tableReady) { await initTable(); tableReady = true; }
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

async function saveLeads(newLeads) {
  await ensureTable();
  const client = await getPool().connect();
  let added = 0;
  let skipped = 0;
  try {
    for (const lead of newLeads) {
      const id = lead.id || generateId();
      const res = await client.query(`
        INSERT INTO leads (id, "placeId", name, phone, website, "hasWebsite", category, address, city, state, "reviewCount", rating, score, "scoreReason", "suggestedSequence", status, "scrapedAt", contacts, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT ("placeId") DO NOTHING
        RETURNING id
      `, [
        id, lead.placeId || null, lead.name || null, lead.phone || null,
        lead.website || null, lead.hasWebsite || false, lead.category || null,
        lead.address || null, lead.city || null, lead.state || null,
        lead.reviewCount || 0, lead.rating || null, lead.score || null,
        lead.scoreReason || null, lead.suggestedSequence || null,
        lead.status || 'new', lead.scrapedAt || new Date().toISOString(),
        JSON.stringify([]), JSON.stringify(lead)
      ]);
      if (res.rowCount > 0) added++;
      else skipped++;
    }
  } finally {
    client.release();
  }
  return { added, skipped };
}

async function getLeads(filters = {}) {
  await ensureTable();
  const conditions = [];
  const values = [];
  let i = 1;

  if (filters.minScore !== undefined) { conditions.push(`score >= $${i++}`); values.push(Number(filters.minScore)); }
  if (filters.maxScore !== undefined) { conditions.push(`score <= $${i++}`); values.push(Number(filters.maxScore)); }
  if (filters.location) {
    conditions.push(`(city ILIKE $${i} OR state ILIKE $${i} OR address ILIKE $${i})`);
    values.push(`%${filters.location}%`); i++;
  }
  if (filters.hasWebsite === 'false') { conditions.push(`"hasWebsite" = false`); }
  else if (filters.hasWebsite === 'true') { conditions.push(`"hasWebsite" = true`); }
  if (filters.status) { conditions.push(`status = $${i++}`); values.push(filters.status); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const sort = filters.sort || 'score';
  const orderBy = sort === 'score' ? 'score DESC NULLS LAST'
    : sort === 'date' ? '"scrapedAt" DESC'
    : sort === 'name' ? 'name ASC'
    : 'score DESC NULLS LAST';

  const offset = filters.offset ? Number(filters.offset) : 0;
  const limit = filters.limit ? Number(filters.limit) : 1000;

  const pool = getPool();
  const [countRes, rowsRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM leads ${where}`, values),
    pool.query(`SELECT id,"placeId",name,phone,website,"hasWebsite",category,address,city,state,"reviewCount",rating,score,"scoreReason","suggestedSequence",status,"scrapedAt","apolloId",contacts FROM leads ${where} ORDER BY ${orderBy} LIMIT $${i} OFFSET $${i+1}`, [...values, limit, offset])
  ]);

  return { leads: rowsRes.rows, total: parseInt(countRes.rows[0].count) };
}

async function updateLead(id, updates) {
  await ensureTable();
  const fields = Object.keys(updates).map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values = [id, ...Object.values(updates)];
  const res = await getPool().query(
    `UPDATE leads SET ${fields} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function getStats() {
  await ensureTable();
  const res = await getPool().query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE score IS NOT NULL) as scored,
      COUNT(*) FILTER (WHERE status = 'pushed') as pushed,
      COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
      COUNT(*) FILTER (WHERE status = 'new') as new
    FROM leads
  `);
  const r = res.rows[0];
  return { total: +r.total, scored: +r.scored, pushed: +r.pushed, skipped: +r.skipped, new: +r.new };
}

async function exportCSV(filters = {}) {
  const { leads } = await getLeads({ ...filters, limit: 10000 });
  const headers = ['Name','Phone','Website','Has Website','Category','Address','City','State','Reviews','Rating','Score','Score Reason','Suggested Sequence','Status','Scraped At'];
  const rows = leads.map(l => [
    l.name||'', l.phone||'', l.website||'', l.hasWebsite?'Yes':'No',
    l.category||'', l.address||'', l.city||'', l.state||'',
    l.reviewCount||0, l.rating||'', l.score||'', l.scoreReason||'',
    l.suggestedSequence||'', l.status||'', l.scrapedAt||''
  ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

module.exports = { saveLeads, getLeads, updateLead, getStats, exportCSV, generateId };
