// ---------------------------------------------------------------------------
// Devices (tailnet discovery) and the browser SSH terminal.
//
// Relies on globals from app.js: api, apiToken, base64url, showToast.
// xterm.js is served by the manager under /vendor and loaded on first use, so
// the dashboard doesn't pay for it until a terminal is opened.
// ---------------------------------------------------------------------------
const devicesModal = document.getElementById('devicesModal');
const terminalModal = document.getElementById('terminalModal');

const MAX_RECENT = 5;
const FONT_MIN = 9;
const FONT_MAX = 24;
const KEY_REPEAT_DELAY_MS = 400;
const KEY_REPEAT_INTERVAL_MS = 70;
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

let terminalEnabled = false;
let currentDevices = [];
// The open terminal: { term, fit, socket, target, exited, ... }. `target` is
// what to (re)connect to: { device, user, persist }.
let terminalState = null;
let xtermLoading = null;

// Sticky modifiers from the extra-keys bar: tap Ctrl, then a letter.
const modifiers = { ctrl: false, alt: false };

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
  // Wait for the stylesheet too: sizing the terminal before it applies gives
  // the wrong column count, and text runs off the right edge.
  const addCss = (href) => new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = href;
    css.onload = resolve;
    css.onerror = resolve; // unstyled still works; don't block the terminal on it
    document.head.appendChild(css);
  });
  xtermLoading = Promise.all([addCss('/vendor/xterm.css'), addScript('/vendor/xterm.js')])
    .then(() => addScript('/vendor/addon-fit.js'))
    .catch((err) => { xtermLoading = null; throw err; });
  return xtermLoading;
}

// ---------------------------------------------------------------------------
// Per-browser preferences. Storage can be unavailable (private mode), in which
// case nothing is remembered and everything still works.
// ---------------------------------------------------------------------------
function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) { return fallback; }
}

function writePref(key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (_) { /* storage unavailable */ }
}

// The SSH login name per device. Stored as a plain string by the first version.
function savedSshUser(deviceId) {
  try { return localStorage.getItem(`sshUser:${deviceId}`) || ''; } catch (_) { return ''; }
}

function saveSshUser(deviceId, user) {
  try {
    if (user) localStorage.setItem(`sshUser:${deviceId}`, user);
    else localStorage.removeItem(`sshUser:${deviceId}`);
  } catch (_) { /* storage unavailable */ }
}

const savedPersist = (deviceId) => readPref(`sshPersist:${deviceId}`, false) === true;
const savePersist = (deviceId, on) => writePref(`sshPersist:${deviceId}`, on ? true : null);
const defaultFontSize = () => (window.innerWidth < 640 ? 12 : 14);
const savedFontSize = (deviceId) => readPref(`termFont:${deviceId}`, defaultFontSize());

function recentTerminals() {
  const list = readPref('recentTerminals', []);
  return Array.isArray(list) ? list.filter(r => r && typeof r.id === 'string') : [];
}

function rememberRecent(device, user, persist) {
  const entry = { id: device.id, name: device.name, user: user || '', persist: Boolean(persist) };
  const rest = recentTerminals().filter(r => !(r.id === entry.id && r.user === entry.user));
  writePref('recentTerminals', [entry, ...rest].slice(0, MAX_RECENT));
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

// ---------------------------------------------------------------------------
// Devices modal
// ---------------------------------------------------------------------------
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
  currentDevices = Array.isArray(data.devices) ? data.devices : [];
  const notices = [];
  if (!terminalEnabled && data.terminal && data.terminal.reason) notices.push(data.terminal.reason);
  if (data.error) notices.push(data.error);
  notice.textContent = notices.join(' ');
  notice.classList.toggle('hidden', notices.length === 0);

  renderRecent();

  list.textContent = '';
  if (currentDevices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'devices-empty';
    empty.textContent = data.error ? 'No devices to show.' : 'No devices found on this tailnet.';
    list.appendChild(empty);
    return;
  }
  currentDevices.forEach(device => list.appendChild(renderDeviceRow(device)));
}

// One-tap reconnects to the devices used most recently on this browser.
function renderRecent() {
  const section = document.getElementById('devicesRecent');
  const list = document.getElementById('devicesRecentList');
  list.textContent = '';
  const recent = recentTerminals()
    .map(r => ({ ...r, device: currentDevices.find(d => d.id === r.id) }))
    .filter(r => r.device);
  section.classList.toggle('hidden', !terminalEnabled || recent.length === 0);

  for (const r of recent) {
    const chip = document.createElement('button');
    chip.className = 'recent-chip';
    chip.disabled = !r.device.online;
    chip.title = r.device.online ? `Connect to ${r.device.name}` : `${r.device.name} is offline`;
    const dot = document.createElement('span');
    dot.className = `device-dot ${r.device.online ? 'online' : 'offline'}`;
    const label = document.createElement('span');
    label.textContent = `${r.user ? `${r.user}@` : ''}${r.device.name}`;
    chip.append(dot, label);
    if (r.persist) {
      const tag = document.createElement('span');
      tag.className = 'recent-chip-tag';
      tag.textContent = 'tmux';
      chip.appendChild(tag);
    }
    chip.addEventListener('click', () => {
      closeDevicesModal();
      openTerminal({ device: r.device, user: r.user, persist: r.persist });
    });
    list.appendChild(chip);
  }
}

