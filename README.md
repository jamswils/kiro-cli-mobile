# Kiro CLI Mobile Bridge

Drive **[Kiro CLI](https://kiro.dev/cli/)** from your phone over LAN. Pairs
with the upstream **[Kiro IDE mobile bridge](https://github.com/4regab/kiro-mobile-bridge)**
so you can run both at once and flip between IDE and CLI on your phone.

> Type on the phone, watch the Kiro CLI echo every keystroke on your
> laptop. Same PTY, both screens.

Open `docs/demo.html` in a browser for an interactive preview of what the
setup looks like.

## Contents

- [Why two bridges?](#why-two-bridges)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Running both bridges together](#running-both-bridges-together)
- [Command-line options](#command-line-options)
- [Mobile UX notes](#mobile-ux-notes)
- [Firewall (Windows)](#firewall-windows)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Unverified](#unverified)
- [License](#license)

## Why two bridges?

Kiro ships two products: the **Kiro IDE** (Electron app) and the **Kiro CLI**
(terminal agent). They solve different jobs, and they need different bridges:

| Product | Bridge | How it connects | What it shows on the phone |
|---|---|---|---|
| Kiro IDE | `kiro-mobile-bridge` (upstream) | Chrome DevTools Protocol attaches to the Electron window | Custom mobile UI with Chat, Code, Tasks tabs |
| Kiro CLI | `kiro-cli-mobile-bridge` (this repo) | Pseudo-terminal wraps the CLI process | Real xterm.js terminal |

Run both. One project, two surfaces. Spec in the IDE, then jump to the CLI
on the same phone to run a command, all without walking back to the laptop.

## How it works

```
+------------------+    PTY       +-----------------+
|  Kiro CLI        | <----------> |  Bridge Server  |
|  (child process) |              |   (port 3001)   |
+------------------+              +--------+--------+
                                           |
                                   HTTP + WebSocket
                                           |
                                  +--------v--------+
                                  |  Phone browser  |
                                  |   (xterm.js)    |
                                  +-----------------+
```

1. **Spawn.** On first WebSocket connect, the server runs `kiro-cli` under
   [`node-pty`](https://www.npmjs.com/package/node-pty) with
   `TERM=xterm-256color` and `COLORTERM=truecolor`.
2. **Stream.** Raw PTY bytes are broadcast to every connected client as
   binary WebSocket frames. A 256 KiB scrollback buffer is replayed to late
   joiners so a fresh phone tab sees the current screen state instead of a
   blank terminal.
3. **Input.** Phone keystrokes go back as binary frames and are written
   straight into the PTY. JSON text frames carry resize and control events.
4. **Multi-client.** Multiple clients can attach at once — the effective
   PTY size is the minimum across all clients, so nobody sees line-wrap
   garbage.

## Prerequisites

- **Node.js** 18 or later. Verified on Node 24 (`node --version` shows
  `v24.14.0` in the author's environment).
- **Kiro CLI** installed and on `PATH`. On Windows the binary is
  `kiro-cli.exe`; `Get-Command kiro-cli | Select-Object Source` reports
  its location (typically
  `C:\Users\<user>\AppData\Local\Kiro-Cli\kiro-cli.exe`).
- Build toolchain for `node-pty`'s native module on first install:
  - **Windows:** Visual Studio Build Tools with the "Desktop development
    with C++" workload. `node-pty` ships prebuilt binaries for common Node
    versions — if one matches, no compilation is needed.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux:** `build-essential` + `python3`.

## Install

```bash
git clone <your-fork-or-this-repo-url> kiro-cli-mobile-bridge
cd kiro-cli-mobile-bridge
npm install
```

If `node-pty` fails to build on first install, retry with
`npm install --build-from-source`.

## Running both bridges together

Two terminals on the laptop, two browser tabs on the phone. The bridges
don't know about each other — they just live on different ports with
different cookies.

### Terminal 1 — the IDE bridge

Launch the Kiro IDE with the Chrome DevTools Protocol port open, then
start the upstream IDE bridge:

```bash
# Windows
kiro --remote-debugging-port=9000

# Then, in the Kiro IDE terminal or a fresh shell:
npx kiro-mobile-bridge
```

Output:

```
Kiro Mobile Bridge
------------------
Local:   http://localhost:3000
Network: http://192.168.1.42:3000

Access Code: 417085
```

Leave that terminal open.

### Terminal 2 — the CLI bridge

Fresh terminal:

```bash
cd kiro-cli-mobile-bridge
npm start
```

Output:

```
Kiro CLI Mobile Bridge
----------------------
Local:   http://localhost:3001
Network: http://192.168.1.42:3001
Command: kiro-cli.exe
Cwd:     /path/to/your/project

Access Code: 938532
```

If port 3001 is taken:

```bash
node src/server.js --port 3004
```

### On your phone

Phone must be on the **same Wi-Fi** as the laptop.

1. Open two tabs:
   - **IDE:** `http://<laptop-ip>:3000`
   - **CLI:** `http://<laptop-ip>:3001` (or the port you chose)
2. Enter the 6-digit access code in each tab. They're independent codes.
3. Swipe between tabs to flip between IDE and CLI.
4. **IDE tab:** Chat / Code / Tasks, just like the desktop IDE.
5. **CLI tab:** tap the black terminal, the mobile keyboard appears. Type,
   tap **Enter** in the sticky key row. Characters appear on the phone
   **and** in the Kiro CLI on the laptop at the same time — same PTY.

## Command-line options

```bash
node src/server.js [--port N] [--no-auth] [--command PATH] [--cwd DIR] [-- <args passed to CLI>]
```

| Flag | Default | What it does |
|---|---|---|
| `--port N` / `-p N` | `3001` (or `$PORT`) | Listen on a different port. |
| `--command PATH` / `-c PATH` | `kiro-cli.exe` on Windows, `kiro-cli` elsewhere (or `$KIRO_CLI_COMMAND`) | Override the child process. Useful for testing with `cmd.exe`, `bash`, etc. |
| `--cwd DIR` | `process.cwd()` (or `$KIRO_CLI_CWD`) | Working directory the child is spawned in. |
| `--no-auth` | auth enabled | Skip the OTP entirely for fully trusted LANs. **Do not expose to the internet.** |
| `-- <args>` | _none_ | Everything after `--` is passed verbatim as argv to the CLI. |

Examples:

```bash
# Different port
node src/server.js --port 3004

# Full path to the CLI, pass --help through
node src/server.js \
  --command "C:\Users\<you>\AppData\Local\Kiro-Cli\kiro-cli.exe" \
  -- --help

# Run the bridge in a specific project directory
node src/server.js --cwd "C:\Projects\my-project"
```

## Mobile UX notes

The mobile client lives in `src/public/index.html`. A few details worth
knowing:

- **Sticky key row** covers what phones don't have: Esc, Tab, Ctrl-C,
  Ctrl-D, arrows, pipe, tilde, Enter. Tap to send.
- **Hide keyboard** button blurs the hidden textarea so the virtual
  keyboard retracts. Tapping the terminal brings it back.
- **Restart** button kills the PTY via `POST /api/reset`. Next WS connect
  starts a fresh Kiro CLI session.
- **Connection status** in the top-left. Auto-reconnect with exponential
  backoff capped at 5 seconds.

### "Screen scrolls sideways when I type" fix

The v0.1 client had that bug: the mobile keyboard appeared, the terminal
didn't re-fit, and the cursor ended up past the visible column count so
the viewport scrolled horizontally to follow. Felt janky.

Fix in the current client:

- CSS caps `.xterm-viewport` at `max-width: 100%` with
  `overflow-x: hidden`, so the terminal can't scroll horizontally
  regardless of fit state.
- JS listens to `window.visualViewport.resize` (not just `window.resize`,
  which doesn't fire for keyboard show/hide on iOS) and triggers a
  debounced `FitAddon.fit()` + `resize` message to the PTY.
- The hidden helper textarea gets `font-size: 16px` to prevent iOS
  Safari's focus-zoom behavior.
- Whole page is `position: fixed` so the document itself can never
  scroll — only the terminal scrollback does.

If it regresses on a specific device, open `src/public/index.html`,
search for `visualViewport`, and report what the device does.

## Firewall (Windows)

If the phone loads the page on `localhost` but can't reach
`http://<laptop-ip>:3001`, your Node firewall rule is probably
Public-only while your Wi-Fi profile is Private. Two fixes:

1. **Quick:** flip the Wi-Fi to "Public network" in Windows Settings.
2. **Proper:** run once in an **Admin** terminal:
   ```cmd
   netsh advfirewall firewall add rule name="Kiro CLI Bridge 3001" dir=in action=allow protocol=TCP localport=3001 profile=any
   ```
   Change `3001` if you picked a different port.

The upstream IDE bridge documents the same pattern in its README under
"Windows: Works on your computer but not on mobile".

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: listen EADDRINUSE` on start | Port already in use | `node src/server.js --port 3004` (or pick a free port) |
| Phone shows OTP page but "invalid code" | OTP already consumed by another device | Stop (`Ctrl+C`) and restart the bridge for a new code |
| Phone hangs on network URL | Firewall blocking | See [Firewall (Windows)](#firewall-windows) |
| Terminal is blank on connect | CLI hasn't produced output yet | Wait 2–5 seconds, the Kiro CLI boot takes a moment |
| CLI exits immediately, red `[bridge error]` | Wrong `--command` path | `where.exe kiro-cli` (Windows) / `which kiro-cli` to find the real binary |
| Typing still scrolls sideways | Old HTML cached | Hard reload / clear cache |
| `spawn node-pty ENOENT` at npm install | Build toolchain missing | See [Prerequisites](#prerequisites) |

## Security model

- **Single-use OTP.** A 6-digit code generated with `crypto.randomInt` at
  every server boot, printed to the terminal. Once a device verifies,
  the code is consumed and further attempts are rejected.
- **HttpOnly session cookie** (`kcmb_session`). 32 random bytes, hex-
  encoded. JavaScript on the page can't read it; it's sent automatically
  on HTTP requests and WebSocket upgrade requests.
- **Rate limiting.** 5 failed attempts locks the login for 60 seconds.
- **Timing-safe comparisons** for both the OTP and the session token
  (`crypto.timingSafeEqual`).
- **`--no-auth` escape hatch** for fully trusted environments, matching
  the IDE bridge's model.
- **LAN tool, not an internet service.** No TLS. Don't port-forward it.
  Don't run it on a coffee-shop Wi-Fi. Same trust model as any local dev
  server.
- **Cookie name differs from the IDE bridge** (`kcmb_session` vs
  `kmb_session`) so the two can coexist on the same origin without
  clobbering each other's sessions.

## Project layout

```
kiro-cli-mobile-bridge/
├── src/
│   ├── server.js             HTTP + WebSocket server, arg parsing, boot banner
│   ├── middleware/
│   │   └── auth.js           OTP flow (generate, verify, rate-limit, login page)
│   ├── services/
│   │   └── pty.js            Spawns the CLI under node-pty, multiplexes to clients
│   ├── utils/
│   │   ├── network.js        Cross-platform LAN IP detection
│   │   └── constants.js      OTP tuning, cookie name
│   └── public/
│       └── index.html        Mobile UI (xterm.js, fit addon, sticky keys, OTP flow)
├── docs/
│   └── demo.html             Static showcase page (open in any browser)
├── package.json
├── LICENSE
├── README.md
└── .gitignore
```

## Unverified

- Exact Kiro CLI argv for non-interactive flows isn't pinned to official
  docs in this README. [Headless mode](https://kiro.dev/docs/cli/headless/)
  covers CI/CD invocation, but this bridge is interactive. For flags,
  run `kiro-cli --help` locally.

## License

MIT — see `LICENSE`.
