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

test('parseStartScript: unquoted env value stops at operators/comments', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\nexport DEBUG=1 && npm start\nexport NODE_ENV=production   # note\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.DEBUG, '1');            // not "1 && npm start"
  assert.strictEqual(env.NODE_ENV, 'production'); // not "production   # note"
});

test('parseStartScript: drops values holding an unresolved variable reference', () => {
  const env = withTempScript(
    '#!/usr/bin/env bash\nexport URL=http://localhost:$PORT/api\n',
    (f) => discover.parseStartScript(f).env
  );
  assert.strictEqual(env.URL, undefined);
});

test('parseStartScript: rejects out-of-range ports and normalizes leading zeros', () => {
  assert.strictEqual(
    withTempScript('#!/usr/bin/env bash\nexport PORT=99999\n', (f) => discover.parseStartScript(f).env).PORT,
    undefined
  );
  assert.strictEqual(
    withTempScript('#!/usr/bin/env bash\nexport PORT=08080\n', (f) => discover.parseStartScript(f).env).PORT,
    '8080'
  );
});

test('discoverProjects: gives colliding/empty directory names unique non-empty ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try {
    for (const name of ['Web App', 'web-app', '日本語']) {
      const p = path.join(dir, name);
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'Start.sh'), '#!/usr/bin/env bash\npython app.py\n');
    }
    const ids = discover.discoverProjects(dir).map(p => p.id);
    assert.strictEqual(ids.length, 3);
    assert.strictEqual(new Set(ids).size, 3, 'ids must be unique');
    assert.ok(ids.every(id => id && id.length > 0), 'ids must be non-empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hostIsAllowed — DNS-rebinding defense. Loopback, IP literals, and *.ts.net are
// allowed; an arbitrary attacker domain (the rebinding vector) is rejected.
// ---------------------------------------------------------------------------
test('hostIsAllowed: accepts loopback/IP/Tailscale, rejects unknown domains', () => {
  const mk = (host) => ({ headers: { host } });
  assert.strictEqual(server.hostIsAllowed(mk('localhost:3000')), true);
  assert.strictEqual(server.hostIsAllowed(mk('127.0.0.1:3000')), true);
  assert.strictEqual(server.hostIsAllowed(mk('192.168.1.199:3000')), true);
  assert.strictEqual(server.hostIsAllowed(mk('100.92.90.118:3000')), true);
  assert.strictEqual(server.hostIsAllowed(mk('[::1]:3000')), true);
  assert.strictEqual(server.hostIsAllowed(mk('tj-nuc.tail8ce2ce.ts.net:3000')), true);
  // The DNS-rebinding vector: an attacker domain rebound to our IP.
  assert.strictEqual(server.hostIsAllowed(mk('evil.example.com')), false);
  assert.strictEqual(server.hostIsAllowed(mk('')), false);
});

// ---------------------------------------------------------------------------
// discoverProjects — must throw (not process.exit) on a missing directory so a
// require-ing daemon can handle it.
// ---------------------------------------------------------------------------
test('discoverProjects: throws instead of exiting on a missing directory', () => {
  assert.throws(() => discover.discoverProjects('/no/such/dir/really'), /not found/i);
});

// ---------------------------------------------------------------------------
// isValidGitBranch — reject dangerous/option-like refs up front (clean 400, not a
// downstream git 500).
// ---------------------------------------------------------------------------
test('isValidGitBranch: accepts valid refs, rejects dangerous ones', () => {
  for (const ok of ['main', 'develop', 'feature/new-x', 'release-1.2.3', 'v2.0']) {
    assert.strictEqual(server.isValidGitBranch(ok), true, `should accept ${ok}`);
  }
  for (const bad of ['-foo', '..', 'a..b', '/main', 'main/', 'x.lock', 'a b', 'foo//bar', '', 'a~b', 'x^y', 'a:b', '.hidden']) {
    assert.strictEqual(server.isValidGitBranch(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// sanitizeGitOutput — never echo credentials embedded in a repo URL back to the
// client or logs.
// ---------------------------------------------------------------------------
test('sanitizeGitOutput: scrubs credentials embedded in URLs', () => {
  const s = server.sanitizeGitOutput("fatal: unable to access 'https://user:ghp_secret@github.com/o/r.git/'");
  assert.match(s, /https:\/\/\*\*\*@github\.com/);
  assert.doesNotMatch(s, /ghp_secret/);
});

// ---------------------------------------------------------------------------
// normalizeRepoUrlForCompare — used to detect a re-import that would update an
// unrelated repo sharing the same folder name.
// ---------------------------------------------------------------------------
test('normalizeRepoUrlForCompare: matches variants of the same repo, distinguishes different ones', () => {
  const b = server.normalizeRepoUrlForCompare('https://github.com/user/repo/');
  assert.strictEqual(server.normalizeRepoUrlForCompare('https://github.com/User/Repo.git'), b);
  assert.strictEqual(server.normalizeRepoUrlForCompare('https://x:y@github.com/user/repo'), b);
  assert.notStrictEqual(
    server.normalizeRepoUrlForCompare('https://github.com/alice/app'),
    server.normalizeRepoUrlForCompare('https://github.com/bob/app')
  );
});

// ---------------------------------------------------------------------------
// mergeExistingProgramOverrides — a rediscover/import must not wipe user-set
// autostart, custom name, or UI-added env vars.
// ---------------------------------------------------------------------------
test('mergeExistingProgramOverrides: preserves autostart/name/url and merges env', () => {
  const discovered = { id: 'x', name: 'X', path: '/p', env: { PORT: '9000' } };
  const existing = {
    id: 'x', name: 'My Custom X', path: '/p',
    env: { PORT: '8000', API_KEY: 'k' }, autostart: true, url: 'http://h'
  };
  server.mergeExistingProgramOverrides(discovered, existing);
  assert.strictEqual(discovered.autostart, true, 'autostart preserved');
  assert.strictEqual(discovered.name, 'My Custom X', 'user rename preserved');
  assert.strictEqual(discovered.url, 'http://h', 'url override preserved');
  assert.strictEqual(discovered.env.PORT, '9000', 'discovered PORT wins (updated Start.sh)');
  assert.strictEqual(discovered.env.API_KEY, 'k', 'user-only env var preserved');
});

// ---------------------------------------------------------------------------
// scaffoldStartScript — must generate a launcher that actually works and never one
// that is guaranteed to crash.
// ---------------------------------------------------------------------------
function withTempProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(dir, name);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('scaffoldStartScript: prefers the Python backend over an incidental package.json', () => {
  withTempProject({
    'package.json': JSON.stringify({ name: 'frontend', scripts: { start: 'vite' } }),
    'requirements.txt': 'flask\n',
    'app.py': 'from flask import Flask\napp = Flask(__name__)\n'
  }, (dir) => {
    const r = server.scaffoldStartScript(dir);
    assert.strictEqual(r.kind, 'python');
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /flask --app "app:app" run/);
    assert.doesNotMatch(body, /npm start/);
  });
});

test('scaffoldStartScript: Python requirements with no entry file → placeholder, not a nonexistent app.py', () => {
  withTempProject({ 'requirements.txt': 'requests\n' }, (dir) => {
    const r = server.scaffoldStartScript(dir);
    assert.strictEqual(r.kind, 'placeholder');
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.doesNotMatch(body, /app\.py/);
  });
});

test('scaffoldStartScript: Node without a start script uses `node <entry>`, not `npm start`', () => {
  withTempProject({
    'package.json': JSON.stringify({ name: 'svc', scripts: { dev: 'x' } }),
    'server.js': 'console.log(1)\n'
  }, (dir) => {
    const r = server.scaffoldStartScript(dir);
    assert.strictEqual(r.kind, 'node');
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /exec node "server\.js"/);
    assert.doesNotMatch(body, /npm start/);
  });
});

test('scaffoldStartScript: streamlit app is launched via `streamlit run`', () => {
  withTempProject({ 'requirements.txt': 'streamlit\n', 'app.py': 'import streamlit as st\n' }, (dir) => {
    server.scaffoldStartScript(dir);
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /streamlit run "app\.py"/);
  });
});

test('scaffoldStartScript: a self-serving python script is run directly', () => {
  withTempProject({
    'requirements.txt': 'flask\n',
    'app.py': 'if __name__ == "__main__":\n    app.run(host="0.0.0.0")\n'
  }, (dir) => {
    server.scaffoldStartScript(dir);
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /exec "\$VENV_PY" "app\.py"/);
  });
});

test('scaffoldStartScript: Node install is gated on manifest freshness (picks up updated deps)', () => {
  withTempProject({ 'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }), 's.js': '1' }, (dir) => {
    server.scaffoldStartScript(dir);
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /package\.json -nt node_modules/);
    assert.doesNotMatch(body, /\[ -d node_modules \] \|\| npm install/); // the old stale-forever form
  });
});

test('scaffoldStartScript: Python reinstalls only when requirements.txt changed (stamp-gated)', () => {
  withTempProject({ 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\napp=Flask(__name__)\n' }, (dir) => {
    server.scaffoldStartScript(dir);
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /REQ_STAMP=/);
    assert.match(body, /requirements\.txt -nt "\$REQ_STAMP"/);
  });
});

