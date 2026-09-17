# Deploying to a Linux VPS (cheaper than GoDaddy Windows VPS)

## Why Linux instead of GoDaddy's Windows VPS

This app's database layer (`server/config/db.js`) already defaults to the
`tedious` driver (pure JS, no OS dependency) with SQL-auth — that's exactly
what SQL Server on Linux uses. The Windows-only `msnodesqlv8` driver was only
ever needed for local LocalDB dev, so it's now an optional dependency
(`package.json`) and isn't installed in the Docker image at all. That means
switching to Linux requires **zero application code changes** — only
environment variables.

SQL Server has run natively on Linux since SQL Server 2017, and Microsoft
ships an official Docker image, so you get the same database engine, not a
substitute.

## Recommended platform

**Hostinger KVM 2** (Mumbai data center) — 2 vCPU / 8 GB RAM / 100 GB NVMe,
roughly ₹799/mo on the intro term (renews around ₹1,199/mo). That's less
than half the effective cost of the GoDaddy Windows VPS (₹2,099/mo + 18% GST
≈ ₹2,477/mo), with double the RAM — comfortable headroom for Node processes
for all three apps plus the SQL Server container.

If Indian data-center latency isn't a hard requirement and you want the
absolute lowest cost, Contabo or Hetzner run comparable specs for less, but
without a Mumbai region.

Either way: choose the **Linux / Ubuntu** OS option, not Windows.

## What's in this repo for deployment

- `Dockerfile` — multi-stage build for the Node app (production deps only).
- `docker-compose.yml` — runs the app plus a SQL Server 2022 Linux container
  (`mssql` service), with a named volume for DB persistence and a healthcheck
  so the app waits for the DB to be ready.
- `.env.production.example` — production-shaped env template. Copy to `.env`
  on the server and fill in real secrets there; it's already gitignored.
- `Caddyfile` — reverse proxy with automatic HTTPS (Let's Encrypt), fronting
  this app now and commented stubs for the other two apps' subdomains later.

## First deploy

1. Provision the VPS (Ubuntu 22.04+), point your domain's DNS A record at its
   IP in GoDaddy's DNS management for `niyotishrivastava.com`.
2. SSH in, install Docker Engine + Compose plugin, and Caddy
   (`apt install docker.io docker-compose-plugin caddy` or via Docker's
   official install script).
3. Copy this repo to the server (git clone, or scp/rsync).
4. `cp .env.production.example .env` and fill in real values — strong
   `DB_PASSWORD` and `SESSION_SECRET`, real SMTP credentials, etc.
5. `docker compose up -d --build` — builds the app image and starts both
   containers. First boot of the `mssql` container takes ~30–60s before the
   healthcheck passes.
6. Initialize the schema against the running container:
   ```
   docker compose exec -T mssql /opt/mssql-tools18/bin/sqlcmd \
     -S localhost -U sa -P "<DB_PASSWORD from .env>" -C \
     -i /dev/stdin < server/sql/database.sql
   ```
   (`-T` disables TTY allocation so stdin piping works.)
7. Bootstrap the admin user: `docker compose exec app npm run create-admin`
   (uses `ADMIN_BOOTSTRAP_*` from `.env`).
8. Point Caddy at the app: `caddy run --config Caddyfile` (or run it as a
   systemd service — `systemctl enable --now caddy` if installed via apt).
   Caddy handles port 80/443 and proxies to the app container on `:3000`.
9. Verify: `curl https://niyotishrivastava.com/api/health`.

## Adding the other two apps later

Give each its own subdomain (e.g. `app2.`, `site.`) and its own port binding
in that app's compose/Docker setup, then uncomment and fill in the matching
block in `Caddyfile` and reload Caddy (`caddy reload --config Caddyfile`).
