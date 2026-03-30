// ── CONFIG ──────────────────────────────────────────────────
const POLL_MS = 10000;
let isFetching    = false;
let pollingPaused = false;   // paused while a card action is in flight
let sequences     = [];

// ── HELPERS ────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 5)     return 'just now';
  if (s < 60)    return s + 's ago';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(iso).toLocaleDateString();
}

function formatCallTime(secs) {
  if (secs == null) return null;
  const s = Math.round(Number(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function pct(val) {
  return (Math.round((val || 0) * 1000) / 10).toFixed(1) + '%';
}

function dispositionClass(disp) {
  if (!disp) return 'neutral';
  const d = disp.toLowerCase();
  if (/interest|hot|callback|demo|meeting|won|booked|yes|positive/.test(d)) return 'positive';
  if (/not.interest|wrong|invalid|dnc|unsubscrib|remove|stop|no|bad|lost/.test(d)) return 'negative';
  return 'neutral';
}

function decisionBadge(action, status) {
  if (status === 'ignored')                return ['ignored', '○ Skipped'];
  if (action === 'added_to_sequence')      return ['added',   '+ Added'];
  if (action === 'removed_from_sequences') return ['removed', '− Removed'];
  if (action === 'none')                   return ['none',    '○ No Action'];
  if (status === 'error')                  return ['error',   '⚠ Error'];
  return ['none', '—'];
}

// ── TAB SWITCHING ────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('page-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'analytics') fetchAnalytics();
  });
});

