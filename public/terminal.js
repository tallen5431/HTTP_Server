// ---------------------------------------------------------------------------
// Devices (tailnet discovery) and the browser SSH terminal.
//
// Relies on globals from app.js: api, apiToken, base64url, showToast.
// xterm.js is served by the manager under /vendor and loaded on first use, so
// the dashboard doesn't pay for it until a terminal is opened.
// ---------------------------------------------------------------------------
const devicesModal = document.getElementById('devicesModal');
const terminalModal = document.getElementById('terminalModal');

let terminalEnabled = false;
let terminalState = null; // { term, fit, socket, onResize, device }
let xtermLoading = null;

function loadXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (xtermLoading) return xtermLoading;
  const addScript = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}. Run npm install on the manager.`));
    document.head.appendChild(el);
  });
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/vendor/xterm.css';
  document.head.appendChild(css);
  xtermLoading = addScript('/vendor/xterm.js')
    .then(() => addScript('/vendor/addon-fit.js'))
    .catch((err) => { xtermLoading = null; throw err; });
  return xtermLoading;
}

// The SSH login name per device lives on this browser only.
function savedSshUser(deviceId) {
  try { return localStorage.getItem(`sshUser:${deviceId}`) || ''; } catch (_) { return ''; }
}

function saveSshUser(deviceId, user) {
  try {
    if (user) localStorage.setItem(`sshUser:${deviceId}`, user);
    else localStorage.removeItem(`sshUser:${deviceId}`);
  } catch (_) { /* storage unavailable: just don't remember it */ }
}

function formatLastSeen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `seen ${Math.max(mins, 1)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}

function openDevicesModal() {
  devicesModal.classList.remove('hidden');
  loadDevices(false);
}

function closeDevicesModal() {
  devicesModal.classList.add('hidden');
}

async function loadDevices(fresh) {
  const list = document.getElementById('devicesList');
  const notice = document.getElementById('devicesNotice');
  list.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'devices-empty';
  loading.textContent = 'Loading devices…';
  list.appendChild(loading);

  let data;
  try {
    const res = await api(`/api/remote-hosts${fresh ? '?refresh=1' : ''}`);
    data = await res.json();
  } catch (err) {
    loading.textContent = `Could not load devices: ${err.message}`;
    return;
  }

  terminalEnabled = Boolean(data.terminal && data.terminal.enabled);
  const notices = [];
  if (!terminalEnabled && data.terminal && data.terminal.reason) notices.push(data.terminal.reason);
  if (data.error) notices.push(data.error);
  notice.textContent = notices.join(' ');
  notice.classList.toggle('hidden', notices.length === 0);

  list.textContent = '';
  if (!data.devices || data.devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'devices-empty';
    empty.textContent = data.error ? 'No devices to show.' : 'No devices found on this tailnet.';
    list.appendChild(empty);
    return;
  }
  data.devices.forEach(device => list.appendChild(renderDeviceRow(device)));
}

function renderDeviceRow(device) {
  const row = document.createElement('div');
  row.className = 'device-row';

  const info = document.createElement('div');
  info.className = 'device-info';

  const title = document.createElement('div');
  title.className = 'device-title';
  const dot = document.createElement('span');
  dot.className = `device-dot ${device.online ? 'online' : 'offline'}`;
  dot.title = device.online ? 'Online' : 'Offline';
  const name = document.createElement('span');
  name.className = 'device-name';
  name.textContent = device.name;
  title.append(dot, name);
  if (device.self) {
    const tag = document.createElement('span');
    tag.className = 'device-tag';
    tag.textContent = 'this machine';
    title.appendChild(tag);
  }
  if (device.tailscaleSsh) {
    const tag = document.createElement('span');
    tag.className = 'device-tag device-tag-ssh';
    tag.textContent = 'Tailscale SSH';
    tag.title = 'Signs in with your tailnet identity; no SSH key needed';
    title.appendChild(tag);
  }

  const meta = document.createElement('div');
  meta.className = 'device-meta';
  meta.textContent = [device.dnsName || device.address, device.address !== device.dnsName ? device.address : '',
    device.os, device.online ? '' : formatLastSeen(device.lastSeen)].filter(Boolean).join(' · ');
  info.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'device-actions';
  const user = document.createElement('input');
  user.type = 'text';
  user.className = 'form-input device-user';
  user.placeholder = 'user (optional)';
  user.autocapitalize = 'off';
  user.spellcheck = false;
  user.value = savedSshUser(device.id);
  user.title = 'SSH login name. Blank uses ~/.ssh/config or the manager\'s own user.';

  const connect = document.createElement('button');
  connect.className = 'btn btn-primary btn-sm';
  connect.textContent = '>_ Connect';
  connect.disabled = !terminalEnabled || !device.online;
  if (!device.online) connect.title = 'Device is offline';
  const go = () => {
    if (connect.disabled) return;
    const login = user.value.trim();
    saveSshUser(device.id, login);
    closeDevicesModal();
    openTerminal(device, login);
  };
  connect.addEventListener('click', go);
  user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });

  actions.append(user, connect);
  row.append(info, actions);
  return row;
}