// Phones and tablets show up on the tailnet but don't run an SSH server.
const NO_SSH_OS = new Set(['android', 'ios', 'ipados']);

function connectionSummary(user, persist) {
  return [user ? `as ${user}` : '', persist ? 'keep session' : ''].filter(Boolean).join(' · ');
}

// A compact row: name, address and a Connect button. The login name and "Keep
// session" sit behind the ⚙ button, since they're set once per device and then
// remembered (shown as a summary line under the address).
function renderDeviceRow(device) {
  const row = document.createElement('div');
  row.className = 'device-row';
  const sshCapable = !NO_SSH_OS.has(String(device.os).toLowerCase());

  const main = document.createElement('div');
  main.className = 'device-main';

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
  meta.textContent = [device.address, device.os, device.online ? '' : formatLastSeen(device.lastSeen)]
    .filter(Boolean).join(' · ');
  if (device.dnsName) meta.title = device.dnsName;

  const summary = document.createElement('div');
  summary.className = 'device-summary';
  info.append(title, meta, summary);
  main.appendChild(info);
  row.appendChild(main);

  if (!sshCapable) {
    const note = document.createElement('span');
    note.className = 'device-no-ssh';
    note.textContent = 'no SSH';
    note.title = 'Phones and tablets don\'t run an SSH server';
    main.appendChild(note);
    return row;
  }

  const user = document.createElement('input');
  user.type = 'text';
  user.className = 'form-input device-user';
  user.placeholder = 'login name';
  user.autocapitalize = 'off';
  user.setAttribute('autocorrect', 'off');
  user.autocomplete = 'off';
  user.spellcheck = false;
  user.value = savedSshUser(device.id);
  user.title = 'SSH login name. Blank uses ~/.ssh/config or the manager\'s own user.';

  const keep = document.createElement('label');
  keep.className = 'device-keep';
  keep.title = 'Run the shell in tmux on the device, so it keeps running if you disconnect ' +
    '(phone locked, app switched) and you pick up where you left off';
  const keepBox = document.createElement('input');
  keepBox.type = 'checkbox';
  keepBox.checked = savedPersist(device.id);
  keep.append(keepBox, document.createTextNode(' Keep session (tmux)'));

  const updateSummary = () => {
    summary.textContent = connectionSummary(user.value.trim(), keepBox.checked);
  };
  updateSummary();
  const save = () => {
    saveSshUser(device.id, user.value.trim());
    savePersist(device.id, keepBox.checked);
    updateSummary();
  };
  user.addEventListener('input', save);
  keepBox.addEventListener('change', save);

  const options = document.createElement('div');
  options.className = 'device-options hidden';
  options.append(user, keep);

  const settings = document.createElement('button');
  settings.className = 'btn btn-secondary btn-sm device-settings';
  settings.textContent = '⚙';
  settings.title = 'Login name and session options';
  settings.setAttribute('aria-label', 'Connection options');
  settings.addEventListener('click', () => {
    const show = options.classList.contains('hidden');
    options.classList.toggle('hidden', !show);
    settings.classList.toggle('active', show);
    if (show) user.focus();
  });

  const connect = document.createElement('button');
  connect.className = 'btn btn-primary btn-sm device-connect';
  connect.textContent = 'Connect';
  connect.disabled = !terminalEnabled || !device.online;
  if (!device.online) connect.title = 'Device is offline';
  const go = () => {
    if (connect.disabled) return;
    save();
    closeDevicesModal();
    openTerminal({ device, user: user.value.trim(), persist: keepBox.checked });
  };
  connect.addEventListener('click', go);
  user.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });

  const actions = document.createElement('div');
  actions.className = 'device-actions';
  actions.append(settings, connect);
  main.appendChild(actions);
  row.appendChild(options);
  return row;
}