// ── CLOSE DROPDOWNS ON OUTSIDE CLICK ────────────────────────
document.addEventListener('click', function(e) {
  if (!e.target.closest('.seq-dropdown-wrap')) {
    document.querySelectorAll('.seq-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

// ── HEALTH ──────────────────────────────────────────────────
async function checkHealth() {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  try {
    const res = await fetch('/health');
    const d   = await res.json();
    dot.className     = d.status === 'ok' ? 'status-dot online' : 'status-dot offline';
    label.textContent = d.status === 'ok' ? 'Server Online'     : 'Server Error';
  } catch {
    dot.className     = 'status-dot offline';
    label.textContent = 'Offline';
  }
}

// ── LOAD SEQUENCES ───────────────────────────────────────────
async function loadSequences() {
  try {
    const res = await fetch('/api/sequences');
    const d   = await res.json();
    sequences = d.sequences || [];
  } catch {
    sequences = [];
  }
}

// ── FETCH INBOX + ACTIVITY ───────────────────────────────────
async function fetchActivity() {
  if (isFetching || pollingPaused) return;
  isFetching = true;
  try {
    const res = await fetch('/api/activity');
    const d   = await res.json();

    const s = d.stats || {};
    document.getElementById('statPending').textContent = s.pending  || 0;
    document.getElementById('statTotal').textContent   = s.total    || 0;
    document.getElementById('statAdded').textContent   = s.added    || 0;
    document.getElementById('statRemoved').textContent = s.removed  || 0;

    const count = s.pending || 0;
    const badge = document.getElementById('inboxBadge');
    badge.textContent   = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';

    renderInbox(d.pending   || []);
    renderActivity(d.events || []);

    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    console.error('fetchActivity error:', e);
  } finally {
    isFetching = false;
  }
}

// ── RENDER INBOX ─────────────────────────────────────────────
function renderInbox(items) {
  const el = document.getElementById('inboxList');

  if (!items.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No calls waiting</div>
        <div class="empty-sub">New calls from PowerDialer will appear here automatically</div>
      </div>`;
    return;
  }

  el.innerHTML = items.map(item => {
    const cls        = dispositionClass(item.disposition);
    const callFmt    = formatCallTime(item.callTime);
    const transcript = item.callTranscript
      ? item.callTranscript.slice(0, 100) + (item.callTranscript.length > 100 ? '…' : '')
      : null;

    // Use data attributes — no function args in onclick, no escaping issues
    const seqOptions = sequences.map(s => `
      <button class="seq-option"
        data-action="add-seq"
        data-card-id="${esc(item.id)}"
        data-seq-id="${esc(s.id)}"
        data-seq-name="${esc(s.name)}">
        <span class="seq-option-name">${esc(s.name)}</span>
        <span class="${s.active ? 'seq-active-dot' : 'seq-inactive-dot'}"></span>
      </button>`).join('');

    return `
      <div class="inbox-card inbox-card--${cls}" id="card-${esc(item.id)}" data-id="${esc(item.id)}">
        <div class="inbox-card-top">
          <div class="inbox-contact-info">
            <div class="contact-name-row">
              <span class="contact-name">${esc(item.contactName)}</span>
              ${item.contactTitle ? `<span class="contact-title">${esc(item.contactTitle)}</span>` : ''}
              <span class="disp-badge disp-badge--${cls}">${esc(item.disposition)}</span>
            </div>
            <div class="contact-meta">
              ${item.contactEmail   ? `<span class="contact-meta-item">✉ ${esc(item.contactEmail)}</span>`   : ''}
              ${item.contactPhone   ? `<span class="contact-meta-item">📞 ${esc(item.contactPhone)}</span>`  : ''}
              ${item.contactCompany ? `<span class="contact-meta-item">🏢 ${esc(item.contactCompany)}</span>` : ''}
            </div>
          </div>
          <div class="inbox-card-right">
            ${callFmt ? `<span class="call-time">⏱ ${esc(callFmt)}</span>` : ''}
            <span style="font-size:11px;color:var(--text-muted)">${timeAgo(item.receivedAt)}</span>
          </div>
        </div>

        ${item.notes || transcript ? `
        <div class="inbox-card-body">
          ${item.notes    ? `<div class="notes-row">"${esc(item.notes)}"</div>` : ''}
          ${transcript    ? `<div class="transcript-row">Transcript: ${esc(transcript)}</div>` : ''}
        </div>` : ''}

        <div class="inbox-card-actions" id="actions-${esc(item.id)}">
          <div class="seq-dropdown-wrap">
            <button class="btn-seq"
              data-action="toggle-seq"
              data-card-id="${esc(item.id)}">
              Add to Sequence ▾
            </button>
            <div class="seq-dropdown" id="seqdd-${esc(item.id)}">
              ${seqOptions}
            </div>
          </div>
          <button class="btn-not-interested"
            data-action="not-interested"
            data-card-id="${esc(item.id)}">
            Not Interested
          </button>
          <button class="btn-skip"
            data-action="skip"
            data-card-id="${esc(item.id)}">
            Skip
          </button>
        </div>
      </div>`;
  }).join('');
}

// ── EVENT DELEGATION FOR ALL CARD BUTTONS ────────────────────
// Single listener on the inbox container handles everything
document.getElementById('inboxList').addEventListener('click', async function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const cardId = btn.dataset.cardId;

  // ── Toggle sequence dropdown
  if (action === 'toggle-seq') {
    e.stopPropagation();
    const dd     = document.getElementById('seqdd-' + cardId);
    const isOpen = dd.classList.contains('open');
    document.querySelectorAll('.seq-dropdown.open').forEach(d => d.classList.remove('open'));
    if (!isOpen) dd.classList.add('open');
    return;
  }

  // ── Add to specific sequence
  if (action === 'add-seq') {
    e.stopPropagation();
    const seqId   = btn.dataset.seqId;
    const seqName = btn.dataset.seqName;
    document.querySelectorAll('.seq-dropdown.open').forEach(d => d.classList.remove('open'));
    pollingPaused = true;
    setCardState(cardId, 'loading', 'Adding to ' + seqName + '…');
    try {
      const res  = await fetch('/api/approve/' + cardId, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'added_to_sequence', sequenceId: seqId, sequenceName: seqName })
      });
      const data = await res.json();
      if (data.success) {
        setCardState(cardId, 'success', '✓ Added to ' + seqName);
        setTimeout(() => { pollingPaused = false; fetchActivity(); }, 2500);
      } else {
        setCardState(cardId, 'error', data.error || 'Failed — try again');
        setTimeout(() => { pollingPaused = false; }, 5000);
      }
    } catch (err) {
      setCardState(cardId, 'error', 'Network error: ' + err.message);
      setTimeout(() => { pollingPaused = false; }, 5000);
    }
    return;
  }

  // ── Not Interested → remove from all sequences
  if (action === 'not-interested') {
    pollingPaused = true;
    setCardState(cardId, 'loading', 'Removing from sequences…');
    try {
      const res  = await fetch('/api/approve/' + cardId, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'removed_from_sequences', sequenceId: null, sequenceName: null })
      });
      const data = await res.json();
      if (data.success) {
        setCardState(cardId, 'success', '✓ Removed from all sequences');
        setTimeout(() => { pollingPaused = false; fetchActivity(); }, 2500);
      } else {
        setCardState(cardId, 'error', data.error || 'Failed');
        setTimeout(() => { pollingPaused = false; }, 5000);
      }
    } catch (err) {
      setCardState(cardId, 'error', 'Network error: ' + err.message);
      setTimeout(() => { pollingPaused = false; }, 5000);
    }
    return;
  }

  // ── Skip
  if (action === 'skip') {
    pollingPaused = true;
    setCardState(cardId, 'loading', 'Skipping…');
    try {
      await fetch('/api/ignore/' + cardId, { method: 'POST' });
      setTimeout(() => { pollingPaused = false; fetchActivity(); }, 800);
    } catch {
      pollingPaused = false;
      fetchActivity();
    }
    return;
  }
});

function setCardState(id, state, msg) {
  const actionsEl = document.getElementById('actions-' + id);
  if (!actionsEl) return;

  if (state === 'loading') {
    actionsEl.innerHTML = `<span style="font-size:13px;color:var(--text-muted);padding:8px 0">${esc(msg)}</span>`;
  } else if (state === 'success') {
    actionsEl.innerHTML = `<div class="card-result card-result--success">${esc(msg)}</div>`;
  } else if (state === 'error') {
    actionsEl.innerHTML = `<div class="card-result card-result--error">✕ ${esc(msg)}</div>`;
  }
}

// ── RENDER ACTIVITY LOG ──────────────────────────────────────
function renderActivity(events) {
  const tbody = document.getElementById('activityBody');
  if (!events.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No decisions yet</td></tr>';
    return;
  }
  tbody.innerHTML = events.map(ev => {
    const [cls, label] = decisionBadge(ev.action, ev.status);
    return `
      <tr>
        <td>
          <div class="contact-name-cell">${esc(ev.contactName)}</div>
          <div class="contact-email-cell">${esc(ev.contactEmail)}</div>
        </td>
        <td>
          <span class="disp-badge disp-badge--${dispositionClass(ev.disposition)}">${esc(ev.disposition)}</span>
        </td>
        <td>
          <span class="badge badge--${cls}">${label}</span>
          ${ev.error ? `<div style="font-size:11px;color:var(--danger);margin-top:3px">${esc(ev.error)}</div>` : ''}
        </td>
        <td style="font-size:13px;color:var(--text-muted)">${esc(ev.sequenceName || '—')}</td>
        <td class="time-cell">${timeAgo(ev.processedAt)}</td>
      </tr>`;
  }).join('');
}

// ── ANALYTICS ────────────────────────────────────────────────
async function fetchAnalytics() {
  const grid = document.getElementById('analyticsGrid');
  grid.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-title">Loading from Apollo…</div></div>';
  try {
    const res  = await fetch('/api/analytics');
    const data = await res.json();
    renderAnalytics(data.sequences || [], data.success);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Failed to load</div><div class="empty-sub">${esc(e.message)}</div></div>`;
  }
}

function renderAnalytics(seqs, apiSuccess) {
  const grid = document.getElementById('analyticsGrid');
  if (!seqs.length) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No sequences found</div></div>';
    return;
  }

  grid.innerHTML = seqs.map(s => {
    const openPct   = Math.min((s.openRate   || 0) * 100, 100);
    const replyPct  = Math.min((s.replyRate  || 0) * 100, 100);
    const bouncePct = Math.min((s.bounceRate || 0) * 100, 100);
    const demoPct   = Math.min((s.demoRate   || 0) * 100, 100);
    const badBounce = (s.bounceRate || 0) > 0.10;

    return `
      <div class="seq-card ${s.isPerformingPoorly ? 'seq-card--poor' : ''}">
        <div class="seq-card-header">
          <div class="seq-name">${esc(s.name)}</div>
          <div class="seq-badges">
            <span class="${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? 'Active' : 'Inactive'}</span>
            ${s.isPerformingPoorly ? '<span class="badge-poor">⚠ Poor</span>' : ''}
          </div>
        </div>
        <div class="seq-delivered">${(s.delivered || 0).toLocaleString()}<br>
          <span class="seq-delivered-label">delivered</span>
        </div>
        <div class="seq-stats">
          <div class="seq-stat-row">
            <div class="seq-stat-label-row">
              <span class="seq-stat-label">Open Rate</span>
              <span class="seq-stat-val">${pct(s.openRate)}</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill progress-bar-fill--green" style="width:${openPct.toFixed(1)}%"></div></div>
          </div>
          <div class="seq-stat-row">
            <div class="seq-stat-label-row">
              <span class="seq-stat-label">Reply Rate</span>
              <span class="seq-stat-val">${pct(s.replyRate)}</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill progress-bar-fill--blue" style="width:${replyPct.toFixed(1)}%"></div></div>
          </div>
          <div class="seq-stat-row">
            <div class="seq-stat-label-row">
              <span class="seq-stat-label">Bounce Rate</span>
              <span class="seq-stat-val ${badBounce ? 'seq-stat-val--red' : ''}">${pct(s.bounceRate)} ${badBounce ? '⚠' : ''}</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill progress-bar-fill--red" style="width:${bouncePct.toFixed(1)}%"></div></div>
          </div>
          <div class="seq-stat-row">
            <div class="seq-stat-label-row">
              <span class="seq-stat-label">Demo Rate</span>
              <span class="seq-stat-val">${pct(s.demoRate)}</span>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill progress-bar-fill--purple" style="width:${demoPct.toFixed(1)}%"></div></div>
          </div>
        </div>
      </div>`;
  }).join('');

  if (!apiSuccess) {
    grid.insertAdjacentHTML('afterbegin', `
      <div style="grid-column:1/-1;padding:12px 16px;background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:8px;font-size:13px;color:var(--warning)">
        ⚠ Could not reach Apollo API — check your APOLLO_API_KEY in Vercel environment variables.
      </div>`);
  }
}

// ── REFRESH ──────────────────────────────────────────────────
document.getElementById('btnRefresh').addEventListener('click', fetchActivity);
document.getElementById('btnRefreshAnalytics').addEventListener('click', fetchAnalytics);

// ── INIT ─────────────────────────────────────────────────────
loadSequences().then(() => {
  checkHealth();
  fetchActivity();
  setInterval(fetchActivity, POLL_MS);
  setInterval(checkHealth, 30000);
});

// ════════════════════════════════════════════════════════════
//  SCRAPER
// ════════════════════════════════════════════════════════════

let scrapeRunId = null;
let scrapePollTimer = null;
let selectedLeadIds = new Set();
let currentLeadFilters = {};
let currentLeads = []; // all leads currently loaded in the browser

// enrichPollers: Map<leadId -> { enrichRunId, intervalId }>
const enrichPollers = new Map();

// ── ENRICH: WEBSITE CRAWLER POLLING ──────────────────────────
async function startEnrich(leadId) {
  try {
    const res = await fetch('/api/scraper/enrich/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId, method: enrichMethod }),
    });
    const data = await res.json();
    if (!data.success) {
      enrichPollers.delete(leadId);
      renderActiveList();
      alert('Enrich failed: ' + data.error);
      return;
    }

    // Claude direct mode — done immediately
    if (data.status === 'DONE') {
      enrichPollers.delete(leadId);
      fetchLeads();
      fetchScraperStats();
      return;
    }

    // Apify mode — start polling
    const enrichRunId = data.enrichRunId;
    const intervalId = setInterval(() => pollEnrichStatus(leadId, enrichRunId), 3000);
    enrichPollers.set(leadId, { enrichRunId, intervalId });

    // Re-render to show "Crawling…" state
    fetchLeads();
  } catch (err) {
    alert('Enrich error: ' + err.message);
  }
}

async function pollEnrichStatus(leadId, enrichRunId) {
  try {
    const res = await fetch('/api/scraper/enrich/status/' + enrichRunId);
    const data = await res.json();

    if (data.status === 'DONE') {
      const poller = enrichPollers.get(leadId);
      if (poller) clearInterval(poller.intervalId);
      enrichPollers.delete(leadId);
      // Re-render leads to show staff directory
      fetchLeads();
      fetchScraperStats();
    } else if (data.status === 'FAILED' || data.status === 'ABORTED' || data.status === 'ERROR') {
      const poller = enrichPollers.get(leadId);
      if (poller) clearInterval(poller.intervalId);
      enrichPollers.delete(leadId);
      fetchLeads();
    }
    // RUNNING / PROCESSING — keep polling
  } catch {
    // network hiccup, keep polling
  }
}

// ── DENOMINATION DIRECTORY IMPORT ───────────────────────────
async function initDirectoryImport() {
  // Load denominations into select
  try {
    const res = await fetch('/api/scraper/directory/denominations');
    const data = await res.json();
    const sel = document.getElementById('directoryDenomination');
    if (sel && data.denominations) {
      sel.innerHTML = data.denominations.map(d =>
        `<option value="${esc(d.id)}">${esc(d.icon)} ${esc(d.name)}</option>`
      ).join('');
    }
  } catch { /* keep default */ }

  // Toggle expand/collapse
  const toggle = document.getElementById('directoryImportToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const body = document.getElementById('directoryImportBody');
      const chevron = document.getElementById('directoryChevron');
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      if (chevron) chevron.textContent = open ? '▼' : '▲';
    });
  }

  // Import button
  const btn = document.getElementById('btnDirectoryImport');
  if (btn) {
    btn.addEventListener('click', runDirectoryImport);
  }
}

