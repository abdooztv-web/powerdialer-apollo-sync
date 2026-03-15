const POLL_INTERVAL = 8000;
let isFetching   = false;
let sequences    = [];
let currentItem  = null; // pending item open in modal

// ── HELPERS ────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(isoString) {
  if (!isoString) return '—';
  const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (diff < 5)    return 'just now';
  if (diff < 60)   return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return new Date(isoString).toLocaleDateString();
}

function badgeClass(action, status) {
  if (status === 'ignored')                  return 'ignored';
  if (action === 'added_to_sequence')        return 'added';
  if (action === 'removed_from_sequences')   return 'removed';
  if (action === 'none')                     return 'none';
  if (status === 'error')                    return 'error';
  return 'none';
}

function badgeLabel(action, status) {
  if (status === 'ignored')                  return '○ Ignored';
  if (action === 'added_to_sequence')        return '+ Added';
  if (action === 'removed_from_sequences')   return '− Removed';
  if (action === 'none')                     return '○ No Action';
  if (status === 'error')                    return '⚠ Error';
  return '○ —';
}

// ── HEALTH CHECK ────────────────────────────────────────────
async function checkHealth() {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  try {
    const res  = await fetch('/health');
    const data = await res.json();
    if (data.status === 'ok') {
      dot.className     = 'status-dot online';
      label.textContent = 'Server Online';
    } else {
      dot.className     = 'status-dot offline';
      label.textContent = 'Server Error';
    }
  } catch {
    dot.className     = 'status-dot offline';
    label.textContent = 'Offline';
  }
}

// ── LOAD SEQUENCES ──────────────────────────────────────────
async function loadSequences() {
  try {
    const res  = await fetch('/api/sequences');
    const data = await res.json();
    sequences = data.sequences || [];
  } catch {
    sequences = [];
  }
}

// ── FETCH & RENDER ──────────────────────────────────────────
async function fetchActivity() {
  if (isFetching) return;
  isFetching = true;
  try {
    const res  = await fetch('/api/activity');
    const data = await res.json();

    renderStats(data.stats);
    renderPending(data.pending || []);
    renderActivityLog(data.events || []);

    document.getElementById('lastUpdated').textContent =
      'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Failed to fetch activity:', err);
  } finally {
    isFetching = false;
  }
}

function renderStats(stats) {
  document.getElementById('statPending').textContent  = stats.pending  ?? 0;
  document.getElementById('statTotal').textContent    = stats.total    ?? 0;
  document.getElementById('statAdded').textContent    = stats.added    ?? 0;
  document.getElementById('statRemoved').textContent  = stats.removed  ?? 0;

  // Sidebar badge
  const badge = document.getElementById('pendingBadge');
  const count = stats.pending ?? 0;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';

  // Pending section count chip
  document.getElementById('pendingCount').textContent = count;
}

function renderPending(items) {
  const container = document.getElementById('pendingList');

  if (!items.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-title">All clear</div>
        <div class="empty-sub">No calls waiting for your approval</div>
      </div>`;
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="pending-card" id="card-${escapeHtml(item.id)}">
      <div class="pending-contact">
        <div class="pending-name">${escapeHtml(item.contactName)}</div>
        <div class="pending-email">${escapeHtml(item.contactEmail)}</div>
        <div class="pending-time">Received ${timeAgo(item.receivedAt)}</div>
      </div>
      <div class="pending-disposition">${escapeHtml(item.disposition)}</div>
      <div class="pending-actions">
        <button class="btn-approve" onclick="openModal('${escapeHtml(item.id)}')">
          Choose Action →
        </button>
        <button class="btn-ignore" onclick="ignoreItem('${escapeHtml(item.id)}')">
          Ignore
        </button>
      </div>
    </div>
  `).join('');
}

function renderActivityLog(events) {
  const tbody = document.getElementById('activityBody');

  if (!events.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No decisions made yet</td></tr>';
    return;
  }

  tbody.innerHTML = events.map(ev => `
    <tr>
      <td>
        <div class="contact-name">${escapeHtml(ev.contactName)}</div>
        <div class="contact-email">${escapeHtml(ev.contactEmail)}</div>
      </td>
      <td>${escapeHtml(ev.disposition)}</td>
      <td>
        <span class="badge badge--${badgeClass(ev.action, ev.status)}">
          ${badgeLabel(ev.action, ev.status)}
        </span>
        ${ev.error ? `<div style="font-size:11px;color:#f85149;margin-top:4px">${escapeHtml(ev.error)}</div>` : ''}
      </td>
      <td style="font-size:13px;color:#7d8590">${escapeHtml(ev.sequenceName || '—')}</td>
      <td class="time-cell">${timeAgo(ev.processedAt)}</td>
    </tr>
  `).join('');
}

