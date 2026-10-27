#!/usr/bin/env python3
"""Run a command inside a pseudo-terminal and relay it over plain pipes.

Node has no built-in PTY, and the usual add-on (node-pty) needs a C++ toolchain
to install, which would break the "download and run start-manager.sh" install.
Python's standard library does have one, so the manager spawns this helper:

  stdin  (fd 0) -> bytes typed in the browser, written to the terminal
  stdout (fd 1) <- everything the terminal prints
  fd 3          -> resize requests, one "ROWS COLS\\n" line each

Usage: pty-bridge.py ROWS COLS -- COMMAND [ARGS...]

Exits with the command's exit code. Closing stdin, SIGTERM or SIGHUP hang up
the terminal (SIGHUP to the command's session), as closing a terminal window
would.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3


def set_winsize(fd, rows, cols):
    rows = max(1, min(int(rows), 1000))
    cols = max(1, min(int(cols), 1000))
    # Setting the size on the master also delivers SIGWINCH to the foreground job.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                select.select([], [fd], [], 1)
                continue
            raise
        data = data[n:]


def main(argv):
    if len(argv) < 4 or argv[2] != '--':
        sys.stderr.write('usage: pty-bridge.py ROWS COLS -- COMMAND [ARGS...]\n')
        return 2
    rows, cols, command = argv[0], argv[1], argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        try:
            os.execvp(command[0], command)
        except OSError as e:
            sys.stderr.write('pty-bridge: cannot run %s: %s\r\n' % (command[0], e.strerror))
        os._exit(127)

    def hang_up(*_):
        try:
            os.killpg(pid, signal.SIGHUP)  # pty.fork made the child a session leader
        except OSError:
            pass

    signal.signal(signal.SIGTERM, lambda *a: (hang_up(), os._exit(143)))
    signal.signal(signal.SIGHUP, lambda *a: (hang_up(), os._exit(129)))

    try:
        set_winsize(master, rows, cols)
    except (ValueError, OSError):
        pass

    try:
        os.fstat(CONTROL_FD)
        control = CONTROL_FD
    except OSError:
        control = None

    readers = [master, 0] + ([control] if control is not None else [])
    control_buf = b''

    while True:
        try:
            ready, _, _ = select.select(readers, [], [])
        except InterruptedError:
            continue

        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno != errno.EIO:  # EIO = the command closed the terminal
                    raise
                data = b''
            if not data:
                break
            write_all(1, data)

        if 0 in ready:
            data = os.read(0, 65536)
            if not data:  # the manager went away: hang up like a closed window
                hang_up()
                readers.remove(0)
            else:
                write_all(master, data)

        if control is not None and control in ready:
            data = os.read(control, 4096)
            if not data:
                readers.remove(control)
                control = None
            else:
                control_buf += data
                while b'\n' in control_buf:
                    line, control_buf = control_buf.split(b'\n', 1)
                    parts = line.split()
                    if len(parts) == 2:
                        try:
                            set_winsize(master, parts[0], parts[1])
                        except (ValueError, OSError):
                            pass

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 128 + os.WTERMSIG(status)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
