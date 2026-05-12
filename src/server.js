#!/usr/bin/env node
/**
 * Kiro CLI Mobile Bridge
 *
 * Spawns `kiro` (or a configurable command) inside a PTY and proxies the
 * terminal stream to any phone browser on the LAN. Mirrors the OTP auth
 * pattern from the sibling kiro-mobile-bridge project so the two can run
 * side-by-side on the same machine.
 *
 * Default port: 3001  (IDE bridge uses 3000, so both coexist on one host).
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  generateOTP,
  getOTP,
  setAuthEnabled,
  isAuthEnabled,
  authMiddleware,
  validateWSAuth,
  verifyOTP,
  getLoginPageHTML,
  getRateLimitStatus,
  SESSION_COOKIE_NAME
} from './middleware/auth.js';

import { getLocalIP } from './utils/network.js';
import { PtySession } from './services/pty.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const args = {
    port: Number(process.env.PORT) || 3001,
    noAuth: false,
    // On Windows the Kiro CLI ships as `kiro-cli.exe` in a separate install
    // directory from the IDE launcher. On PATH both `kiro` (IDE) and
    // `kiro-cli` (CLI) are callable, so we default to the CLI binary.
    // Evidence: `Get-Command kiro-cli | Select-Object Source` reports
    // `C:\Users\<user>\AppData\Local\Kiro-Cli\kiro-cli.exe`.
    command: process.env.KIRO_CLI_COMMAND || (process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli'),
    cwd: process.env.KIRO_CLI_CWD || process.cwd(),
    ptyArgs: []
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-auth') args.noAuth = true;
    else if (a === '--port' || a === '-p') args.port = Number(argv[++i]) || args.port;
    else if (a === '--command' || a === '-c') args.command = argv[++i] || args.command;
    else if (a === '--cwd') args.cwd = argv[++i] || args.cwd;
    else if (a === '--') {
      args.ptyArgs = argv.slice(i + 1);
      break;
    }
  }
  return args;
}

const config = parseArgs(process.argv);
setAuthEnabled(!config.noAuth);
if (!config.noAuth) generateOTP();

const ptySession = new PtySession({
  command: config.command,
  args: config.ptyArgs,
  cwd: config.cwd
});

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(authMiddleware);

// --- Auth routes -------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getLoginPageHTML());
});

app.get('/auth/status', (req, res) => {
  res.json(getRateLimitStatus());
});

app.post('/auth/verify', (req, res) => {
  const result = verifyOTP(req.body?.otp);
  if (result.success) {
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE_NAME}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
    ]);
    return res.json({ success: true });
  }
  return res.json(result);
});

// --- App routes --------------------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.get('/api/info', (req, res) => {
  res.json({
    command: config.command,
    args: config.ptyArgs,
    cwd: config.cwd,
    alive: ptySession.isAlive(),
    clients: ptySession.clients.size,
    platform: process.platform
  });
});

app.post('/api/reset', (req, res) => {
  ptySession.kill();
  res.json({ ok: true });
});

app.use('/static', express.static(join(__dirname, 'public')));

// --- HTTP + WebSocket --------------------------------------------------------

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url && !req.url.startsWith('/ws/pty')) {
    socket.destroy();
    return;
  }
  if (!validateWSAuth(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  let initialSize;
  try {
    const url = new URL(req.url, 'http://localhost');
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    if (Number.isInteger(cols) && Number.isInteger(rows)) {
      initialSize = { cols, rows };
    }
  } catch { /* ignore */ }

  if (!ptySession.isAlive()) {
    try {
      ptySession.spawn();
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'error', message: err.message })); } catch { /* closing */ }
      ws.close(1011, 'spawn failed');
      return;
    }
  }

  ptySession.addClient(ws, initialSize);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      ptySession.write(raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (msg?.type === 'input' && typeof msg.data === 'string') {
      ptySession.write(msg.data);
    } else if (msg?.type === 'resize') {
      ptySession.resizeFromClient(ws, msg.cols, msg.rows);
    } else if (msg?.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* closing */ }
    }
  });

  ws.on('close', () => ptySession.removeClient(ws));
  ws.on('error', () => ptySession.removeClient(ws));
});

httpServer.listen(config.port, () => {
  const ip = getLocalIP();
  const banner = [
    '',
    'Kiro CLI Mobile Bridge',
    '──────────────────────',
    `Local:   http://localhost:${config.port}`,
    `Network: http://${ip}:${config.port}`,
    `Command: ${config.command} ${config.ptyArgs.join(' ')}`.trimEnd(),
    `Cwd:     ${config.cwd}`,
    ''
  ];
  if (isAuthEnabled()) {
    banner.push(`Access Code: ${getOTP()}`);
    banner.push('');
    banner.push('Enter this code on your phone to connect.');
  } else {
    banner.push('Auth disabled (--no-auth). Anyone on your LAN can control the CLI.');
  }
  banner.push('');
  console.log(banner.join('\n'));
});

function shutdown() {
  console.log('\nShutting down…');
  ptySession.kill();
  try { wss.close(); } catch { /* ignore */ }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
