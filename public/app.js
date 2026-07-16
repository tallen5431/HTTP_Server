// WebSocket connection
let ws = null;
let reconnectTimeout = null;
let currentPrograms = [];
let searchQuery = '';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// When the manager has MANAGER_API_TOKEN set (required before any remote/Tailscale
// exposure), every API call and the WebSocket must carry the token. We store it in
// localStorage so it persists on this device, send it as an Authorization: Bearer
// header on fetches, and smuggle it into the WebSocket via a subprotocol (browsers
// can't set headers on a WebSocket). Without this the UI silently 401s the moment
// a token is enabled.
let apiToken = localStorage.getItem('managerToken') || '';
let authEnabled = false; // learned from GET /api/health

function setApiToken(token) {
  apiToken = token || '';
  if (apiToken) {
    localStorage.setItem('managerToken', apiToken);
  } else {
    localStorage.removeItem('managerToken');
  }
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;
  return headers;
}

// base64url with no padding — safe to use as a WebSocket subprotocol token.
function base64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Wrapper around fetch that injects auth and routes 401/429 to a helpful UX.
async function api(path, opts = {}) {
  const headers = authHeaders(opts.headers || {});
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    openLoginModal(true);
    throw new Error('Unauthorized');
  }
  if (res.status === 429) {
    showToast('Too many attempts — wait a minute and try again.', 'error');
    throw new Error('Rate limited');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Login modal — enter the API token from the UI (persisted to this device).
// Shown automatically when the server reports auth is enabled and we have no
// token, or when a request/WebSocket is rejected.
// ---------------------------------------------------------------------------
function openLoginModal(fromAuthFailure = false) {
  const modal = document.getElementById('loginModal');
  if (!modal) return;
  const err = document.getElementById('loginError');
  const rejected = fromAuthFailure && Boolean(apiToken);
  if (err) {
    err.textContent = rejected ? 'That token was rejected. Try again.' : '';
    err.classList.toggle('hidden', !rejected);
  }
  const input = document.getElementById('loginToken');
  if (input) input.value = apiToken || '';
  modal.classList.remove('hidden');
  if (input) setTimeout(() => input.focus(), 0);
}

function closeLoginModal() {
  const modal = document.getElementById('loginModal');
  if (modal) modal.classList.add('hidden');
}

function submitLogin(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('loginToken');
  const token = input ? input.value.trim() : '';
  if (!token) return;
  setApiToken(token);
  closeLoginModal();
  updateAuthUi();
  // Reconnect the WebSocket and refetch everything with the new token.
  if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
  connectWebSocket();
  fetchPrograms();
  fetchDefaultBrowseDir();
  showToast('Signed in on this device', 'success', 2500);
}

function logout() {
  setApiToken('');
  updateAuthUi();
  if (ws) { try { ws.close(); } catch (_) { /* ignore */ } }
  showToast('Token cleared from this device', 'info', 2500);
  openLoginModal();
}

// Show/hide the Sign-out button depending on whether we're authenticated.
function updateAuthUi() {
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) btnLogout.classList.toggle('hidden', !(authEnabled && apiToken));
}

// Show whether the manager is being viewed over the LAN or Tailscale, so it's
// obvious which network you're on while managing remotely.
function updateConnectionIndicator() {
  const el = document.getElementById('connIndicator');
  if (!el) return;
  const host = (window.location && window.location.hostname) || '';
  let label;
  if (isTailscaleHostname(host) || host.startsWith('100.')) {
    label = 'Tailscale';
  } else if (host === 'localhost' || host === '127.0.0.1') {
    label = 'This device';
  } else {
    label = 'LAN';
  }
  el.textContent = label;
  el.className = 'conn-indicator conn-' + label.toLowerCase().replace(/\s+/g, '-');
  el.classList.remove('hidden');
}

// Boot sequence: learn whether auth is required (via the open /api/health), then
// either prompt for the token or load everything.
async function init() {
  try {
    const res = await fetch('/api/health');
    const health = await res.json();
    authEnabled = Boolean(health.authEnabled);
  } catch (_) {
    // Health unreachable — assume no auth and let normal error handling run.
  }

  updateConnectionIndicator();
  updateAuthUi();

  if (authEnabled && !apiToken) {
    openLoginModal();
    return; // wait for sign-in before connecting
  }

  fetchDefaultBrowseDir();
  fetchPrograms();
  connectWebSocket();
}

// Resolve a program URL against the current browser origin.
//
// Supports:
//   - Absolute URLs: "http://example.com/app" (returned as-is unless it points at a local/private host)
//   - Root-relative paths: "/myapp" (origin + path)
//   - Simple paths: "myapp" (origin + "/" + path)
function isLocalProgramHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('100.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function isTailscaleHostname(hostname) {
  return /\.ts\.net$/i.test(String(hostname || ''));
}

