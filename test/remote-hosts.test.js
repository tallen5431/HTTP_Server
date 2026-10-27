'use strict';

// Tailnet discovery and the browser SSH terminal. The unit tests cover the pure
// helpers; the end-to-end tests start the real manager with stub `tailscale` and
// `ssh` executables on PATH and drive /ws/terminal like the browser does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const remoteHosts = require('../remote-hosts');

const STATUS = {
  Self: {
    ID: 'nSelf', HostName: 'nucbox', DNSName: 'nucbox.tail1234.ts.net.',
    TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'], OS: 'linux', Online: false
  },
  Peer: {
    'nodekey:aaa': {
      ID: 'nPi', HostName: 'raspberrypi', DNSName: 'raspberrypi.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.2'], OS: 'linux', Online: true,
      sshHostKeys: ['ssh-ed25519 AAAA']
    },
    'nodekey:bbb': {
      ID: 'nPhone', HostName: 'phone', DNSName: 'phone.tail1234.ts.net.',
      TailscaleIPs: ['fd7a:115c:a1e0::3', '100.64.0.3'], OS: 'android', Online: false,
      LastSeen: '2026-10-20T10:00:00Z'
    },
    'nodekey:ccc': { ID: 'nBroken', HostName: 'no-ips' }
  }
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test('parseTailscaleDevices: lists self and peers, online first', () => {
  const devices = remoteHosts.parseTailscaleDevices(STATUS);
  assert.deepStrictEqual(devices.map(d => d.id), ['nSelf', 'nPi', 'nPhone']);

  const [self, pi, phone] = devices;
  assert.strictEqual(self.self, true);
  assert.strictEqual(self.online, true, 'this machine is always reachable');
  assert.strictEqual(self.address, '100.64.0.1', 'IPv4 preferred');
  assert.strictEqual(pi.dnsName, 'raspberrypi.tail1234.ts.net', 'trailing dot stripped');
  assert.strictEqual(pi.tailscaleSsh, true);
  assert.strictEqual(phone.tailscaleSsh, false);
  assert.strictEqual(phone.address, '100.64.0.3', 'IPv4 preferred even when listed second');
  assert.strictEqual(phone.lastSeen, '2026-10-20T10:00:00Z');
});

test('parseTailscaleDevices: tolerates empty or malformed status', () => {
  assert.deepStrictEqual(remoteHosts.parseTailscaleDevices(null), []);
  assert.deepStrictEqual(remoteHosts.parseTailscaleDevices({}), []);
  assert.deepStrictEqual(remoteHosts.parseTailscaleDevices({ Peer: { x: null } }), []);
});

test('terminalPolicy: never enabled without a token', () => {
  assert.strictEqual(remoteHosts.terminalPolicy({ apiToken: null }).enabled, false);
  assert.strictEqual(remoteHosts.terminalPolicy({ apiToken: null, setting: '1' }).enabled, false);
  assert.strictEqual(remoteHosts.terminalPolicy({ apiToken: 't' }).enabled, true);
  assert.strictEqual(remoteHosts.terminalPolicy({ apiToken: 't', setting: '0' }).enabled, false);
  assert.strictEqual(remoteHosts.terminalPolicy({ apiToken: 't', setting: 'off' }).enabled, false);
});

test('isValidSshUser: accepts login names, rejects options and injection', () => {
  for (const ok of ['pi', 'tjing2u1', 'svc_user', 'first.last', 'a-b']) {
    assert.ok(remoteHosts.isValidSshUser(ok), ok);
  }
  for (const bad of ['', '-oProxyCommand=sh', 'root@x', 'a b', 'a;b', '$(id)', 'x'.repeat(65), null]) {
    assert.ok(!remoteHosts.isValidSshUser(bad), String(bad));
  }
});

test('buildSshArgs: ends option parsing before the address', () => {
  const device = { address: '100.64.0.2' };
  const args = remoteHosts.buildSshArgs(device, 'pi');
  assert.deepStrictEqual(args.slice(-4), ['-l', 'pi', '--', '100.64.0.2']);
  assert.ok(!remoteHosts.buildSshArgs(device, '').includes('-l'));
});