function setTerminalStatus(text, kind) {
  const el = document.getElementById('terminalStatus');
  el.textContent = text;
  el.className = `terminal-status ${kind || ''}`;
}

async function openTerminal(device, user) {
  closeTerminal();
  document.getElementById('terminalTitle').textContent = `${user ? `${user}@` : ''}${device.name}`;
  setTerminalStatus('Connecting…', 'pending');
  terminalModal.classList.remove('hidden');

  try {
    await loadXterm();
  } catch (err) {
    setTerminalStatus(err.message, 'error');
    return;
  }

  const container = document.getElementById('terminalContainer');
  container.textContent = '';
  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 14,
    scrollback: 5000,
    theme: { background: '#1e1e1e' }
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();
  term.focus();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ device: device.id, rows: term.rows, cols: term.cols });
  if (user) params.set('user', user);
  const protocols = ['terminal'];
  if (apiToken) protocols.push('bearer.' + base64url(apiToken));

  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?${params}`, protocols);
  socket.binaryType = 'arraybuffer';
  const state = { term, fit, socket, device, exited: false };
  terminalState = state;

  const send = (msg) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg)); };

  socket.onopen = () => setTerminalStatus('Connected', 'ok');
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      term.write(new Uint8Array(event.data));
      return;
    }
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    if (msg.type === 'error') {
      term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      setTerminalStatus(msg.message, 'error');
    } else if (msg.type === 'exit') {
      state.exited = true;
      setTerminalStatus(msg.code === 0 ? 'Session ended' : `Session ended (exit ${msg.code})`,
        msg.code === 0 ? '' : 'error');
    }
  };
  socket.onclose = (event) => {
    if (terminalState !== state) return;
    if (!state.exited && event.code !== 1000) {
      // 1008 with no error message means the token was rejected at the handshake.
      const reason = event.reason === 'Unauthorized' ? 'Not signed in (token rejected)' : 'Disconnected';
      if (!document.getElementById('terminalStatus').classList.contains('error')) {
        setTerminalStatus(reason, 'error');
      }
    }
    term.options.cursorBlink = false;
  };

  term.onData((data) => send({ type: 'input', data }));
  term.onResize(({ rows, cols }) => send({ type: 'resize', rows, cols }));

  state.onResize = () => { try { fit.fit(); } catch (_) { /* hidden */ } };
  window.addEventListener('resize', state.onResize);
}

function closeTerminal() {
  const state = terminalState;
  terminalState = null;
  if (state) {
    window.removeEventListener('resize', state.onResize);
    try { state.socket.close(); } catch (_) { /* already closed */ }
    state.term.dispose();
  }
  terminalModal.classList.add('hidden');
}

function terminalIsOpen() {
  return !terminalModal.classList.contains('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnDevices').addEventListener('click', openDevicesModal);
  document.getElementById('devicesModalClose').addEventListener('click', closeDevicesModal);
  document.getElementById('btnRefreshDevices').addEventListener('click', () => loadDevices(true));
  devicesModal.addEventListener('click', (e) => { if (e.target === devicesModal) closeDevicesModal(); });
  // No close-on-backdrop or Escape for the terminal: Escape belongs to vim/less,
  // and a stray click shouldn't end an SSH session.
  document.getElementById('terminalClose').addEventListener('click', closeTerminal);
});