// ── MODAL ───────────────────────────────────────────────────
function openModal(id) {
  // Find item from last fetched data — re-fetch to get latest
  fetch('/api/activity').then(r => r.json()).then(data => {
    const item = (data.pending || []).find(p => p.id === id);
    if (!item) return;
    currentItem = item;

    document.getElementById('modalContact').innerHTML =
      `${escapeHtml(item.contactName)} <span style="font-size:13px;font-weight:400;color:var(--text-muted)">${escapeHtml(item.contactEmail)}</span>`;
    document.getElementById('modalDisposition').textContent = item.disposition;

    // Build action buttons from sequences
    const actionsEl = document.getElementById('modalActions');
    let buttonsHTML = '';

    // Add to sequence buttons
    sequences.forEach(seq => {
      const cls = seq.key === 'pastors' ? 'add-pastors' : seq.key === 'directors' ? 'add-directors' : 'add-new';
      buttonsHTML += `
        <button class="modal-btn modal-btn--${cls}" onclick="approveItem('added_to_sequence','${escapeHtml(seq.id)}','${escapeHtml(seq.name)}')">
          <span class="modal-btn-icon">+</span>
          <span class="modal-btn-text">
            <span class="modal-btn-title">Add to ${escapeHtml(seq.name)}</span>
            <span class="modal-btn-sub">Enroll contact in this email sequence</span>
          </span>
        </button>`;
    });

    buttonsHTML += `<div class="modal-divider"></div>`;
    buttonsHTML += `
      <button class="modal-btn modal-btn--remove" onclick="approveItem('removed_from_sequences',null,null)">
        <span class="modal-btn-icon">−</span>
        <span class="modal-btn-text">
          <span class="modal-btn-title">Remove from All Sequences</span>
          <span class="modal-btn-sub">Stop all active email sequences for this contact</span>
        </span>
      </button>
      <button class="modal-btn modal-btn--noaction" onclick="approveItem('none',null,null)">
        <span class="modal-btn-icon">○</span>
        <span class="modal-btn-text">
          <span class="modal-btn-title">No Action</span>
          <span class="modal-btn-sub">Log the call, do nothing in Apollo</span>
        </span>
      </button>`;

    actionsEl.innerHTML = buttonsHTML;

    document.getElementById('modalOverlay').style.display = 'flex';
  });
}

function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  currentItem = null;
}

async function approveItem(action, sequenceId, sequenceName) {
  if (!currentItem) return;
  closeModal();

  // Optimistically remove the card
  const card = document.getElementById('card-' + currentItem.id);
  if (card) card.style.opacity = '0.4';

  try {
    const res = await fetch(`/api/approve/${currentItem.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, sequenceId, sequenceName })
    });
    await res.json();
    await fetchActivity();
  } catch (err) {
    console.error('Approve failed:', err);
    await fetchActivity();
  }
}

async function ignoreItem(id) {
  const card = document.getElementById('card-' + id);
  if (card) card.style.opacity = '0.4';

  try {
    await fetch(`/api/ignore/${id}`, { method: 'POST' });
    await fetchActivity();
  } catch (err) {
    console.error('Ignore failed:', err);
    await fetchActivity();
  }
}

// ── TEST FORM ───────────────────────────────────────────────
document.getElementById('testForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn    = document.getElementById('btnSubmit');
  const result = document.getElementById('formResult');

  btn.disabled    = true;
  btn.textContent = 'Sending...';
  result.style.display = 'none';

  const payload = {
    contact_email: document.getElementById('testEmail').value,
    contact_name:  document.getElementById('testName').value,
    disposition:   document.getElementById('testDisposition').value
  };

  try {
    const res  = await fetch('/webhook/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    result.style.display = 'block';
    result.className     = 'form-result success';
    result.textContent   = '✅ Queued for approval! Check the Pending Approvals section above.';

    await fetchActivity();
  } catch (err) {
    result.style.display = 'block';
    result.className     = 'form-result error';
    result.textContent   = 'Error: ' + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Send Test Call';
  }
});

// ── MODAL CLOSE ─────────────────────────────────────────────
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ── REFRESH BUTTON ──────────────────────────────────────────
document.getElementById('btnRefresh').addEventListener('click', fetchActivity);

// ── INIT ────────────────────────────────────────────────────
loadSequences();
checkHealth();
fetchActivity();
setInterval(fetchActivity, POLL_INTERVAL);
setInterval(checkHealth, 30000);