// ---------------------------------------------------------------------------
// Extra keys: what a phone keyboard lacks. Arrows follow the terminal's cursor
// mode (vim and less switch it), and Ctrl/Alt latch until the next typed key.
// ---------------------------------------------------------------------------
const EXTRA_KEYS = [
  { label: 'Esc', send: '\x1b' },
  { label: 'Tab', send: '\t' },
  { label: 'Ctrl', modifier: 'ctrl' },
  { label: 'Alt', modifier: 'alt' },
  { label: '←', cursor: 'D', repeat: true },
  { label: '↑', cursor: 'A', repeat: true },
  { label: '↓', cursor: 'B', repeat: true },
  { label: '→', cursor: 'C', repeat: true },
  { label: 'Home', cursor: 'H' },
  { label: 'End', cursor: 'F' },
  { label: 'PgUp', send: '\x1b[5~', repeat: true },
  { label: 'PgDn', send: '\x1b[6~', repeat: true },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '_', send: '_' },
  { label: ':', send: ':' }
];

function keySequence(key) {
  if (key.cursor) {
    const app = terminalState && terminalState.term.modes &&
      terminalState.term.modes.applicationCursorKeysMode;
    return (app ? '\x1bO' : '\x1b[') + key.cursor;
  }
  return key.send;
}

// Ctrl+<key> as the byte a real keyboard would send: Ctrl+C is 0x03, etc.
function applyModifiers(data) {
  if (!modifiers.ctrl && !modifiers.alt) return data;
  let first = data[0];
  const rest = data.slice(1);
  if (modifiers.ctrl) {
    const code = first.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) first = String.fromCharCode(code - 64); // @ A-Z [ \ ] ^ _
    else if (first === ' ') first = '\x00';
    else if (first === '?') first = '\x7f';
  }
  if (modifiers.alt) first = '\x1b' + first;
  setModifier('ctrl', false);
  setModifier('alt', false);
  return first + rest;
}

function setModifier(name, on) {
  modifiers[name] = on;
  const btn = document.querySelector(`.terminal-key[data-modifier="${name}"]`);
  if (btn) btn.classList.toggle('active', on);
}

function renderExtraKeys() {
  const bar = document.getElementById('terminalKeys');
  bar.textContent = '';
  for (const key of EXTRA_KEYS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'terminal-key';
    btn.textContent = key.label;
    btn.tabIndex = -1;
    if (key.modifier) btn.dataset.modifier = key.modifier;

    let repeatTimer = null;
    const stopRepeat = () => {
      clearTimeout(repeatTimer);
      clearInterval(repeatTimer);
      repeatTimer = null;
    };
    // pointerdown + preventDefault: act immediately and keep focus in the
    // terminal, so the phone keyboard doesn't close on every tap.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (key.modifier) {
        setModifier(key.modifier, !modifiers[key.modifier]);
        return;
      }
      sendInput(keySequence(key));
      if (key.repeat) {
        repeatTimer = setTimeout(() => {
          repeatTimer = setInterval(() => sendInput(keySequence(key)), KEY_REPEAT_INTERVAL_MS);
        }, KEY_REPEAT_DELAY_MS);
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, stopRepeat));
    bar.appendChild(btn);
  }
}

function setExtraKeysVisible(visible) {
  document.getElementById('terminalKeys').classList.toggle('hidden', !visible);
  document.getElementById('terminalKeysToggle').classList.toggle('active', visible);
  writePref('termKeysVisible', visible);
  refitTerminal();
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
function setTerminalStatus(text, kind) {
  const el = document.getElementById('terminalStatus');
  el.textContent = text;
  el.className = `terminal-status ${kind || ''}`;
}

function sendInput(data) {
  const s = terminalState;
  if (s && s.socket && s.socket.readyState === WebSocket.OPEN) {
    s.socket.send(JSON.stringify({ type: 'input', data }));
  }
}

function refitTerminal() {
  if (!terminalState) return;
  try { terminalState.fit.fit(); } catch (_) { /* not laid out yet */ }
}

// Keep the terminal inside the part of the screen the on-screen keyboard leaves
// visible. iOS (and Android without interactive-widget support) shrink only the
// visual viewport, so the bottom of a full-height terminal ends up behind the
// keyboard; size the overlay to the visual viewport instead.
function fitToVisualViewport() {
  const vv = window.visualViewport;
  if (!vv || terminalModal.classList.contains('hidden')) return;
  terminalModal.style.top = `${vv.offsetTop}px`;
  terminalModal.style.height = `${vv.height}px`;
  terminalModal.style.bottom = 'auto';
  refitTerminal();
}

function resetViewportFit() {
  terminalModal.style.top = '';
  terminalModal.style.height = '';
  terminalModal.style.bottom = '';
}

function setFontSize(size) {
  const s = terminalState;
  if (!s) return;
  const next = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
  s.term.options.fontSize = next;
  writePref(`termFont:${s.target.device.id}`, next === defaultFontSize() ? null : next);
  refitTerminal();
}

async function openTerminal(target) {
  closeTerminal();
  const { device, user, persist } = target;
  rememberRecent(device, user, persist);
  document.getElementById('terminalTitle').textContent =
    `${user ? `${user}@` : ''}${device.name}${persist ? ' (tmux)' : ''}`;
  setTerminalStatus('Connecting…', 'pending');
  terminalModal.classList.remove('hidden');
  fitToVisualViewport();

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
    fontSize: savedFontSize(device.id),
    scrollback: 5000,
    theme: { background: '#1e1e1e' }
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);

  // Phone keyboards otherwise capitalize the first letter and "correct" commands.
  if (term.textarea) {
    term.textarea.setAttribute('autocapitalize', 'off');
    term.textarea.setAttribute('autocorrect', 'off');
    term.textarea.setAttribute('autocomplete', 'off');
    term.textarea.setAttribute('spellcheck', 'false');
  }

  const state = { term, fit, target, socket: null, exited: false };
  terminalState = state;
  refitTerminal();
  // The monospace font may still be loading; measure again once it is.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitTerminal);
  term.focus();

  term.onData((data) => sendInput(applyModifiers(data)));
  term.onResize(({ rows, cols }) => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: 'resize', rows, cols }));
    }
  });
  // Tapping the terminal is how you bring the phone keyboard back.
  container.addEventListener('click', () => term.focus());

  connectTerminalSocket(state);
}

