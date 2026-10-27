# Remote Host SSH Prototype Plan

> **Status:** tailnet device discovery and the browser SSH terminal (Phase 4) are
> implemented in `remote-hosts/` (see the README section "SSH Terminal for tailnet
> devices"). Hosts come from `tailscale status` instead of a hand-written registry,
> and the terminal uses the system `ssh` client so `~/.ssh/config`, keys and
> `known_hosts` apply. Phases 2, 3 and 5 (read-only status API and manager to
> manager operations) are not built yet.

## Goal

Allow HTTP Server Manager running on one Linux host (initially the NucBox) to connect to and manage another HTTP Server Manager host (initially the Raspberry Pi 4) over SSH through the existing Tailscale network.

The first prototype should prove remote connectivity and safe command execution without changing the existing local-host behavior.

## Initial topology

- NucBox G3 Plus: primary Server Manager / controller
- Raspberry Pi 4: remote Server Manager host
- Tailscale: private network transport between hosts
- OpenSSH: authentication and command transport

Use normal OpenSSH over Tailscale. Do not expose port 22 to the public Internet.

## Phase 1: Remote host model

Add a small remote-host module rather than embedding SSH logic throughout `server.js`.

Suggested structure:

```
remote-hosts/
  index.js          # host registry / configuration
  ssh-client.js     # connection and command execution
```

A host definition should contain only non-secret connection metadata, for example:

```json
{
  "id": "raspberrypi",
  "name": "Raspberry Pi 4",
  "host": "raspberrypi",
  "port": 22,
  "username": "tjing2u1",
  "identityFile": "~/.ssh/server_manager"
}
```

Private keys must never be stored in the repository or sent to the browser.

## Phase 2: Connectivity API

Add narrowly scoped endpoints first:

- `GET /api/remote-hosts` — configured hosts and connection state
- `POST /api/remote-hosts/:id/test` — test SSH connectivity
- `GET /api/remote-hosts/:id/status` — fetch basic system information

Initial status commands can gather:

- hostname
- uptime
- memory usage
- disk usage
- Server Manager service state
- Tailscale status/version where available

Avoid a browser-supplied arbitrary command endpoint in the first implementation. Server-side command definitions reduce command-injection risk while the feature is being proven.

## Phase 3: UI prototype

Add a Remote Hosts section/card to Server Manager showing:

- host name
- online/offline state
- hostname/IP used for SSH
- uptime
- memory/disk summary
- Server Manager service state
- Test Connection / Refresh actions

Existing local server controls should remain unchanged.

## Phase 4: Interactive terminal

After host discovery/status is stable, add an interactive terminal using an SSH PTY bridged to the browser over the existing WebSocket infrastructure.

Requirements before enabling it:

- authenticated/authorized Server Manager session
- server-side host allowlist
- SSH host-key verification
- SSH key authentication
- no private-key material sent to browser
- connection/session cleanup on WebSocket disconnect

## Phase 5: Server Manager to Server Manager integration

Once SSH transport is reliable, expose common host operations through one abstraction so callers do not need to know whether a host is local or remote, e.g.:

```js
await host.getStatus();
await host.getServices();
await host.restartService('http-server-manager');
```

This can later support the Jetson and additional Linux hosts.

## Authentication/setup

Create a dedicated key on the controller host:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/server_manager
ssh-copy-id -i ~/.ssh/server_manager.pub tjing2u1@raspberrypi
```

Verify manually before testing through Server Manager:

```bash
ssh -i ~/.ssh/server_manager tjing2u1@raspberrypi hostname
```

If MagicDNS is unavailable, use the Pi's Tailscale `100.x.x.x` address in local configuration instead.

## Prototype implementation order

1. Add remote-host configuration loading and validation.
2. Add an SSH client wrapper with timeouts and host-key verification.
3. Add unit tests for configuration and command construction/error handling.
4. Add connection-test and read-only status API routes.
5. Add a minimal Remote Hosts UI.
6. Test NucBox -> Raspberry Pi over Tailscale.
7. Add PTY/WebSocket terminal only after the read-only path is reliable.

## Success criteria

The prototype is successful when the NucBox Server Manager can:

1. display the Raspberry Pi 4 as a configured remote host;
2. test SSH connectivity without a password prompt;
3. display basic Pi status through SSH;
4. fail cleanly when the Pi is offline or SSH authentication fails;
5. continue managing local projects exactly as before.