function resolveProgramUrl(rawUrl, program = {}) {
  if (!rawUrl) return null;
  const trimmed = String(rawUrl).trim();
  if (!trimmed) return null;

  const loc = window.location || {};
  const currentHostname = loc.hostname || 'localhost';
  const currentProtocol = loc.protocol || 'http:';
  const currentPort = loc.port || '';

  // If the API returns a local/private address but the manager page is being
  // viewed through HTTPS Tailscale, rewrite the card link to that public
  // Tailscale host so users do not see or open unreachable local IP URLs.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (isLocalProgramHostname(url.hostname) && isTailscaleHostname(currentHostname)) {
        url.protocol = currentProtocol === 'https:' ? 'https:' : url.protocol;
        url.hostname = currentHostname;

        if (program.omitPortInUrl) {
          url.port = '';
        }

        return url.toString().replace(/\/$/, '');
      }

      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        url.hostname = currentHostname;
        return url.toString().replace(/\/$/, '');
      }

      return trimmed;
    } catch (err) {
      return trimmed
        .replace(/localhost/g, currentHostname)
        .replace(/127\.0\.0\.1/g, currentHostname);
    }
  }

  const portSegment = currentPort ? `:${currentPort}` : '';
  const origin = `${currentProtocol}//${currentHostname}${portSegment}`;

  // "/myapp" -> origin + path
  if (trimmed.startsWith('/')) {
    return origin + trimmed;
  }

  // "myapp" -> origin + path
  const base = origin.replace(/\/+$/, '');
  const path = trimmed.replace(/^\/+/, '');
  return `${base}/${path}`;
}

// Choose which of a program's addresses the Open button should launch, based on
// where the manager is being viewed from: over Tailscale -> the Tailscale URL,
// on the LAN -> the Local URL. Falls back to the legacy single `url`.
function pickBestUrl(program = {}) {
  const list = Array.isArray(program.urls) ? program.urls : [];
  if (list.length) {
    const host = (window.location && window.location.hostname) || '';
    const onTailscale = isTailscaleHostname(host) || host.startsWith('100.');
    const prefer = onTailscale ? 'tailscale' : 'local';
    const match = list.find(u => u.kind === prefer);
    return (match || list[0]).url;
  }
  return resolveProgramUrl(program.url, program);
}

// DOM elements
const programsGrid = document.getElementById('programsGrid');
const emptyState = document.getElementById('emptyState');
const noResults = document.getElementById('noResults');
const wsStatus = document.getElementById('wsStatus');
const wsStatusText = document.getElementById('wsStatusText');
const toastContainer = document.getElementById('toastContainer');
const searchInput = document.getElementById('searchInput');
const btnClearSearch = document.getElementById('btnClearSearch');
const statTotal = document.getElementById('statTotal');
const statRunning = document.getElementById('statRunning');
const statStopped = document.getElementById('statStopped');

// Toast Notification System
function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✗',
    warning: '⚠',
    info: 'ℹ'
  };

  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-content">
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close">✕</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    toast.remove();
  });

  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s ease-out reverse';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// Format uptime
function formatUptime(milliseconds) {
  if (!milliseconds) return 'N/A';

  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// Connect to WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  // Always offer 'manager'; add the auth subprotocol when we hold a token.
  const protocols = ['manager'];
  if (apiToken) protocols.push('bearer.' + base64url(apiToken));

  try {
    ws = new WebSocket(wsUrl, protocols);
  } catch (err) {
    console.error('WebSocket construction failed:', err);
    return;
  }

  ws.onopen = () => {
    console.log('WebSocket connected');
    wsStatus.classList.add('connected');
    wsStatus.classList.remove('disconnected');
    wsStatusText.textContent = 'Connected';
    updateConnectionIndicator();

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'status') {
      updateProgramsDisplay(message.data);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };

  ws.onclose = (event) => {
    console.log('WebSocket disconnected', event && event.code);
    wsStatus.classList.remove('connected');
    wsStatus.classList.add('disconnected');
    wsStatusText.textContent = 'Disconnected';

    // 1008 = policy violation = auth rejected. Prompt for the token rather than
    // reconnecting in a loop with the same bad credential.
    if (event && event.code === 1008) {
      openLoginModal(true);
      return;
    }

    // Attempt to reconnect after 3 seconds
    reconnectTimeout = setTimeout(connectWebSocket, 3000);
  };
}

// Fetch programs from API
async function fetchPrograms() {
  try {
    const response = await api('/api/programs');
    const programs = await response.json();
    updateProgramsDisplay(programs);
  } catch (error) {
    if (error.message === 'Unauthorized') return; // login modal already shown
    console.error('Error fetching programs:', error);
    showToast('Failed to fetch programs', 'error');
  }
}

