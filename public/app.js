// ── CONFIG ──────────────────────────────────────────────────
const POLL_MS = 10000;
let isFetching = false;
let sequences  = [];

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
  if (isFetching) return;
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
        setTimeout(fetchActivity, 1000);
      } else {
        setCardState(cardId, 'error', data.error || 'Failed — try again');
      }
    } catch (err) {
      setCardState(cardId, 'error', 'Network error: ' + err.message);
    }
    return;
  }

  // ── Not Interested → remove from all sequences
  if (action === 'not-interested') {
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
        setTimeout(fetchActivity, 1000);
      } else {
        setCardState(cardId, 'error', data.error || 'Failed');
      }
    } catch (err) {
      setCardState(cardId, 'error', 'Network error: ' + err.message);
    }
    return;
  }

  // ── Skip
  if (action === 'skip') {
    setCardState(cardId, 'loading', 'Skipping…');
    try {
      await fetch('/api/ignore/' + cardId, { method: 'POST' });
      setTimeout(fetchActivity, 600);
    } catch {
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