function connectTerminalSocket(state) {
  const { term, target } = state;
  state.exited = false;
  document.getElementById('terminalReconnect').classList.add('hidden');
  term.options.cursorBlink = true;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ device: target.device.id, rows: term.rows, cols: term.cols });
  if (target.user) params.set('user', target.user);
  if (target.persist) params.set('persist', '1');
  const protocols = ['terminal'];
  if (apiToken) protocols.push('bearer.' + base64url(apiToken));

  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/terminal?${params}`, protocols);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

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
      state.refused = true;
    } else if (msg.type === 'exit') {
      state.exited = true;
      setTerminalStatus(msg.code === 0 ? 'Session ended' : `Session ended (exit ${msg.code})`,
        msg.code === 0 ? '' : 'error');
    }
  };
  socket.onclose = (event) => {
    if (terminalState !== state || state.socket !== socket) return;
    term.options.cursorBlink = false;
    document.getElementById('terminalReconnect').classList.remove('hidden');
    if (!state.exited && !state.refused) {
      const reason = event.reason === 'Unauthorized' ? 'Not signed in (token rejected)' : 'Disconnected';
      setTerminalStatus(reason, 'error');
      if (event.reason !== 'Unauthorized') state.dropped = true;
    }
  };
}

function reconnectTerminal() {
  const state = terminalState;
  if (!state) return;
  state.dropped = false;
  state.refused = false;
  if (state.socket && state.socket.readyState === WebSocket.OPEN) return;
  // tmux redraws the whole screen on attach; a plain shell starts fresh.
  state.term.write('\r\n\x1b[90m--- reconnecting ---\x1b[0m\r\n');
  setTerminalStatus('Connecting…', 'pending');
  connectTerminalSocket(state);
  state.term.focus();
}

// Phones drop the socket when the browser is backgrounded. With "Keep session"
// the shell is still running in tmux, so reattach as soon as the page is back.
function onVisibilityChange() {
  const s = terminalState;
  if (document.visibilityState !== 'visible' || !s) return;
  if (s.target.persist && s.dropped) reconnectTerminal();
}

function closeTerminal() {
  const state = terminalState;
  terminalState = null;
  setModifier('ctrl', false);
  setModifier('alt', false);
  if (state) {
    if (state.socket) {
      try { state.socket.close(); } catch (_) { /* already closed */ }
    }
    state.term.dispose();
  }
  terminalModal.classList.add('hidden');
  resetViewportFit();
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
  // and a stray tap shouldn't end an SSH session.
  document.getElementById('terminalClose').addEventListener('click', closeTerminal);
  document.getElementById('terminalReconnect').addEventListener('click', reconnectTerminal);
  document.getElementById('terminalFontDown').addEventListener('click', () => {
    if (terminalState) setFontSize(terminalState.term.options.fontSize - 1);
  });
  document.getElementById('terminalFontUp').addEventListener('click', () => {
    if (terminalState) setFontSize(terminalState.term.options.fontSize + 1);
  });
  document.getElementById('terminalKeysToggle').addEventListener('click', () => {
    setExtraKeysVisible(document.getElementById('terminalKeys').classList.contains('hidden'));
  });

  renderExtraKeys();
  // Extra keys default to on for touch screens, off with a real keyboard.
  const keysVisible = readPref('termKeysVisible', isTouchDevice);
  document.getElementById('terminalKeys').classList.toggle('hidden', !keysVisible);
  document.getElementById('terminalKeysToggle').classList.toggle('active', keysVisible);

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitToVisualViewport);
    window.visualViewport.addEventListener('scroll', fitToVisualViewport);
  }
  window.addEventListener('resize', refitTerminal);
  document.addEventListener('visibilitychange', onVisibilityChange);
});