// Update programs display
function updateProgramsDisplay(programs) {
  currentPrograms = programs;

  if (!programs || programs.length === 0) {
    programsGrid.classList.add('hidden');
    emptyState.classList.remove('hidden');
    noResults.classList.add('hidden');
    updateStats(programs);
    return;
  }

  emptyState.classList.add('hidden');

  // Update existing cards or create new ones
  programs.forEach(program => {
    let card = document.querySelector(`[data-program-id="${program.id}"]`);

    if (!card) {
      card = createProgramCard(program);
      programsGrid.appendChild(card);
    } else {
      updateProgramCard(card, program);
    }
  });

  // Remove cards for programs that no longer exist
  const existingCards = programsGrid.querySelectorAll('.program-card');
  existingCards.forEach(card => {
    const id = card.getAttribute('data-program-id');
    if (!programs.find(p => p.id === id)) {
      card.remove();
    }
  });

  // Apply search filter
  filterPrograms();

  // Update stats
  updateStats(programs);
}

// Filter programs based on search query
function filterPrograms() {
  const cards = programsGrid.querySelectorAll('.program-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const programId = card.getAttribute('data-program-id');
    const program = currentPrograms.find(p => p.id === programId);

    if (!program) return;

    const searchLower = searchQuery.toLowerCase();
    const matches = !searchQuery ||
      program.name.toLowerCase().includes(searchLower) ||
      program.id.toLowerCase().includes(searchLower) ||
      (program.path && program.path.toLowerCase().includes(searchLower)) ||
      (program.url && program.url.toLowerCase().includes(searchLower));

    if (matches) {
      card.classList.remove('hidden');
      visibleCount++;
    } else {
      card.classList.add('hidden');
    }
  });

  // Show/hide grid and no results message
  if (visibleCount === 0 && searchQuery) {
    programsGrid.classList.add('hidden');
    noResults.classList.remove('hidden');
  } else {
    programsGrid.classList.remove('hidden');
    noResults.classList.add('hidden');
  }
}

// Update stats display
function updateStats(programs) {
  if (!programs) programs = currentPrograms;

  const total = programs.length;
  const running = programs.filter(p => p.status === 'running').length;
  const stopped = programs.filter(p => p.status === 'stopped').length;

  statTotal.textContent = total;
  statRunning.textContent = running;
  statStopped.textContent = stopped;
}

// Create program card
function createProgramCard(program) {
  const template = document.getElementById('programCardTemplate');
  const card = template.content.cloneNode(true).querySelector('.program-card');

  card.setAttribute('data-program-id', program.id);

  const btnStart = card.querySelector('.btn-start');
  const btnStop = card.querySelector('.btn-stop');
  const btnRestart = card.querySelector('.btn-restart');
  const btnLogs = card.querySelector('.btn-logs');
  const btnOpen = card.querySelector('.btn-open');
  const btnEdit = card.querySelector('.btn-edit');
  const btnDelete = card.querySelector('.btn-delete');

  btnStart.addEventListener('click', () => startProgram(program.id, btnStart));
  btnStop.addEventListener('click', () => stopProgram(program.id, btnStop));
  btnRestart.addEventListener('click', () => restartProgram(program.id, btnRestart));
  btnLogs.addEventListener('click', () => toggleLogs(program.id, card));

  // Add click handler for Open button
  btnOpen.addEventListener('click', () => {
    const currentProgram = currentPrograms.find(p => p.id === program.id) || program;
    const targetUrl = pickBestUrl(currentProgram);
    if (targetUrl) {
      window.open(targetUrl, '_blank');
    }
  });

  // Add click handler for Edit button
  btnEdit.addEventListener('click', () => {
    // Fetch the current program details from currentPrograms
    const currentProgram = currentPrograms.find(p => p.id === program.id);
    if (currentProgram) {
      // Fetch full config to get env vars
      api('/api/config')
        .then(res => res.json())
        .then(config => {
          const fullProgram = config.programs.find(p => p.id === program.id);
          if (fullProgram) {
            openModal(fullProgram);
          }
        })
        .catch(err => {
          console.error('Error fetching config:', err);
          showToast('Failed to load program details', 'error');
        });
    }
  });

  // Add click handler for Delete button
  btnDelete.addEventListener('click', () => {
    deleteProgram(program.id, program.name);
  });

  // Add log search functionality
  const logSearch = card.querySelector('.log-search');
  logSearch.addEventListener('input', (e) => {
    filterLogs(card, e.target.value);
  });

  // Add refresh logs button
  const btnRefresh = card.querySelector('.btn-refresh-logs');
  btnRefresh.addEventListener('click', () => {
    refreshLogs(program.id, card);
  });

  const btnCloseLogs = card.querySelector('.btn-close-logs');
  btnCloseLogs.addEventListener('click', () => {
    card.querySelector('.program-logs').classList.add('hidden');
    stopLogPolling(card);
  });

  // Autostart toggle — writes the boolean via the existing PUT endpoint.
  const autostartToggle = card.querySelector('.autostart-toggle');
  if (autostartToggle) {
    autostartToggle.addEventListener('change', () => {
      setAutostart(program.id, autostartToggle.checked, autostartToggle);
    });
  }

  updateProgramCard(card, program);

  return card;
}

