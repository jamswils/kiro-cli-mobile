/**
 * PTY service — spawns the Kiro CLI inside a pseudo-terminal and multiplexes
 * its raw byte stream to any number of connected WebSocket clients.
 *
 * Design:
 *  - One shared PTY per server. First client triggers spawn; when all clients
 *    disconnect the PTY keeps running (so refreshing the phone tab doesn't kill
 *    an active Kiro session). Explicit /api/reset is the only way to kill it.
 *  - A bounded scrollback buffer (last N bytes) is replayed to new clients on
 *    connect so a late joiner sees the current screen state rather than a
 *    blank terminal.
 *  - Column/row is driven by the *smallest* connected client so the CLI never
 *    renders wider than a viewer can see.
 */
import { spawn as ptySpawn } from 'node-pty';

// Bounded replay buffer. 256 KiB holds plenty of terminal history for a fresh
// join without letting a long-running session grow memory unbounded.
const SCROLLBACK_BYTES = 256 * 1024;

export class PtySession {
  /**
   * @param {object} opts
   * @param {string} opts.command - Executable to spawn (e.g. 'kiro' on *nix, 'kiro.cmd' on Windows).
   * @param {string[]} opts.args - Argv for the CLI.
   * @param {string} [opts.cwd] - Working directory for the child.
   * @param {Record<string,string>} [opts.env] - Env overrides merged onto process.env.
   */
  constructor({ command, args, cwd, env }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = { ...process.env, ...(env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };

    /** @type {import('node-pty').IPty | null} */
    this.pty = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    /** @type {Map<import('ws').WebSocket, {cols:number, rows:number}>} */
    this.clientSizes = new Map();

    /** @type {Buffer} */
    this._scrollback = Buffer.alloc(0);

    this.cols = 120;
    this.rows = 30;
  }

  isAlive() {
    return this.pty !== null;
  }

  spawn() {
    if (this.pty) return;

    try {
      this.pty = ptySpawn(this.command, this.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: this.env
      });
    } catch (err) {
      this.pty = null;
      this._broadcast({ type: 'error', message: `Failed to spawn '${this.command}': ${err.message}` });
      throw err;
    }

    this.pty.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      this._appendScrollback(buf);
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(buf, { binary: true });
        }
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      const notice = `\r\n\x1b[33m[kiro-cli exited: code=${exitCode} signal=${signal ?? 'none'}]\x1b[0m\r\n`;
      this._broadcast({ type: 'exit', exitCode, signal, notice });
      this._appendScrollback(Buffer.from(notice));
      this.pty = null;
    });
  }

  kill() {
    if (!this.pty) return;
    try {
      this.pty.kill();
    } catch {
      // best-effort; node-pty may throw on already-exited processes
    }
    this.pty = null;
    this._scrollback = Buffer.alloc(0);
  }

  addClient(ws, size) {
    this.clients.add(ws);
    if (size && Number.isInteger(size.cols) && Number.isInteger(size.rows)) {
      this.clientSizes.set(ws, { cols: Math.max(20, size.cols), rows: Math.max(5, size.rows) });
    }
    this._recomputeSize();

    if (this._scrollback.length > 0 && ws.readyState === ws.OPEN) {
      ws.send(this._scrollback, { binary: true });
    }
  }

  removeClient(ws) {
    this.clients.delete(ws);
    this.clientSizes.delete(ws);
    this._recomputeSize();
  }

  write(data) {
    if (!this.pty) return;
    this.pty.write(typeof data === 'string' ? data : data.toString('utf8'));
  }

  resizeFromClient(ws, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    this.clientSizes.set(ws, { cols: Math.max(20, cols), rows: Math.max(5, rows) });
    this._recomputeSize();
  }

  _recomputeSize() {
    if (this.clientSizes.size === 0) return;
    let minCols = Infinity, minRows = Infinity;
    for (const s of this.clientSizes.values()) {
      if (s.cols < minCols) minCols = s.cols;
      if (s.rows < minRows) minRows = s.rows;
    }
    if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) return;
    if (minCols === this.cols && minRows === this.rows) return;
    this.cols = minCols;
    this.rows = minRows;
    if (this.pty) {
      try { this.pty.resize(this.cols, this.rows); } catch { /* transient */ }
    }
  }

  _appendScrollback(buf) {
    const combined = Buffer.concat([this._scrollback, buf]);
    this._scrollback = combined.length > SCROLLBACK_BYTES
      ? combined.subarray(combined.length - SCROLLBACK_BYTES)
      : combined;
  }

  _broadcast(msg) {
    const payload = Buffer.from(JSON.stringify(msg));
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload, { binary: false });
      }
    }
  }
}