async function runDirectoryImport() {
  const denomination = document.getElementById('directoryDenomination')?.value;
  const location = document.getElementById('directoryLocation')?.value?.trim() || '';
  const btn = document.getElementById('btnDirectoryImport');
  const progress = document.getElementById('directoryProgress');
  const result = document.getElementById('directoryResult');

  if (!denomination) { alert('Please select a denomination'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Importing…'; }
  if (progress) { progress.style.display = 'flex'; }
  if (result) { result.style.display = 'none'; }

  try {
    const res = await fetch('/api/scraper/directory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ denomination, location }),
    });
    const data = await res.json();

    if (progress) progress.style.display = 'none';

    if (!data.success) {
      if (result) {
        result.style.display = '';
        result.className = 'directory-result directory-result--error';
        result.innerHTML = `❌ ${esc(data.error || 'Import failed')}`;
      }
    } else {
      if (result) {
        result.style.display = '';
        result.className = 'directory-result directory-result--success';
        result.innerHTML = `
          ✅ <strong>${data.imported} churches imported</strong> from the directory
          <br><span style="font-size:12px;opacity:0.8">${data.withPastor || 0} with pastor info · ${data.skipped || 0} duplicates skipped</span>
        `;
      }
      // Refresh leads
      await fetchLeads();
      fetchScraperStats();
    }
  } catch (err) {
    if (progress) progress.style.display = 'none';
    if (result) {
      result.style.display = '';
      result.className = 'directory-result directory-result--error';
      result.innerHTML = `❌ Error: ${esc(err.message)}`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Import Leads'; }
  }
}

// ── SCRAPER INIT ─────────────────────────────────────────────
function initScraper() {
  // Search type toggle
  document.getElementById('scraperSearchType').addEventListener('change', function () {
    document.getElementById('customKeywordGroup').style.display = this.value === 'custom' ? '' : 'none';
  });

  // Filter controls — debounced refetch
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const onFilterChange = debounce(() => fetchLeads(), 400);

  document.getElementById('filterMinScore').addEventListener('input', function () {
    document.getElementById('filterMinScoreVal').textContent = this.value;
    onFilterChange();
  });
  document.getElementById('filterMaxScore').addEventListener('input', function () {
    document.getElementById('filterMaxScoreVal').textContent = this.value;
    onFilterChange();
  });
  document.getElementById('filterLocation').addEventListener('input', onFilterChange);
  document.getElementById('filterHasWebsite').addEventListener('change', onFilterChange);
  document.getElementById('filterStatus').addEventListener('change', onFilterChange);
  document.getElementById('filterSort').addEventListener('change', onFilterChange);

  // Run scrape button
  document.getElementById('btnRunScrape').addEventListener('click', runScrape);
  document.getElementById('btnPreviewScrape').addEventListener('click', previewScrape);

  // Bulk skip
  document.getElementById('btnBulkSkip').addEventListener('click', skipSelected);

  // Bulk delete
  document.getElementById('btnBulkDelete').addEventListener('click', deleteSelected);

  // Export CSV
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);

  // Batch find staff
  document.getElementById('btnBulkEnrich').addEventListener('click', runBulkEnrich);
  document.getElementById('btnBulkCancel').addEventListener('click', () => {
    if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
    batchRunId = null;
    document.getElementById('batchProgress').style.display = 'none';
    resetBulkBtn();
  });

  // Enrich method toggle (claude / apify)
  initEnrichMethodToggle();

  // Sidebar lists nav — event delegation
  document.getElementById('listsNav').addEventListener('click', e => {
    const btn = e.target.closest('[data-list-id]');
    if (btn) setActiveList(btn.dataset.listId);
  });

  // Select All
  document.getElementById('selectAllLeads').addEventListener('change', function () {
    const checkboxes = document.querySelectorAll('#leadsList .lead-checkbox');
    checkboxes.forEach(cb => {
      cb.checked = this.checked;
      const id = cb.dataset.leadId;
      if (this.checked) selectedLeadIds.add(id);
      else selectedLeadIds.delete(id);
    });
    updateBulkBar();
  });

  // Close bulk dropdown on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#bulkPushDropdown')) {
      document.getElementById('bulkSeqMenu').classList.remove('open');
    }
  });

  // Bulk push dropdown toggle
  document.getElementById('btnBulkPush').addEventListener('click', e => {
    e.stopPropagation();
    populateBulkSeqMenu();
    document.getElementById('bulkSeqMenu').classList.toggle('open');
  });

  // Event delegation on leads list
  document.getElementById('leadsList').addEventListener('click', handleLeadAction);
  document.getElementById('leadsList').addEventListener('change', handleLeadCheckbox);

  // Directory import
  initDirectoryImport();

  // Fetch initial data when tab opens
  fetchLeads();
  fetchScraperStats();
}