// Update program card
function updateProgramCard(card, program) {
  const nameElement = card.querySelector('.program-name');

  const resolvedUrl = resolveProgramUrl(program.url, program);

  // Make program name clickable if URL exists
  if (resolvedUrl) {
    nameElement.innerHTML = '';
    const nameLink = document.createElement('a');
    nameLink.href = resolvedUrl;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.className = 'program-name-link';
    nameLink.textContent = program.name;
    nameElement.appendChild(nameLink);
  } else {
    nameElement.textContent = program.name;
  }

  card.querySelector('.program-path').textContent = program.path;
  card.querySelector('.program-pid').textContent = program.pid || 'N/A';

  // Handle uptime display
  const uptimeRow = card.querySelector('.program-uptime-row');
  const uptimeValue = card.querySelector('.program-uptime');
  if (program.status === 'running' && program.uptime) {
    uptimeRow.classList.remove('hidden');
    uptimeValue.textContent = formatUptime(program.uptime);
  } else {
    uptimeRow.classList.add('hidden');
  }

  // Handle URL display — show every address the program is reachable at
  // (Local LAN, Tailscale, …) so you can pick the one that works from where you
  // are, instead of guessing a single URL. Falls back to the single resolved
  // URL for older payloads that don't include the `urls` array.
  const urlRow = card.querySelector('.program-url-row');
  const urlContainer = card.querySelector('.program-urls');
  const urlLabel = urlRow ? urlRow.querySelector('.label') : null;
  const btnOpen = card.querySelector('.btn-open');

  const urlList = Array.isArray(program.urls) && program.urls.length
    ? program.urls
    : (resolvedUrl ? [{ label: '', url: resolvedUrl, kind: 'custom' }] : []);

  urlContainer.innerHTML = '';

  if (urlList.length) {
    urlRow.classList.remove('hidden');
    if (urlLabel) urlLabel.textContent = urlList.length > 1 ? 'URLs:' : 'URL:';

    urlList.forEach(entry => {
      const item = document.createElement('span');
      item.className = 'program-url-item';

      if (entry.label) {
        const tag = document.createElement('span');
        tag.className = `url-tag url-tag-${entry.kind || 'default'}`;
        tag.textContent = entry.label;
        item.appendChild(tag);
      }

      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'program-url';
      link.textContent = entry.url;
      item.appendChild(link);

      urlContainer.appendChild(item);
    });

    btnOpen.classList.remove('hidden');
  } else {
    urlRow.classList.add('hidden');
    btnOpen.classList.add('hidden');
  }

  const statusBadge = card.querySelector('.program-status');
  const health = program.health || program.status;
  const badgeText = {
    listening: '● listening',
    starting: '○ starting…',
    running: '● running',
    crashed: program.exitCode != null ? `✕ crashed (${program.exitCode})` : '✕ crashed',
    stopped: '■ stopped'
  }[health] || program.status;
  statusBadge.textContent = badgeText;
  statusBadge.className = `program-status badge ${health}`;
  statusBadge.title = {
    listening: 'Process running and its port is accepting connections',
    starting: 'Process running but its port is not responding yet',
    running: 'Process running (no port detected to health-check)',
    crashed: 'Exited unexpectedly — see logs',
    stopped: 'Not running'
  }[health] || '';

  // Autostart toggle reflects server state.
  const autostartToggle = card.querySelector('.autostart-toggle');
  if (autostartToggle) autostartToggle.checked = Boolean(program.autostart);

  const btnStart = card.querySelector('.btn-start');
  const btnStop = card.querySelector('.btn-stop');
  const btnRestart = card.querySelector('.btn-restart');

  if (program.status === 'running') {
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnRestart.disabled = false;
  } else {
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnRestart.disabled = true;
  }
}

// Show loading state on button
function setButtonLoading(button, loading) {
  if (loading) {
    button.classList.add('loading');
    button.disabled = true;
  } else {
    button.classList.remove('loading');
  }
}