test('scaffoldStartScript: Flask launcher targets the detected app-instance variable', () => {
  withTempProject({ 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\nsrv = Flask(__name__)\n' }, (dir) => {
    server.scaffoldStartScript(dir);
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /--app "app:srv" run/);
  });
});

test('scaffoldStartScript: gunicorn/WSGI callable is detected as `application`', () => {
  withTempProject({ 'requirements.txt': 'gunicorn\n', 'wsgi.py': 'application = make_app()\n' }, (dir) => {
    const r = server.scaffoldStartScript(dir);
    assert.strictEqual(r.kind, 'python');
    const body = fs.readFileSync(path.join(dir, 'Start.sh'), 'utf8');
    assert.match(body, /gunicorn "wsgi:application"/);
  });
});

// ---------------------------------------------------------------------------
// cloneOrUpdateRepo — the update path must survive the cases a plain
// `pull --ff-only` aborted on (untracked-file collision + force-push), and must
// refuse to update an unrelated repo that shares the folder name.
// ---------------------------------------------------------------------------
const { execSync } = require('child_process');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
};
const git = (cmd, cwd) => execSync(cmd, { cwd, env: GIT_ENV, stdio: 'pipe' });

test('cloneOrUpdateRepo: update survives untracked-file collision and force-push', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfix-'));
  try {
    const remote = path.join(base, 'remote');
    fs.mkdirSync(remote);
    git('git init -q -b main', remote);
    fs.writeFileSync(path.join(remote, 'app.py'), 'v1\n');
    git('git add -A && git commit -qm c1', remote);

    const dest = path.join(base, 'clone');
    const r1 = await server.cloneOrUpdateRepo('file://' + remote, dest, '');
    assert.strictEqual(r1.updated, false);

    // Manager scaffolds an untracked Start.sh; remote then force-pushes (amend) AND
    // adds a tracked Start.sh that collides — exactly what pull --ff-only aborts on.
    fs.writeFileSync(path.join(dest, 'Start.sh'), 'scaffolded\n');
    git('git commit -q --amend -m amended --no-edit', remote);
    fs.writeFileSync(path.join(remote, 'app.py'), 'v2\n');
    fs.writeFileSync(path.join(remote, 'Start.sh'), 'real\n');
    git('git add -A && git commit -qm c2', remote);

    const r2 = await server.cloneOrUpdateRepo('file://' + remote, dest, '');
    assert.strictEqual(r2.updated, true);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'app.py'), 'utf8'), 'v2\n');
    assert.strictEqual(fs.readFileSync(path.join(dest, 'Start.sh'), 'utf8'), 'real\n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cloneOrUpdateRepo: an explicit branch switch persists across a later no-branch update', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbr-'));
  try {
    const remote = path.join(base, 'remote');
    fs.mkdirSync(remote);
    git('git init -q -b main', remote);
    fs.writeFileSync(path.join(remote, 'f'), 'main-1\n');
    git('git add -A && git commit -qm m1', remote);
    git('git checkout -q -b dev', remote);
    fs.writeFileSync(path.join(remote, 'f'), 'dev-1\n');
    git('git commit -qam d1', remote);
    git('git checkout -q main', remote);

    const dest = path.join(base, 'clone');
    await server.cloneOrUpdateRepo('file://' + remote, dest, '');     // clones default (main)
    assert.strictEqual(fs.readFileSync(path.join(dest, 'f'), 'utf8'), 'main-1\n');

    await server.cloneOrUpdateRepo('file://' + remote, dest, 'dev');  // switch to dev
    assert.strictEqual(fs.readFileSync(path.join(dest, 'f'), 'utf8'), 'dev-1\n');
    assert.strictEqual(git('git rev-parse --abbrev-ref HEAD', dest).toString().trim(), 'dev');

    // Advance dev upstream, then update with NO branch: must stay on dev, not revert to main.
    git('git checkout -q dev', remote);
    fs.writeFileSync(path.join(remote, 'f'), 'dev-2\n');
    git('git commit -qam d2', remote);
    git('git checkout -q main', remote);
    await server.cloneOrUpdateRepo('file://' + remote, dest, '');
    assert.strictEqual(fs.readFileSync(path.join(dest, 'f'), 'utf8'), 'dev-2\n');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cloneOrUpdateRepo: refuses to update when the existing origin does not match the URL', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitfix2-'));
  try {
    const remoteA = path.join(base, 'a');
    fs.mkdirSync(remoteA);
    git('git init -q -b main', remoteA);
    fs.writeFileSync(path.join(remoteA, 'f'), 'a\n');
    git('git add -A && git commit -qm c1', remoteA);

    const dest = path.join(base, 'clone');
    await server.cloneOrUpdateRepo('file://' + remoteA, dest, '');
    await assert.rejects(
      server.cloneOrUpdateRepo('file:///some/other/repo.git', dest, ''),
      /different repository/i
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
