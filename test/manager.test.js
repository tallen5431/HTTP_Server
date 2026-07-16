'use strict';

// Tests for the security- and correctness-critical pure functions. Run with
// `npm test` (uses the built-in node:test runner — no dependencies).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../server.js');
const discover = require('../discover-projects.js');

// ---------------------------------------------------------------------------
// parseListeningPortFromLog — must find the real bind port without latching onto
// an unrelated dependency address printed in the logs.
// ---------------------------------------------------------------------------
test('parseListeningPortFromLog: detects bind-all and startup lines', () => {
  assert.strictEqual(server.parseListeningPortFromLog('Serving on 0.0.0.0:8080'), '8080');
  assert.strictEqual(server.parseListeningPortFromLog('Running on http://127.0.0.1:5000'), '5000');
  assert.strictEqual(server.parseListeningPortFromLog('Uvicorn running on http://0.0.0.0:8000'), '8000');
  assert.strictEqual(server.parseListeningPortFromLog('Listening on port 8059'), '8059');
});

test('parseListeningPortFromLog: ignores dependency addresses on non-startup lines', () => {
  // The confirmed bug: a redis/db line before the real bind line must NOT win.
  assert.strictEqual(server.parseListeningPortFromLog('Connected to redis at 127.0.0.1:6379'), null);
  assert.strictEqual(server.parseListeningPortFromLog('db at 127.0.0.1:5432'), null);
  assert.strictEqual(server.parseListeningPortFromLog('just some text'), null);
});

// ---------------------------------------------------------------------------
// isInsideProjectsDir — the path-confinement guard for browse/add/update.
// ---------------------------------------------------------------------------
test('isInsideProjectsDir: confines to the projects folder', () => {
  const root = path.resolve(__dirname, '..', 'projects');
  assert.strictEqual(server.isInsideProjectsDir(path.join(root, 'app')), true);
  assert.strictEqual(server.isInsideProjectsDir(root), true);
  assert.strictEqual(server.isInsideProjectsDir('/etc'), false);
  assert.strictEqual(server.isInsideProjectsDir('/home'), false);
  // A traversal attempt must not escape.
  assert.strictEqual(server.isInsideProjectsDir(path.join(root, '..', '..', 'etc')), false);
});

// ---------------------------------------------------------------------------
// decodeBearerSubprotocol — WebSocket auth token transport.
// ---------------------------------------------------------------------------
test('decodeBearerSubprotocol: round-trips a token', () => {
  const token = 'S3cr3t-Token_with.chars';
  const enc = Buffer.from(token).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(server.decodeBearerSubprotocol(`manager, bearer.${enc}`), token);
  assert.strictEqual(server.decodeBearerSubprotocol('manager'), null);
  assert.strictEqual(server.decodeBearerSubprotocol(''), null);
});

// ---------------------------------------------------------------------------
// validateGitUrl / deriveRepoFolderName — import safety.
// ---------------------------------------------------------------------------
test('validateGitUrl: accepts supported schemes, rejects junk and options', () => {
  assert.strictEqual(server.validateGitUrl('https://github.com/user/repo.git'), null);
  assert.strictEqual(server.validateGitUrl('git@github.com:user/repo.git'), null);
  assert.strictEqual(server.validateGitUrl('ssh://git@host/user/repo'), null);
  assert.notStrictEqual(server.validateGitUrl('--upload-pack=evil'), null);
  assert.notStrictEqual(server.validateGitUrl('file:///etc/passwd'), null);
  assert.notStrictEqual(server.validateGitUrl(''), null);
});

test('deriveRepoFolderName: derives a safe folder name', () => {
  assert.strictEqual(server.deriveRepoFolderName('https://github.com/user/My-Repo.git'), 'my-repo');
  assert.strictEqual(server.deriveRepoFolderName('git@host:user/thing', ''), 'thing');
  // Override is sanitized too.
  assert.strictEqual(server.deriveRepoFolderName('https://x/y', '../../evil'), 'evil');
});

// ---------------------------------------------------------------------------
// rankLanInterface — wired should beat wifi should beat virtual.
// ---------------------------------------------------------------------------
test('rankLanInterface: prefers wired over wifi over virtual', () => {
  assert.ok(server.rankLanInterface('eth0') > server.rankLanInterface('wlan0'));
  assert.ok(server.rankLanInterface('wlan0') > server.rankLanInterface('docker0'));
  assert.ok(server.rankLanInterface('en0') > server.rankLanInterface('veth123'));
});

// ---------------------------------------------------------------------------
// parseStartScript — must parse the ${PORT:-8080} default form the manager's own
// scaffolded scripts use, ignore comments, and accept hostnames.
// ---------------------------------------------------------------------------
function withTempScript(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startsh-'));
  const file = path.join(dir, 'Start.sh');
  fs.writeFileSync(file, body);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('parseStartScript: extracts the fallback port from ${PORT:-8080}', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\nexport HOST="${HOST:-0.0.0.0}"\nexport PORT="${PORT:-8080}"\nnpm start\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, '8080');
});

test('parseStartScript: ignores commented-out ports', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\n# export PORT=9999\nexport PORT=8100\npython app.py\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, '8100');
});

test('parseStartScript: extracts a literal port and numeric host', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\nexport HOST=0.0.0.0\nexport PORT=8200\npython app.py\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, '8200');
  assert.strictEqual(env.HOST, '0.0.0.0');
});

test('parseStartScript: reads ${VAR:=default} and never captures the next token', () => {
  // Regression: the `: "${HOST:=0.0.0.0}"` idiom followed by a bare
  // `export PORT HOST` and an `echo` line used to yield HOST="echo" because the
  // old `HOST[=\s]+` class matched across the newline into the echo statement.
  const env = withTempScript(
    '#!/usr/bin/env bash\nset -euo pipefail\n' +
    ': "${PORT:=8059}"\n: "${HOST:=0.0.0.0}"\n\nexport PORT HOST\n\n' +
    'echo "[RUN] http://$HOST:$PORT"\nexec python app.py\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, '8059');
  assert.strictEqual(env.HOST, '0.0.0.0');
});

test('parseStartScript: bare `export PORT HOST` records no stray value', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\nexport PORT HOST\ngunicorn wsgi:app\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, undefined);
  assert.strictEqual(env.HOST, undefined);
});

test('parseStartScript: extracts host and port from CLI flags', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\ngunicorn --host 127.0.0.1 --port 5001 app:app\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.PORT, '5001');
  assert.strictEqual(env.HOST, '127.0.0.1');
});

// ---------------------------------------------------------------------------
// discoverProjects — must throw (not process.exit) on a missing directory so a
// require-ing daemon can handle it.
// ---------------------------------------------------------------------------
test('discoverProjects: throws instead of exiting on a missing directory', () => {
  assert.throws(() => discover.discoverProjects('/no/such/dir/really'), /not found/i);
});