// ---------------------------------------------------------------------------
// End to end: the real manager, stub tailscale + ssh
// ---------------------------------------------------------------------------
const TOKEN = 'test-token-123';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-ssh-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tailscale'),
    `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(STATUS)}\nEOF\n`, { mode: 0o755 });
  // Stands in for ssh: shows its arguments and terminal size, then echoes a line.
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    'echo "ARGS:$*"',
    'echo "SIZE:$(stty size)"',
    'read line',
    'echo "SIZE:$(stty size)"',
    'echo "GOT:$line"',
    'exit 3',
    ''
  ].join('\n'), { mode: 0o755 });
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ programs: [] }));

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PORT: String(port),
      MANAGER_HOST: '127.0.0.1',
      MANAGER_API_TOKEN: TOKEN,
      CONFIG_FILE: configFile,
      PROJECTS_DIR: path.join(dir, 'projects'),
      MANAGER_LOG_DIR: path.join(dir, 'logs')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`manager did not start:\n${out}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('Server listening')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`manager exited:\n${out}`)); });
  });
  return {
    port,
    stop: () => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

function bearer(token) {
  return 'bearer.' + Buffer.from(token).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Opens /ws/terminal and collects everything until the server closes it.
function openTerminal(port, query, { token = TOKEN, origin = `http://127.0.0.1:${port}`, onOpen } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?${new URLSearchParams(query)}`,
      ['terminal', bearer(token)], origin ? { origin } : {});
    const result = { output: '', control: [], closeCode: null };
    ws.on('open', () => onOpen && onOpen(ws, result));
    ws.on('message', (data, isBinary) => {
      if (isBinary) result.output += data.toString('utf8');
      else result.control.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('close', (code) => { result.closeCode = code; resolve(result); });
    ws.on('error', () => {});
  });
}

test('terminal: end to end over the WebSocket', async (t) => {
  const manager = await startManager();
  t.after(manager.stop);
  const { port } = manager;

  await t.test('device list comes from tailscale status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/remote-hosts`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const body = await res.json();
    assert.strictEqual(body.terminal.enabled, true);
    assert.strictEqual(body.error, null);
    assert.deepStrictEqual(body.devices.map(d => d.name), ['nucbox', 'raspberrypi', 'phone']);
  });

  await t.test('device list requires the token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/remote-hosts`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('runs ssh in a terminal, relays input, resizes, reports exit', async () => {
    const result = await openTerminal(port, { device: 'nPi', user: 'pi', rows: 24, cols: 80 }, {
      onOpen: (ws, r) => {
        const waitFor = (text, then) => {
          const timer = setInterval(() => {
            if (r.output.includes(text)) { clearInterval(timer); then(); }
          }, 20);
        };
        waitFor('SIZE:24 80', () => {
          ws.send(JSON.stringify({ type: 'resize', rows: 30, cols: 100 }));
          setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: 'hello\r' })), 200);
        });
      }
    });
    assert.match(result.output, /ARGS:.*-l pi -- 100\.64\.0\.2/);
    assert.match(result.output, /SIZE:30 100/);
    assert.match(result.output, /GOT:hello/);
    assert.deepStrictEqual(result.control.at(-1), { type: 'exit', code: 3 });
  });

  await t.test('rejects a device that is not on the tailnet', async () => {
    const result = await openTerminal(port, { device: '100.64.0.2' });
    assert.strictEqual(result.closeCode, 1008);
    assert.match(result.control[0].message, /not on this tailnet/);
    assert.strictEqual(result.output, '');
  });

  await t.test('rejects an invalid user name', async () => {
    const result = await openTerminal(port, { device: 'nPi', user: '-oProxyCommand=sh' });
    assert.strictEqual(result.closeCode, 1008);
    assert.match(result.control[0].message, /Invalid SSH user/);
  });

  await t.test('rejects a cross-origin page', async () => {
    const result = await openTerminal(port, { device: 'nPi' }, { origin: 'http://evil.example' });
    assert.strictEqual(result.closeCode, 1008);
    assert.match(result.control[0].message, /Cross-origin/);
  });

  await t.test('rejects a missing Origin header', async () => {
    const result = await openTerminal(port, { device: 'nPi' }, { origin: null });
    assert.strictEqual(result.closeCode, 1008);
  });

  await t.test('rejects a wrong token', async () => {
    const result = await openTerminal(port, { device: 'nPi' }, { token: 'wrong' });
    assert.strictEqual(result.closeCode, 1008);
    assert.strictEqual(result.output, '');
  });

  await t.test('serves only the whitelisted vendor files', async () => {
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/vendor/xterm.js`)).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/vendor/addon-fit.js`)).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/vendor/xterm.css`)).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/vendor/package.json`)).status, 404);
  });
});
