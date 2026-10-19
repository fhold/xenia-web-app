# Xenia App

Self-hosted web app for the **Xenia DBL** espresso machine: live brew dashboard,
shot history, profiles on top of the machine's scripts, brew-by-weight, a script
editor and app-side flow profiles. It talks to the machine over its local HTTP API
(v2) and runs in the browser on a tablet, phone or PC.

This is a personal hobby project, shared as an example of what the Xenia's open
API makes possible. It is not affiliated with or endorsed by Xenia Espresso GmbH.

## ⚠ Safety and security — read this first

- **The app controls real hardware.** It starts and stops brews, switches the pump,
  valves and boilers, and writes scripts to the machine. Bugs, network hiccups or a
  wrong setting can mean hot water where you don't expect it. Stay at the machine
  while it brews. Use at your own risk — see the warranty disclaimer in `LICENSE`.
- **There is no login.** Anyone who can reach the app can start a brew, change
  settings or delete machine scripts. Run it only in a network you trust (your home
  LAN, or a private VPN such as Tailscale/WireGuard). **Never expose it to the
  internet** (no port forwarding, no public reverse proxy). The Xenia's own API is
  just as open on the LAN, so the app adds no new exposure there — but it would on
  the internet.

## Requirements

- Xenia DBL with network access to its web interface. Developed against firmware
  4.133 and checked against 4.255 (ESP 3.95). Other firmware may change fields.
- A Bookoo scale paired **with the machine** (weight and flow come from the scale
  via the Xenia API; the machine has no usable flow meter).
- Node.js 24 LTS (the app uses the built-in `node:sqlite` module). `.nvmrc` pins it:

```bash
nvm install 24 && nvm use
```

## Setup

```bash
cd backend && npm install
cd ../frontend && npm install
```

## Running it

Build both packages; the backend then serves the frontend on one port.

```bash
cd frontend && npm run build
cd ../backend && npm run build
NODE_ENV=production MACHINE_IP=192.168.1.100 PORT=3000 DB_PATH=/var/lib/xenia/xenia.db npm start
```

| Variable | Meaning | Default |
|---|---|---|
| `NODE_ENV` | Must be `production` — otherwise the backend serves only the API and `/` answers "Route GET:/ not found" | — |
| `MACHINE_IP` | Address of your Xenia on the LAN — used for the first start only; change it later under Settings → Machine | `192.168.1.100` |
| `PORT` | Port of the app | `3001` |
| `DB_PATH` | SQLite database file (created on first start) | `backend/data/xenia.db` |

Open `http://<host>:<PORT>` in a browser. Health check: `/health`.

As a systemd service, put `Environment=NODE_ENV=production` (and the other variables)
into the unit, with `WorkingDirectory` set to `backend/` and
`ExecStart=/usr/bin/node dist/backend/src/index.js`.

The database uses WAL mode — back it up with `sqlite3 xenia.db ".backup backup.db"`,
not by copying the file while the app runs.

## Updating

Run as the user that owns the checkout (not as root):

```bash
./update.sh            # back up the database, pull, install, build, restart
./update.sh --dry-run  # only show what would happen
```

The script stops if a brew is running or if tracked files were changed locally.
It backs up the database next to it (`xenia.db.bak-<date>-before-update`), pulls,
runs `npm ci` and the build in both packages, and only then restarts the systemd
service (with `sudo` if needed) and waits for `/health`. Database changes are
applied automatically when the new version starts. If a step fails, it prints how
to go back.

It reads `DB_PATH` and `PORT` from the environment or from the service's
`Environment=` lines; the service name defaults to `xenia-app.service`
(override with `XENIA_SERVICE=…`). Without a systemd service it stops after the
build — restart the app yourself.

## Install as an app on Android (full screen)

Browsers install a web app as a standalone app (own icon, no address bar) only when
it is served over HTTPS. Over a plain LAN address such as `http://192.168.1.50:3000`
Chrome just adds a shortcut that opens in a normal tab. The easiest way to get HTTPS
at home is [Tailscale](https://tailscale.com):

1. Install Tailscale on the machine that runs the app and on the tablet or phone,
   both in the same tailnet.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**
   (DNS settings).
3. On the app machine: `tailscale serve --bg 3000` (use your `PORT`). The app is now
   reachable at `https://<machine-name>.<your-tailnet>.ts.net` — from devices in your
   tailnet only, at home and on the road.
4. Open that address in Chrome on Android → menu → **Install app** (or *Add to home
   screen*). It starts in its own window without the browser bar, in landscape.

⚠ Use `tailscale serve`, **not** `tailscale funnel` — funnel publishes the app to the
internet, and the app has no login.

## Development

```bash
# Terminal 1 — backend (port 3001)
cd backend && npm run dev

# Terminal 2 — frontend (port 5173, proxies the API)
cd frontend && npm run dev
```

A mock machine for working without a Xenia: see `backend/mock/README.md`.

Tests (backend and shared code, `node:test`):

```bash
cd backend && npm test
```

## Credits

- Built together with [Claude Code](https://claude.com/claude-code) (Anthropic).
- Brew-by-weight lag auto-calibration is adapted from
  [Beanconqueror](https://github.com/graphefruit/Beanconqueror) (GPL-3.0); see
  `shared/src/bbw-lag-calibration.ts`. Beanconqueror's brew-by-weight approach also
  inspired `shared/src/brew-by-weight.ts`.
- `backend/scripts/import-beanconqueror.ts` imports beans from a Beanconqueror export.

## Feedback

This is a hobby project without any support promise. Bug reports and ideas are welcome
as GitHub issues — please include your firmware version, your scale and what you did.
Whether and when something gets fixed depends on my spare time. Pull requests are
welcome too; by contributing you agree to license your changes under GPL-3.0.

## License

GPL-3.0-only — see `LICENSE`.