// API functions
async function startProgram(id, button) {
  if (button) setButtonLoading(button, true);

  try {
    const response = await api(`/api/programs/${id}/start`, {
      method: 'POST'
    });
    const result = await response.json();

    if (result.success) {
      showToast(`Started ${result.data.name || id}`, 'success');
    } else {
      showToast(`Failed to start: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error starting program:', error);
    showToast('Failed to start program', 'error');
  } finally {
    if (button) setButtonLoading(button, false);
  }
}

async function stopProgram(id, button) {
  if (button) setButtonLoading(button, true);

  try {
    const response = await api(`/api/programs/${id}/stop`, {
      method: 'POST'
    });
    const result = await response.json();

    if (result.success) {
      showToast(`Stopped ${id}`, 'success');
    } else {
      showToast(`Failed to stop: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error stopping program:', error);
    showToast('Failed to stop program', 'error');
  } finally {
    if (button) setButtonLoading(button, false);
  }
}

async function restartProgram(id, button) {
  if (button) setButtonLoading(button, true);

  try {
    const response = await api(`/api/programs/${id}/restart`, {
      method: 'POST'
    });
    const result = await response.json();

    if (result.success) {
      showToast(`Restarted ${result.data.name || id}`, 'success');
    } else {
      showToast(`Failed to restart: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error restarting program:', error);
    showToast('Failed to restart program', 'error');
  } finally {
    if (button) setButtonLoading(button, false);
  }
}

async function toggleLogs(id, card) {
  const logsContainer = card.querySelector('.program-logs');

  if (!logsContainer.classList.contains('hidden')) {
    logsContainer.classList.add('hidden');
    stopLogPolling(card);
    return;
  }

  await loadLogs(id, card);
  logsContainer.classList.remove('hidden');
  // Live-tail while the panel is open so remote debugging doesn't need manual
  // refreshes (logs still stream to disk server-side).
  startLogPolling(id, card);
}

function startLogPolling(id, card) {
  stopLogPolling(card);
  card._logPoller = setInterval(async () => {
    const panel = card.querySelector('.program-logs');
    if (!panel || panel.classList.contains('hidden')) {
      stopLogPolling(card);
      return;
    }
    await loadLogs(id, card);
    const searchInput = card.querySelector('.log-search');
    if (searchInput && searchInput.value) filterLogs(card, searchInput.value);
  }, 2500);
}

function stopLogPolling(card) {
  if (card._logPoller) {
    clearInterval(card._logPoller);
    card._logPoller = null;
  }
}

// Toggle a program's autostart-on-boot flag from the card.
async function setAutostart(id, enabled, toggleEl) {
  try {
    const res = await api(`/api/programs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autostart: enabled })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`Autostart ${enabled ? 'enabled' : 'disabled'} for ${id}`, 'success', 2000);
    } else {
      showToast(`Failed: ${result.error}`, 'error');
      if (toggleEl) toggleEl.checked = !enabled;
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') showToast('Failed to update autostart', 'error');
    if (toggleEl) toggleEl.checked = !enabled;
  }
}

async function loadLogs(id, card) {
  const logsContent = card.querySelector('.logs-content');

  try {
    const response = await api(`/api/programs/${id}/logs?lines=100`);
    const logs = await response.json();

    if (logs.length === 0) {
      logsContent.textContent = 'No logs available';
      logsContent.setAttribute('data-full-logs', '');
    } else {
      const fullText = logs.map(log => `${log.time} ${log.text}`).join('\n');
      logsContent.textContent = fullText;
      logsContent.setAttribute('data-full-logs', fullText);
      // Scroll to bottom
      logsContent.scrollTop = logsContent.scrollHeight;
    }
  } catch (error) {
    console.error('Error fetching logs:', error);
    logsContent.textContent = 'Error loading logs';
    showToast('Failed to load logs', 'error');
  }
}

async function refreshLogs(id, card) {
  await loadLogs(id, card);
  const searchInput = card.querySelector('.log-search');
  if (searchInput.value) {
    filterLogs(card, searchInput.value);
  }
  showToast('Logs refreshed', 'info', 2000);
}

function filterLogs(card, searchTerm) {
  const logsContent = card.querySelector('.logs-content');
  const fullLogs = logsContent.getAttribute('data-full-logs') || '';

  if (!searchTerm) {
    logsContent.textContent = fullLogs;
    return;
  }

  const lines = fullLogs.split('\n');
  const filtered = lines.filter(line =>
    line.toLowerCase().includes(searchTerm.toLowerCase())
  );

  logsContent.textContent = filtered.join('\n') || 'No matching logs found';
}

// Bulk Operations
async function startAll() {
  const stoppedPrograms = currentPrograms.filter(p => p.status === 'stopped');
  if (stoppedPrograms.length === 0) {
    showToast('No stopped programs to start', 'info');
    return;
  }

  showToast(`Starting ${stoppedPrograms.length} program(s)...`, 'info', 2000);

  for (const program of stoppedPrograms) {
    await startProgram(program.id);
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between starts
  }
}

async function stopAll() {
  const runningPrograms = currentPrograms.filter(p => p.status === 'running');
  if (runningPrograms.length === 0) {
    showToast('No running programs to stop', 'info');
    return;
  }

  if (!confirm(`Are you sure you want to stop ${runningPrograms.length} program(s)?`)) {
    return;
  }

  showToast(`Stopping ${runningPrograms.length} program(s)...`, 'info', 2000);

  for (const program of runningPrograms) {
    await stopProgram(program.id);
    await new Promise(resolve => setTimeout(resolve, 300)); // Small delay between stops
  }
}

async function restartAll() {
  const runningPrograms = currentPrograms.filter(p => p.status === 'running');
  if (runningPrograms.length === 0) {
    showToast('No running programs to restart', 'info');
    return;
  }

  if (!confirm(`Are you sure you want to restart ${runningPrograms.length} program(s)?`)) {
    return;
  }

  showToast(`Restarting ${runningPrograms.length} program(s)...`, 'info', 2000);

  for (const program of runningPrograms) {
    await restartProgram(program.id);
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between restarts
  }
}

async function rediscoverProjects() {
  // Prompt for projects directory (defaults to the manager's PROJECTS_DIR,
  // fetched from /api/config into defaultBrowseDir).
  const defaultPath = defaultBrowseDir || '';
  const projectsDir = prompt(
    'Enter the path to your projects directory:\n\n' +
    'This will scan the directory for projects with Start.sh files\n' +
    'and regenerate config.json.\n\n' +
    'Your existing config will be backed up.',
    defaultPath
  );

  // User cancelled
  if (projectsDir === null) {
    return;
  }

  // Validate input
  const trimmedPath = projectsDir.trim();
  if (!trimmedPath) {
    showToast('❌ Please enter a valid directory path', 'error');
    return;
  }

  showToast('Rediscovering projects…', 'info', 3000);

  try {
    const response = await api('/api/rediscover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectsDir: trimmedPath })
    });

    const data = await response.json();

    if (data.success) {
      showToast(`✅ Rediscovered ${data.projectCount} project(s) from ${trimmedPath}!`, 'success', 5000);
      // Status will be updated automatically via WebSocket
    } else {
      showToast(`❌ Rediscovery failed: ${data.error}`, 'error', 5000);
    }
  } catch (err) {
    console.error('Failed to call /api/rediscover:', err);
    showToast('Failed to trigger project rediscovery', 'error', 4000);
  }
}