// ── RUN SCRAPE ───────────────────────────────────────────────
async function previewScrape() {
  const location = document.getElementById('scraperLocation').value.trim() || 'United States';
  const searchType = document.getElementById('scraperSearchType').value;
  const resultEl = document.getElementById('scrapePreviewResult');
  resultEl.style.display = '';
  resultEl.textContent = '⏳ Checking...';
  try {
    const res = await fetch(`/api/scraper/preview?location=${encodeURIComponent(location)}&searchType=${encodeURIComponent(searchType)}`);
    const data = await res.json();
    if (data.success) resultEl.textContent = data.message + ' Estimated new results: ' + data.estimate + '.';
    else resultEl.textContent = '❌ ' + data.error;
  } catch {
    resultEl.textContent = '❌ Could not load preview';
  }
}

async function runScrape() {
  const btn = document.getElementById('btnRunScrape');
  btn.disabled = true;

  const websiteFilter = document.getElementById('scraperWebsiteFilter').value;
  const body = {
    searchType: document.getElementById('scraperSearchType').value,
    location: document.getElementById('scraperLocation').value.trim() || 'United States',
    maxResults: Number(document.getElementById('scraperMaxResults').value) || 200,
    customKeyword: document.getElementById('scraperCustomKeyword').value.trim() || null,
    websiteFilter,
  };

  showScrapeProgress('Starting scrape…');

  try {
    const res = await fetch('/api/scraper/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    scrapeRunId = data.runId;
    showScrapeProgress('Scraping Google Maps… this may take a few minutes');
    scrapePollTimer = setInterval(pollScrapeStatus, 5000);
  } catch (err) {
    hideScrapeProgress();
    btn.disabled = false;
    alert('Scrape failed: ' + err.message);
  }
}

async function pollScrapeStatus() {
  if (!scrapeRunId) return;
  try {
    const res = await fetch('/api/scraper/status/' + scrapeRunId);
    const data = await res.json();

    if (data.status === 'RUNNING' || data.status === 'READY') {
      showScrapeProgress(`Scraping… ${data.itemCount ? data.itemCount + ' places found so far' : 'in progress'}`);
    } else if (data.status === 'PROCESSING') {
      showScrapeProgress('Scoring leads with Claude AI… (this may take 30s)');
    } else if (data.status === 'DONE' || (data.success && data.count != null)) {
      clearInterval(scrapePollTimer);
      scrapePollTimer = null;
      scrapeRunId = null;
      hideScrapeProgress();
      document.getElementById('btnRunScrape').disabled = false;
      const newCount = data.count || 0;
      const skipCount = data.skipped || 0;
      const total = data.total || newCount;
      let msg = `✅ Scrape done! ${newCount} new leads added.`;
      if (skipCount > 0) msg += ` ${skipCount} duplicates skipped.`;
      if (total > 0) msg += ` (${total} total from Google Maps)`;
      alert(msg);
      fetchLeads();
      fetchScraperStats();
    } else if (data.status === 'FAILED' || data.status === 'ABORTED' || data.status === 'ERROR') {
      clearInterval(scrapePollTimer);
      scrapePollTimer = null;
      scrapeRunId = null;
      hideScrapeProgress();
      document.getElementById('btnRunScrape').disabled = false;
      alert('Scrape error: ' + (data.error || data.status));
    }
  } catch {
    // network hiccup, keep polling
  }
}

function showScrapeProgress(msg) {
  const el = document.getElementById('scrapeProgress');
  document.getElementById('scrapeProgressMsg').textContent = msg;
  el.style.display = '';
}
function hideScrapeProgress() {
  document.getElementById('scrapeProgress').style.display = 'none';
}

// ── FETCH LEADS ──────────────────────────────────────────────
async function fetchLeads() {
  const params = new URLSearchParams({
    minScore: document.getElementById('filterMinScore').value,
    maxScore: document.getElementById('filterMaxScore').value,
    sort: document.getElementById('filterSort').value,
  });
  const loc = document.getElementById('filterLocation').value.trim();
  const website = document.getElementById('filterHasWebsite').value;
  const status = document.getElementById('filterStatus').value;
  if (loc) params.set('location', loc);
  if (website) params.set('hasWebsite', website);
  if (status) params.set('status', status);

  currentLeadFilters = Object.fromEntries(params);

  try {
    const res = await fetch('/api/scraper/leads?' + params + '&_=' + Date.now());
    const data = await res.json();
    if (data.success) {
      currentLeads = data.leads;
      currentPage = 1;
      renderListsNav();
      renderActiveList();
    }
  } catch { /* silent */ }
}

async function fetchScraperStats() {
  try {
    const res = await fetch('/api/scraper/stats');
    const data = await res.json();
    if (data.success) {
      const s = data.stats;
      document.getElementById('scraperStatTotal').textContent = s.total;
      document.getElementById('scraperStatScored').textContent = s.scored;
      document.getElementById('scraperStatPushed').textContent = s.pushed;
      document.getElementById('scraperStatSkipped').textContent = s.skipped;
      const badge = document.getElementById('scraperBadge');
      if (s.new > 0) { badge.textContent = s.new; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  } catch { /* silent */ }
}

// ── GROUP LEADS BY DATE ───────────────────────────────────────
function groupByDate(leads) {
  const groups = {};
  leads.forEach(lead => {
    const date = lead.scrapedAt
      ? new Date(lead.scrapedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'Unknown Date';
    if (!groups[date]) groups[date] = [];
    groups[date].push(lead);
  });
  return groups;
}

// ── RENDER STAFF DIRECTORY PANEL ─────────────────────────────
function renderStaffDirectory(lead) {
  const contacts = lead.contacts || [];

  if (contacts.length === 0) {
    if (lead.hasWebsite && lead.website) {
      // Determine enrich button state
      const enrichRunId = lead.enrichRunId;
      const activeEnrich = enrichRunId && enrichPollers.has(lead.id);
      if (activeEnrich) {
        return `<div class="staff-directory">
          <div class="staff-dir-title">STAFF DIRECTORY</div>
          <div class="staff-crawling">🔍 Crawling website…</div>
        </div>`;
      }
      return `<div class="staff-directory">
        <div class="staff-dir-title">STAFF DIRECTORY</div>
        <button class="btn-find-staff" data-action="find-staff" data-lead-id="${esc(lead.id)}">Find Staff →</button>
      </div>`;
    }
    return '';
  }

  const rows = contacts.map((c, i) => `
    <div class="staff-row">
      <span class="staff-num">${i + 1}</span>
      <span class="staff-name">${esc(c.name || '—')}</span>
      ${c.title ? `<span class="staff-title-badge">${esc(c.title)}</span>` : ''}
      ${c.email ? `<span class="staff-email">✉ ${esc(c.email)}</span>` : ''}
      ${c.phone ? `<span class="staff-phone">📞 ${esc(c.phone)}</span>` : ''}
    </div>`).join('');

  return `<div class="staff-directory">
    <div class="staff-dir-title">STAFF DIRECTORY <span class="staff-count">${contacts.length} found</span></div>
    ${rows}
  </div>`;
}

// ── RENDER LEAD CARDS ────────────────────────────────────────
function renderLeadCards(leads) {
  const container = document.getElementById('leadsList');
  if (!leads || !leads.length) {
    const emptyMsgs = {
      'no-website':       ['📵', 'No call-first leads yet', 'Run a scrape to find churches without websites'],
      'has-website':      ['🌐', 'No website leads yet', 'Run a scrape and filter for churches with websites'],
      'decision-makers':  ['👤', 'No decision makers found yet', 'Click "Find Staff for All" or import from a denomination directory'],
    };
    const [icon, title, sub] = emptyMsgs[activeListId] || ['🔍', 'No leads match your filters', 'Try adjusting your filters'];
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <div class="empty-title">${title}</div>
      <div class="empty-sub">${sub}</div>
    </div>`;
    return;
  }

  // Decision Makers list — compact contact cards
  if (activeListId === 'decision-makers') {
    const html = leads.map(lead => {
      let contacts = lead.contacts || [];
      if (typeof contacts === 'string') { try { contacts = JSON.parse(contacts); } catch { contacts = []; } }
      const isSelected = selectedLeadIds.has(lead.id);
      const contactCards = contacts.map(c => {
        const initials = (c.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        return `<div class="dm-contact-card">
          <div class="dm-card-top">
            <div class="dm-avatar">${esc(initials)}</div>
            <div>
              <div class="dm-name">${esc(c.name || '—')}</div>
              <div class="dm-title">${esc(c.title || 'Pastor')}</div>
            </div>
          </div>
          <div class="dm-card-contacts">
            ${c.phone ? `<div class="dm-contact-item dm-phone">📞 ${esc(c.phone)}</div>` : ''}
            ${c.email ? `<div class="dm-contact-item dm-email">✉ ${esc(c.email)}</div>` : ''}
            ${!c.phone && !c.email ? `<div class="dm-contact-missing">No direct contact info</div>` : ''}
          </div>
        </div>`;
      }).join('');
      return `<div class="lead-card dm-lead-card" data-lead-id="${esc(lead.id)}">
        <div class="lead-card-header">
          <input type="checkbox" class="lead-checkbox" data-lead-id="${esc(lead.id)}" ${isSelected ? 'checked' : ''}>
          <div class="lead-title-row">
            <span class="lead-name">${esc(lead.name)}</span>
            ${lead.denomination ? `<span class="method-tag" style="margin-left:6px">${esc(lead.denomination)}</span>` : ''}
          </div>
        </div>
        <div class="lead-meta">
          ${lead.city || lead.state ? `<span>${esc([lead.city, lead.state].filter(Boolean).join(', '))}</span><span class="lead-meta-sep">·</span>` : ''}
          ${lead.phone ? `<span>📞 ${esc(lead.phone)}</span><span class="lead-meta-sep">·</span>` : ''}
          ${lead.website ? `<span><a href="${esc(lead.website)}" target="_blank" class="lead-website-link">🌐 Website</a></span>` : ''}
        </div>
        <div class="dm-contacts-grid">${contactCards}</div>
        <div class="lead-actions" id="lead-actions-${esc(lead.id)}">
          <div class="dropdown" id="lead-seq-dd-${esc(lead.id)}">
            <button class="btn-seq" data-action="open-seq" data-lead-id="${esc(lead.id)}">→ Add to Sequence ▾</button>
            <div class="dropdown-menu" id="lead-seq-menu-${esc(lead.id)}">
              ${sequences.filter(s => s.active).map(s =>
                `<div class="dropdown-item" data-action="push-lead" data-lead-id="${esc(lead.id)}" data-seq-id="${esc(s.id)}" data-seq-name="${esc(s.name)}">${esc(s.name)}</div>`
              ).join('')}
            </div>
          </div>
          <button class="btn-skip" data-action="skip-lead" data-lead-id="${esc(lead.id)}">Skip</button>
          <button class="btn-delete-single" data-action="delete-lead" data-lead-id="${esc(lead.id)}">🗑</button>
        </div>
      </div>`;
    }).join('');
    container.innerHTML = html;
    return;
  }

  // Group by date
  const groups = groupByDate(leads);
  let globalIndex = 0;
  const html = [];

  Object.entries(groups).forEach(([date, groupLeads]) => {
    html.push(`<div class="date-separator">
      <span class="date-separator-label">📅 ${esc(date)} — ${groupLeads.length} lead${groupLeads.length !== 1 ? 's' : ''}</span>
    </div>`);

    groupLeads.forEach(lead => {
      globalIndex++;
      const cardNum = globalIndex;
      const scoreClass = lead.score >= 8 ? 'score-high' : lead.score >= 5 ? 'score-mid' : lead.score ? 'score-low' : 'score-none';
      const scoreLabel = lead.score != null ? lead.score + '/10' : 'Unscored';
      const isSelected = selectedLeadIds.has(lead.id);
      const statusBadge = lead.status === 'pushed'
        ? `<span class="status-badge-pushed">Pushed → ${esc(lead.pushedToSequence || 'Sequence')}</span>`
        : lead.status === 'skipped' ? `<span class="status-badge-skipped">Skipped</span>`
        : lead.status === 'error' ? `<span class="status-badge-error">Error</span>` : '';

      const actions = lead.status === 'new' || lead.status === 'error' ? `
        <div class="lead-actions" id="lead-actions-${esc(lead.id)}">
          <div class="dropdown" id="lead-seq-dd-${esc(lead.id)}">
            <button class="btn-seq" data-action="open-seq" data-lead-id="${esc(lead.id)}">→ Add to Sequence ▾</button>
            <div class="dropdown-menu" id="lead-seq-menu-${esc(lead.id)}">
              ${sequences.filter(s => s.active).map(s => `
                <div class="dropdown-item" data-action="push-lead" data-lead-id="${esc(lead.id)}" data-seq-id="${esc(s.id)}" data-seq-name="${esc(s.name)}">${esc(s.name)}</div>
              `).join('')}
            </div>
          </div>
          <button class="btn-skip" data-action="skip-lead" data-lead-id="${esc(lead.id)}">Skip</button>
        </div>` : `<div class="lead-actions">${statusBadge}</div>`;

      const staffPanel = renderStaffDirectory(lead);

      html.push(`<div class="lead-card ${scoreClass} status-${esc(lead.status)}" data-lead-id="${esc(lead.id)}">
        <div class="lead-card-header">
          <input type="checkbox" class="lead-checkbox" data-lead-id="${esc(lead.id)}" ${isSelected ? 'checked' : ''}>
          <div class="lead-title-row">
            <span class="lead-num">#${cardNum}</span>
            <span class="lead-name">${esc(lead.name)}</span>
            <span class="score-badge ${scoreClass}">${scoreLabel}</span>
            ${!lead.hasWebsite ? '<span class="no-website-badge">No Website</span>' : ''}
          </div>
        </div>
        <div class="lead-meta">
          ${lead.city || lead.state ? `<span>${esc([lead.city, lead.state].filter(Boolean).join(', '))}</span><span class="lead-meta-sep">·</span>` : ''}
          ${lead.category ? `<span>${esc(lead.category)}</span><span class="lead-meta-sep">·</span>` : ''}
          ${lead.phone ? `<span>📞 ${esc(lead.phone)}</span><span class="lead-meta-sep">·</span>` : ''}
          ${lead.reviewCount != null ? `<span>★ ${lead.reviewCount} reviews</span>` : ''}
          ${lead.website ? `<span><a href="${esc(lead.website)}" target="_blank" class="lead-website-link">🌐 Website</a></span>` : ''}
        ${lead.scoreReason ? `<div class="lead-reason">Claude: "${esc(lead.scoreReason)}"</div>` : ''}
        ${staffPanel}
        ${actions}
      </div>`);
    });
  });

  container.innerHTML = html.join('');
}

// ── LEAD ACTION HANDLER (event delegation) ───────────────────
function handleLeadAction(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const leadId = target.dataset.leadId;

  if (action === 'open-seq') {
    e.stopPropagation();
    // Close all other lead dropdowns
    document.querySelectorAll('.dropdown-menu.open').forEach(m => {
      if (m.id !== 'lead-seq-menu-' + leadId) m.classList.remove('open');
    });
    document.getElementById('lead-seq-menu-' + leadId)?.classList.toggle('open');
  }

  if (action === 'push-lead') {
    const seqId = target.dataset.seqId;
    const seqName = target.dataset.seqName;
    pushSingleLead(leadId, seqId, seqName);
  }

  if (action === 'skip-lead') {
    skipSingleLead(leadId);
  }

  if (action === 'find-staff') {
    startEnrich(leadId);
  }

  if (action === 'delete-lead') {
    if (!confirm('Delete this lead? This cannot be undone.')) return;
    fetch('/api/scraper/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [leadId] }),
    }).then(() => { fetchLeads(); fetchScraperStats(); });
  }
}

function handleLeadCheckbox(e) {
  if (!e.target.classList.contains('lead-checkbox')) return;
  const id = e.target.dataset.leadId;
  if (e.target.checked) selectedLeadIds.add(id);
  else selectedLeadIds.delete(id);
  updateBulkBar();
}

// Close lead dropdowns on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown')) {
    document.querySelectorAll('#leadsList .dropdown-menu.open').forEach(m => m.classList.remove('open'));
  }
});

// ── SINGLE LEAD PUSH ─────────────────────────────────────────
async function pushSingleLead(leadId, seqId, seqName) {
  setLeadState(leadId, 'loading', `Adding to ${seqName}…`);
  try {
    const res = await fetch('/api/scraper/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads: [{ id: leadId }], sequenceId: seqId, sequenceName: seqName }),
    });
    const data = await res.json();
    if (!data.success || data.failed > 0) {
      const err = data.results?.[0]?.error || 'Failed';
      setLeadState(leadId, 'error', '✕ ' + err);
    } else {
      setLeadState(leadId, 'success', '✓ Added to ' + seqName);
      setTimeout(() => { fetchLeads(); fetchScraperStats(); }, 1500);
    }
  } catch (err) {
    setLeadState(leadId, 'error', '✕ ' + err.message);
  }
}

async function skipSingleLead(leadId) {
  setLeadState(leadId, 'loading', 'Skipping…');
  try {
    await fetch('/api/scraper/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [leadId] }),
    });
    setTimeout(() => { fetchLeads(); fetchScraperStats(); }, 600);
  } catch { /* silent */ }
}

function setLeadState(leadId, state, msg) {
  const actionsEl = document.getElementById('lead-actions-' + leadId);
  if (!actionsEl) return;
  const cls = state === 'success' ? 'success' : state === 'error' ? 'error' : '';
  actionsEl.innerHTML = `<div class="lead-state-msg ${cls}">${esc(msg)}</div>`;
}

// ── BULK ACTIONS ─────────────────────────────────────────────
function updateBulkBar() {
  const bar = document.getElementById('bulkActions');
  const count = selectedLeadIds.size;
  if (count > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulkCount').textContent = count + ' selected';
  } else {
    bar.style.display = 'none';
  }
}

function populateBulkSeqMenu() {
  const menu = document.getElementById('bulkSeqMenu');
  menu.innerHTML = sequences.filter(s => s.active).map(s =>
    `<div class="dropdown-item" data-bulk-seq-id="${esc(s.id)}" data-bulk-seq-name="${esc(s.name)}">${esc(s.name)}</div>`
  ).join('');
  menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      pushSelected(item.dataset.bulkSeqId, item.dataset.bulkSeqName);
      menu.classList.remove('open');
    });
  });
}

async function pushSelected(seqId, seqName) {
  if (!selectedLeadIds.size) return;
  const leads = Array.from(selectedLeadIds).map(id => ({ id }));
  try {
    const res = await fetch('/api/scraper/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leads, sequenceId: seqId, sequenceName: seqName }),
    });
    const data = await res.json();
    selectedLeadIds.clear();
    updateBulkBar();
    fetchLeads();
    fetchScraperStats();
    if (data.failed > 0) alert(`${data.pushed} pushed, ${data.failed} failed.`);
  } catch (err) {
    alert('Push failed: ' + err.message);
  }
}

async function skipSelected() {
  if (!selectedLeadIds.size) return;
  const ids = Array.from(selectedLeadIds);
  await fetch('/api/scraper/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  selectedLeadIds.clear();
  updateBulkBar();
  fetchLeads();
  fetchScraperStats();
}

async function deleteSelected() {
  if (!selectedLeadIds.size) return;
  if (!confirm(`Delete ${selectedLeadIds.size} selected lead(s)? This cannot be undone.`)) return;
  const ids = Array.from(selectedLeadIds);
  try {
    await fetch('/api/scraper/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    selectedLeadIds.clear();
    updateBulkBar();
    fetchLeads();
    fetchScraperStats();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function exportCSV() {
  const leads = currentLeads.length ? currentLeads : [];
  if (!leads.length) { alert('No leads to export. Run a scrape first.'); return; }

  const headers = ['Name','Phone','Website','Has Website','Category','Address','City','State','Reviews','Rating','Score','Score Reason','Suggested Sequence','Status','Scraped At'];
  const rows = leads.map(l => [
    l.name||'', l.phone||'', l.website||'', l.hasWebsite?'Yes':'No',
    l.category||'', l.address||'', l.city||'', l.state||'',
    l.reviewCount||0, l.rating||'', l.score||'', l.scoreReason||'',
    l.suggestedSequence||'', l.status||'', l.scrapedAt||''
  ].map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'church-leads-' + Date.now() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── WIRE SCRAPER INTO TAB SYSTEM ─────────────────────────────
// (extends the existing tab click handler)
const _origTabHandler = document.querySelector('.tab-nav').onclick;
document.querySelector('.tab-nav').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (btn && btn.dataset.tab === 'scraper') {
    fetchLeads();
    fetchScraperStats();
  }
});

// Init scraper on load
initScraper();
