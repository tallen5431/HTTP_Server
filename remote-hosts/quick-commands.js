'use strict';

// Saved commands per tailnet device ("quick commands"), run in the browser
// terminal with one tap, e.g. an RCON console on a game server.
//
// Stored on the manager (not in the browser) so every phone and PC you sign in
// from sees the same list. The file can hold secrets, since commands often
// carry passwords on the command line (mcrcon -p ...), so it is written
// owner-only and lives outside git (see .gitignore).
//
// The terminal socket only ever names a saved command by ID; the command text
// comes from this file. Editing the list needs the same token as opening a
// shell, so this adds no access a signed-in user doesn't already have.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_COMMANDS_PER_DEVICE = 20;
const MAX_LABEL_LENGTH = 40;
const MAX_COMMAND_LENGTH = 1000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9:._-]{1,128}$/;
const COMMAND_ID_PATTERN = /^[a-f0-9]{8,32}$/;

function isValidDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID_PATTERN.test(id);
}

// Normalize a device's list as sent by the browser. Throws with a message fit
// for the UI. Existing IDs are kept so open terminals and "recent" entries keep
// pointing at the same command; new entries get a fresh one.
function normalizeCommandList(list) {
  if (!Array.isArray(list)) throw new Error('commands must be a list.');
  if (list.length > MAX_COMMANDS_PER_DEVICE) {
    throw new Error(`At most ${MAX_COMMANDS_PER_DEVICE} quick commands per device.`);
  }
  const seen = new Set();
  return list.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`Command ${i + 1} is not valid.`);
    const label = String(item.label || '').trim();
    const command = String(item.command || '').trim();
    if (!label) throw new Error(`Command ${i + 1} needs a name.`);
    if (label.length > MAX_LABEL_LENGTH) {
      throw new Error(`"${label.slice(0, 20)}…" is too long a name (max ${MAX_LABEL_LENGTH}).`);
    }
    if (!command) throw new Error(`"${label}" has no command.`);
    if (command.length > MAX_COMMAND_LENGTH) {
      throw new Error(`"${label}" is too long (max ${MAX_COMMAND_LENGTH} characters).`);
    }
    if (/[\r\n\0]/.test(command)) throw new Error(`"${label}" must be a single line.`);
    let id = typeof item.id === 'string' && COMMAND_ID_PATTERN.test(item.id) ? item.id : null;
    if (!id || seen.has(id)) id = crypto.randomBytes(6).toString('hex');
    seen.add(id);
    return { id, label, command };
  });
}

// { deviceId: [{ id, label, command }] }. A missing or unreadable file is an
// empty store rather than an error, so a hand-edit typo can't break the UI.
function loadQuickCommands(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
  const store = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  for (const [deviceId, list] of Object.entries(raw)) {
    if (!isValidDeviceId(deviceId)) continue;
    try {
      const commands = normalizeCommandList(list);
      if (commands.length) store[deviceId] = commands;
    } catch (_) { /* skip a device whose entry was hand-broken */ }
  }
  return store;
}

// Write via a temp file and rename so a crash mid-write never leaves half a
// file, with owner-only permissions because commands can contain passwords.
function saveQuickCommands(file, store) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function setDeviceCommands(file, deviceId, list) {
  if (!isValidDeviceId(deviceId)) throw new Error('Invalid device.');
  const commands = normalizeCommandList(list);
  const store = loadQuickCommands(file);
  if (commands.length) store[deviceId] = commands;
  else delete store[deviceId];
  saveQuickCommands(file, store);
  return commands;
}

function findQuickCommand(file, deviceId, commandId) {
  const list = loadQuickCommands(file)[deviceId] || [];
  return list.find(c => c.id === commandId) || null;
}

module.exports = {
  loadQuickCommands,
  setDeviceCommands,
  findQuickCommand,
  normalizeCommandList,
  isValidDeviceId,
  MAX_COMMANDS_PER_DEVICE
};
