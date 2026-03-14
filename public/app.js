const POLL_INTERVAL = 10000;
let isFetching = false;

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
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 5)   return 'just now';
  if (diff < 60)  return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return new Date(isoString).toLocaleDateString();
}

function badgeClass(action) {
  if (action === 'added_to_sequence')      return 'added';
  if (action === 'removed_from_sequences') return 'removed';
  if (action === 'error')                  return 'error';
  if (action === 'test')                   return 'test';
  return 'none';
}

function badgeLabel(action) {
  if (action === 'added_to_sequence')      return '+ Added';
  if (action === 'removed_from_sequences') return '− Removed';
  if (action === 'error')                  return '⚠ Error';
  if (action === 'test')                   return '🧪 Test';
  return '○ No Action';
}

// ── HEALTH CHECK ────────────────────────────────────────────
async function checkHealth() {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  try {
    const res  = await fetch('/health');
    const data = await res.json();
    if (data.status === 'ok') {
      dot.className   = 'status-dot online';
      label.textContent = 'Server Online';
    } else {
      dot.className   = 'status-dot offline';
      label.textContent = 'Server Error';
    }
  } catch {
    dot.className   = 'status-dot offline';
    label.textContent = 'Offline';
  }
}

// ── ACTIVITY FETCH & RENDER ─────────────────────────────────
async function fetchActivity() {
  if (isFetching) return;
  isFetching = true;
  try {
    const res  = await fetch('/api/activity');
    const data = await res.json();

    renderStats(data.stats);
    renderTable(data.events);

    document.getElementById('lastUpdated').textContent =
      'Last updated: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Failed to fetch activity:', err);
  } finally {
    isFetching = false;
  }
}

function renderStats(stats) {
  document.getElementById('statTotal').textContent    = stats.total    ?? 0;
  document.getElementById('statAdded').textContent    = stats.added    ?? 0;
  document.getElementById('statRemoved').textContent  = stats.removed  ?? 0;
  document.getElementById('statNoAction').textContent = stats.noAction ?? 0;
}

function renderTable(events) {
  const tbody = document.getElementById('activityBody');

  if (!events || events.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No activity yet — waiting for webhooks</td></tr>';
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
        <span class="badge badge--${badgeClass(ev.action)}">
          ${badgeLabel(ev.action)}
        </span>
        ${ev.error ? `<div style="font-size:11px;color:#f85149;margin-top:4px">${escapeHtml(ev.error)}</div>` : ''}
      </td>
      <td style="font-size:13px;color:#7d8590">${escapeHtml(ev.sequenceName || '—')}</td>
      <td class="time-cell" title="${escapeHtml(ev.timestamp)}">${timeAgo(ev.timestamp)}</td>
    </tr>
  `).join('');
}

// ── TEST FORM ───────────────────────────────────────────────
document.getElementById('testForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const btn    = document.getElementById('btnSubmit');
  const result = document.getElementById('formResult');

  btn.disabled     = true;
  btn.textContent  = 'Sending...';
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
    result.className     = 'form-result ' + (data.success ? 'success' : 'error');
    result.textContent   = JSON.stringify(data, null, 2);

    await fetchActivity();
  } catch (err) {
    result.style.display = 'block';
    result.className     = 'form-result error';
    result.textContent   = 'Network error: ' + err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Send Test Webhook';
  }
});

// ── INIT ────────────────────────────────────────────────────
document.getElementById('btnRefresh').addEventListener('click', fetchActivity);

checkHealth();
fetchActivity();
setInterval(fetchActivity, POLL_INTERVAL);
setInterval(checkHealth, 30000);