// ---------------------------------------------------------------------------
// Import a program from a git repository
// ---------------------------------------------------------------------------
const importModal = document.getElementById('importModal');

function openImportModal() {
  const form = document.getElementById('importForm');
  if (form) form.reset();
  const status = document.getElementById('importStatus');
  if (status) {
    status.classList.add('hidden');
    status.textContent = '';
  }
  importModal.classList.remove('hidden');
  const urlInput = document.getElementById('importRepoUrl');
  if (urlInput) setTimeout(() => urlInput.focus(), 0);
}

function closeImportModal() {
  importModal.classList.add('hidden');
}

async function importRepo(e) {
  e.preventDefault();

  const repoUrl = document.getElementById('importRepoUrl').value.trim();
  const branch = document.getElementById('importBranch').value.trim();
  const name = document.getElementById('importName').value.trim();
  const status = document.getElementById('importStatus');
  const submitBtn = document.getElementById('importSubmit');

  if (!repoUrl) {
    showToast('❌ Please enter a repository URL', 'error');
    return;
  }

  // Cloning can take a while — reflect that in the UI and prevent double submits.
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = 'Importing…';
  if (status) {
    status.classList.remove('hidden');
    status.textContent = `Cloning ${repoUrl}… this can take a moment.`;
  }
  showToast('Importing repository…', 'info', 3000);

  try {
    const response = await api('/api/import-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, branch, name })
    });

    const data = await response.json();

    if (data.success) {
      showToast(`✅ ${data.message}`, 'success', 6000);
      closeImportModal();
      // Program list refreshes automatically via WebSocket broadcast.
    } else {
      if (status) status.textContent = `❌ ${data.error}`;
      showToast(`❌ Import failed: ${data.error}`, 'error', 6000);
    }
  } catch (err) {
    console.error('Failed to call /api/import-repo:', err);
    if (status) status.textContent = '❌ Failed to reach the manager.';
    showToast('Failed to import repository', 'error', 4000);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
}

async function restartManager() {
  if (!confirm('Restart HTTP Server Manager now?\n\nThis will stop the manager process; make sure a supervisor (systemd, another Server Manager, etc.) is configured to auto-restart it.')) {
    return;
  }

  showToast('Restarting HTTP Server Manager…', 'info', 3000);

  try {
    const response = await api('/api/restart-manager', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user-request' })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json().catch(() => ({}));
    if (data && data.message) {
      showToast(data.message, 'success', 3000);
    }
  } catch (err) {
    console.error('Failed to call /api/restart-manager:', err);
    showToast('Failed to trigger HTTP Server Manager restart', 'error', 4000);
  }
}

// Modal and editing functions
let editingProgram = null;
const programModal = document.getElementById('programModal');
const modalTitle = document.getElementById('modalTitle');
const programForm = document.getElementById('programForm');
const programIdInput = document.getElementById('programId');
const programNameInput = document.getElementById('programName');
const programPathInput = document.getElementById('programPath');
const programUrlInput = document.getElementById('programUrl');
const envVarsContainer = document.getElementById('envVars');

function openModal(program = null) {
  editingProgram = program;

  if (program) {
    // Editing existing program
    modalTitle.textContent = 'Edit Program';
    programIdInput.value = program.id;
    programIdInput.disabled = true; // Can't change ID
    programNameInput.value = program.name;
    programPathInput.value = program.path || '';
    programUrlInput.value = program.url || '';

    // Load environment variables
    envVarsContainer.innerHTML = '';
    if (program.env) {
      Object.entries(program.env).forEach(([key, value]) => {
        addEnvVarRow(key, value);
      });
    }
  } else {
    // Adding new program
    modalTitle.textContent = 'Add Program';
    programIdInput.disabled = false;
    programForm.reset();
    envVarsContainer.innerHTML = '';
    // Add default env vars
    addEnvVarRow('HOST', '0.0.0.0');
    addEnvVarRow('PORT', '');
  }

  programModal.classList.remove('hidden');
}

function closeModal() {
  programModal.classList.add('hidden');
  programForm.reset();
  editingProgram = null;
  document.getElementById('projectBrowser').classList.add('hidden');
}

function addEnvVarRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'env-var-row';

  // Build with DOM APIs (not innerHTML) so env values can't inject markup and so
  // there's no inline onclick handler for the Content-Security-Policy to block.
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.className = 'env-key';
  keyInput.placeholder = 'KEY';
  keyInput.value = key;
  keyInput.pattern = '[A-Z_][A-Z0-9_]*';
  keyInput.title = 'Uppercase letters, numbers, and underscores';

  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'env-value';
  valueInput.placeholder = 'value';
  valueInput.value = value;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-env';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  envVarsContainer.appendChild(row);
}

