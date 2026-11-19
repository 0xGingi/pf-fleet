# pf-fleet

Run [Pirate Face](https://pirateface.co) `pf work` lanes across multiple machines and manage them from one web dashboard.

## How it works

- **Dashboard** — Runs in Docker on your server (or over a private network like Tailscale). From the web UI, you add your Pirate Face accounts, register machines, turn lanes on or off, and watch live progress, throughput, and logs.
- **Agent** — A small static Linux binary installed on each worker machine with a one-line command. It manages your `pf work` processes, streams their progress and output back to the dashboard, and restarts them cleanly when updates arrive.

Agents connect **outward** to the dashboard over WebSockets, so worker machines behind NAT or on shared seedboxes work out of the box and the dashboard never needs SSH access. If the dashboard goes offline, agents keep running their lanes and send missed job history once it comes back.

---

## Quick start

### 1. Start the dashboard

Download the Compose file and example config:

```sh
curl -fsSLO https://raw.githubusercontent.com/0xGingi/pf-fleet/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/0xGingi/pf-fleet/main/.env.example -o .env
```

Open `.env` and set three values:

- `PUBLIC_URL` — The address your worker machines will use to reach the dashboard (for example, `https://fleet.example.com` or `http://my-server.tailnet:1337`).
- `ADMIN_PASSWORD` — The password you'll use to sign in.
- `APP_SECRET` — A random secret used to encrypt your Pirate Face keys in the database. Generate one with `openssl rand -hex 32`.

Start the container:

```sh
docker compose up -d
```

Open `http://<your-host>:1337` and sign in (default username is `admin`).

> **Security note:** Because the dashboard can start and stop workers on your machines, don't expose it to the public internet over plain HTTP. Put it behind a reverse proxy with HTTPS (and set `TRUST_PROXY=1` in `.env`), or keep it on a private network like Tailscale.

### 2. Add your Pirate Face account

1. Copy your community torrent key (`pfct_…`) from [pirateface.co/settings](https://pirateface.co/settings).
2. In the dashboard, go to **Accounts → Add account** and paste the key.

### 3. Add a worker machine

1. Go to **Nodes → Add node**, give the machine a name, and pick which account it belongs to.
2. Copy the install command shown (its token is only displayed once) and run it on your worker machine as the user that should run `pf work`:

   ```sh
   curl -fsSL https://fleet.example.com/install.sh | sh -s -- --server https://fleet.example.com --token <nodeId>.<secret>
   ```

   The script installs `uv` if needed, puts `pf-fleet-agent` in `~/.local/bin` (or `/usr/local/bin` when run as root), and sets up a systemd service so it starts automatically on boot. On systems without systemd, it prints a `nohup` command you can use instead.
3. Once the node appears online in the dashboard, open it and **add lanes**. Each lane runs one `pf work --name <lane>` worker.

The dashboard automatically enforces Pirate Face's rules:
- Each account can run at most **3 active lanes** at a time across all machines.
- Lane names must be **unique per account** (1–24 characters: letters, numbers, `.`, `_`, `-`).

---

## Everyday use

### Stopping and restarting lanes
When you switch off or restart a lane that's currently verifying a model, you can choose:
- **Stop after this job** *(recommended)* — Lets the worker finish submitting the current model before stopping.
- **Stop now** — Kills the worker immediately. Because `pf work` streams models in memory and can't resume, any progress on that model is lost. Pirate Face also holds the interrupted lease for up to 10 minutes; if you start the lane again right away, the agent will wait out the remaining lease before requesting new work.

### Limiting model size on slower machines
To keep a machine with slow bandwidth or tight limits from picking up huge models, open the node page and set **Largest model (GiB)** under node settings (passes `--max-size` to `pf work`).

### Moving a node to another machine
On the node's page, click **New install command** and run the new command on the replacement machine. The old agent is disconnected automatically and your lane configuration stays intact.

### Automatic updates

- **`pirateface` releases:** The dashboard checks PyPI every 30 minutes. When a new version of `pirateface` is published, every active lane switches to it automatically after finishing its current job. You can check the active version or trigger an immediate check under **Settings → pirateface**.
- **Dashboard & agents:** To update `pf-fleet` itself, pull the latest image on your dashboard server:

  ```sh
  docker compose pull && docker compose up -d
  ```

  Each dashboard release bundles the matching agent binary. After the dashboard updates, connected nodes automatically download the new agent, wait for their active jobs to finish, and restart into the new version. If you prefer to update nodes manually, turn off **Settings → Update agents automatically**.

### Webhook alerts
Under **Settings → Alerts**, you can add a Discord, Slack, or custom webhook URL to get notified when:
- A node goes offline for 2+ minutes (and when it reconnects)
- A lane repeatedly crashes or errors for 10+ minutes (and when it recovers)
- Pirate Face refuses a submission or a job fails
- An agent runs into a setup or update problem

### Logs, events, and stats
- **Live output & event log:** Each node page shows the last 1,000 lines of output per lane alongside an event log covering connection drops, agent updates, worker crashes, and lease waits.
- **Job history & points:** The dashboard tracks throughput and records every leased model (`listed`, `already listed`, `refused`, `error`, or `aborted`). It also estimates points earned (1 point per 10 GB verified), though [pirateface.co](https://pirateface.co) is always the source of truth.
- **Retention:** Logs, events, and job history are stored in SQLite so they survive dashboard restarts. By default, history is kept for 180 days (configurable under **Settings → History**).

---

## Configuration reference

All settings live in `.env` alongside `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | *(required)* | Externally reachable URL of the dashboard (used in node install commands). |
| `ADMIN_USER` | `admin` | Username for the dashboard login. |
| `ADMIN_PASSWORD` | *(required)* | Plain-text password (hashed at startup). Alternatively, set `ADMIN_PASSWORD_HASH`. |
| `APP_SECRET` | *(required)* | Secret key used to encrypt Pirate Face tokens at rest (`openssl rand -hex 32`). |
| `PF_FLEET_PORT` | `1337` | Host port exposed by Docker Compose. |
| `TRUST_PROXY` | `0` | Set to `1` when running behind a reverse proxy so login rate-limiting sees real client IPs. |
| `PF_FLEET_TAG` | `latest` | Docker image tag: `latest` (newest release), `0.1` (pin a minor release line), or `edge` (latest commit on `main`). |

### Compatibility notes
- **Supported worker platforms:** Linux `x86_64` and `aarch64`.
- **Shared hosts & seedboxes:** The agent automatically caps worker thread pools (`RAYON_NUM_THREADS=2`, etc.) so `uv` and `pf` don't hit per-user thread limits on shared seedboxes.

---

## Development

### Repository layout

```text
agent/                 Rust node agent (static musl binary)
apps/server/           Bun + Hono API, WebSocket hub, SQLite (Drizzle ORM)
apps/web/              React + Vite + Tailwind web dashboard
packages/protocol/     Shared Zod schemas for agent/dashboard messages and REST/SSE
protocol/fixtures/     Sample messages verified by both TypeScript and Rust tests
docs/protocol.md       Wire protocol specification
```

### Running locally

```sh
bun install
cp .env.example apps/server/.env   # set PUBLIC_URL=http://localhost:1337, ADMIN_PASSWORD, and APP_SECRET
bun run dev                        # starts API on :1337 and Vite UI on :5173
```

Run the server and protocol tests:

```sh
bun test packages apps/server
bun run typecheck
```

Run the Rust agent tests (using Docker if you don't have a local Rust toolchain):

```sh
docker run --rm -v "$PWD":/src -w /src/agent rust:1.98-alpine3.22 \
  sh -c 'apk add gcc musl-dev && cargo test'
```

- **Local Docker build:** Run `docker compose up -d --build` from a git clone to build the full image (including static `x86_64` and `aarch64` agents) locally.
- **Database migrations:** Edit `apps/server/src/db/schema.ts`, then run `cd apps/server && bunx drizzle-kit generate`. Migrations run automatically on startup.
- **Cutting a release:** Bump `version` in `agent/Cargo.toml`, commit, and push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). CI builds and publishes the multi-arch image and agent binaries.