async function saveProgram(e) {
  e.preventDefault();

  const id = programIdInput.value.trim();
  const name = programNameInput.value.trim();
  const path = programPathInput.value.trim();
  const url = programUrlInput.value.trim();

  // Collect environment variables
  const env = {};
  const envRows = envVarsContainer.querySelectorAll('.env-var-row');
  envRows.forEach(row => {
    const key = row.querySelector('.env-key').value.trim();
    const value = row.querySelector('.env-value').value.trim();
    if (key) {
      env[key] = value;
    }
  });

  const programData = {
    id,
    name,
    path,
    env
  };

  if (url) {
    programData.url = url;
  }

  try {
    let response;
    if (editingProgram) {
      // Update existing program
      response = await api(`/api/programs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(programData)
      });
    } else {
      // Add new program
      response = await api('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(programData)
      });
    }

    const result = await response.json();

    if (result.success) {
      showToast(result.message, 'success');
      closeModal();
      // Status will update automatically via WebSocket
    } else {
      showToast(`Failed: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error saving program:', error);
    showToast('Failed to save program', 'error');
  }
}

async function deleteProgram(id, programName) {
  if (!confirm(`Are you sure you want to delete "${programName}"?\n\nThis will stop the program if running and remove it from the config.`)) {
    return;
  }

  try {
    const response = await api(`/api/programs/${id}`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      showToast(result.message, 'success');
      // Status will update automatically via WebSocket
    } else {
      showToast(`Failed: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error deleting program:', error);
    showToast('Failed to delete program', 'error');
  }
}

// ── Project browser ──────────────────────────────────────────────────────────

let defaultBrowseDir = '';

async function fetchDefaultBrowseDir() {
  try {
    const res = await api('/api/config');
    const data = await res.json();
    if (data.projectsDir) {
      defaultBrowseDir = data.projectsDir;
    } else if (data.programs && data.programs.length > 0) {
      // Fall back to parent of first program path
      const firstPath = data.programs[0].path || '';
      const parts = firstPath.split('/');
      parts.pop();
      defaultBrowseDir = parts.join('/');
    }
  } catch (e) { /* ignore */ }
}

async function scanBrowseDir() {
  const dirInput = document.getElementById('browserDir');
  const list = document.getElementById('browserList');
  const dir = dirInput.value.trim();

  if (!dir) {
    list.innerHTML = '<div class="browser-empty">Enter a directory path</div>';
    return;
  }

  list.innerHTML = '<div class="browser-scanning">Scanning…</div>';

  try {
    const res = await api('/api/browse-projects?dir=' + encodeURIComponent(dir));
    const data = await res.json();

    if (!data.success) {
      list.innerHTML = '<div class="browser-empty">Error: ' + data.error + '</div>';
      return;
    }

    if (data.projects.length === 0) {
      list.innerHTML = '<div class="browser-empty">No projects with Start.sh found in this directory</div>';
      return;
    }

    list.innerHTML = '';
    for (const proj of data.projects) {
      const item = document.createElement('div');
      item.className = 'browser-item' + (proj.alreadyAdded ? ' already-added' : '');
      item.title = proj.alreadyAdded ? 'Already in config' : 'Click to select';

      const icon = document.createElement('span');
      icon.className = 'browser-item-icon';
      icon.textContent = proj.alreadyAdded ? '✓' : '📁';

      const info = document.createElement('div');
      info.className = 'browser-item-info';

      const name = document.createElement('div');
      name.className = 'browser-item-name';
      name.textContent = proj.name;

      const pathEl = document.createElement('div');
      pathEl.className = 'browser-item-path';
      pathEl.textContent = proj.path;

      info.appendChild(name);
      info.appendChild(pathEl);

      item.appendChild(icon);
      item.appendChild(info);

      if (proj.alreadyAdded) {
        const badge = document.createElement('span');
        badge.className = 'browser-item-badge';
        badge.textContent = 'Added';
        item.appendChild(badge);
      }

      if (!proj.alreadyAdded) {
        item.addEventListener('click', () => selectBrowsedProject(proj));
      }

      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = '<div class="browser-empty">Failed to scan directory</div>';
    console.error('Browse projects error:', err);
  }
}

function selectBrowsedProject(proj) {
  programPathInput.value = proj.path;

  // Auto-fill name and ID only when adding a new program
  if (!editingProgram) {
    programNameInput.value = proj.name;
    // Generate a safe ID if the field is empty
    if (!programIdInput.value) {
      programIdInput.value = proj.id;
    }
    // Populate env vars (replace defaults)
    envVarsContainer.innerHTML = '';
    for (const [k, v] of Object.entries(proj.env)) {
      addEnvVarRow(k, v);
    }
    // Ensure PORT row exists if not already present
    if (!proj.env.PORT) {
      addEnvVarRow('PORT', '');
    }
  }

  // Collapse the browser after selection
  document.getElementById('projectBrowser').classList.add('hidden');
}

function toggleProjectBrowser() {
  const browser = document.getElementById('projectBrowser');
  const isHidden = browser.classList.toggle('hidden');
  if (!isHidden) {
    // Show browser — pre-fill dir and auto-scan
    const dirInput = document.getElementById('browserDir');
    if (!dirInput.value && defaultBrowseDir) {
      dirInput.value = defaultBrowseDir;
    }
    if (dirInput.value) {
      scanBrowseDir();
    }
    dirInput.focus();
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Login modal wiring
  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', submitLogin);
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) btnLogout.addEventListener('click', logout);

  // Setup bulk action buttons
  document.getElementById('btnStartAll').addEventListener('click', startAll);
  document.getElementById('btnStopAll').addEventListener('click', stopAll);
  document.getElementById('btnRestartAll').addEventListener('click', restartAll);

  const btnRediscover = document.getElementById('btnRediscover');
  if (btnRediscover) {
    btnRediscover.addEventListener('click', rediscoverProjects);
  }

  const btnRestartManager = document.getElementById('btnRestartManager');
  if (btnRestartManager) {
    btnRestartManager.addEventListener('click', restartManager);
  }

  // Import-from-git modal
  const btnImportRepo = document.getElementById('btnImportRepo');
  if (btnImportRepo) {
    btnImportRepo.addEventListener('click', openImportModal);
    document.getElementById('importModalClose').addEventListener('click', closeImportModal);
    document.getElementById('importCancel').addEventListener('click', closeImportModal);
    document.getElementById('importForm').addEventListener('submit', importRepo);
    importModal.addEventListener('click', (e) => {
      if (e.target === importModal) closeImportModal();
    });
  }

  // Setup modal event listeners
  document.getElementById('btnAddProgram').addEventListener('click', () => openModal());
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  document.getElementById('programForm').addEventListener('submit', saveProgram);
  document.getElementById('btnAddEnvVar').addEventListener('click', () => addEnvVarRow());

  // Project browser
  document.getElementById('btnBrowseProjects').addEventListener('click', toggleProjectBrowser);
  document.getElementById('btnScanDir').addEventListener('click', scanBrowseDir);
  document.getElementById('browserDir').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); scanBrowseDir(); }
  });

  // Close modal on background click
  programModal.addEventListener('click', (e) => {
    if (e.target === programModal) {
      closeModal();
    }
  });

  // Setup search functionality
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    filterPrograms();

    // Show/hide clear button
    if (searchQuery) {
      btnClearSearch.classList.remove('hidden');
    } else {
      btnClearSearch.classList.add('hidden');
    }
  });

  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    filterPrograms();
    btnClearSearch.classList.add('hidden');
    searchInput.focus();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Escape: Close modal or clear search
    if (e.key === 'Escape') {
      if (importModal && !importModal.classList.contains('hidden')) {
        closeImportModal();
      } else if (!programModal.classList.contains('hidden')) {
        closeModal();
      } else if (searchQuery) {
        searchInput.value = '';
        searchQuery = '';
        filterPrograms();
        btnClearSearch.classList.add('hidden');
        searchInput.blur();
      }
    }

    // Ctrl/Cmd + F: Focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }

    // Ctrl/Cmd + K: Focus search (alternate shortcut)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  init();

  // Periodically update uptime displays
  setInterval(() => {
    document.querySelectorAll('.program-uptime').forEach(element => {
      const card = element.closest('.program-card');
      const programId = card.getAttribute('data-program-id');
      const program = currentPrograms.find(p => p.id === programId);
      if (program && program.status === 'running' && program.uptime) {
        element.textContent = formatUptime(program.uptime);
      }
    });
  }, 1000);

  // Show keyboard shortcuts hint
  console.log('🎮 Keyboard Shortcuts:');
  console.log('  Ctrl/Cmd + F or K: Focus search');
  console.log('  Escape: Clear search');
});
