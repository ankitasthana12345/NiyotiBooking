# Deploying to the GoDaddy Windows VPS

This replaces the Docker/Linux plan in `DEPLOYMENT.md` (kept in the repo in
case you ever add a Linux box for the other two apps) — a self-managed
Windows Server VPS calls for a native install instead of containers.

## What you already configured

Self Managed VPS Windows, 2 vCPU / 4 GB RAM, No Control Panel (root access
via RDP), 24-month term.

## 1. Complete the purchase

Finish checkout on the screen you had open. Note down from the confirmation
email / GoDaddy account:
- **Server IP address**
- **Administrator password** (or RDP credentials)

Come back with those and I'll help verify each step below as you go (I can't
RDP in myself, but I can tell you exactly what to run/click at each stage).

## 2. Point DNS at the server

In GoDaddy's DNS management for `niyotishrivastava.com`, add/edit:
- `A` record, host `@`, value = the VPS IP
- `A` record, host `www`, value = the VPS IP

DNS can take a few minutes to a few hours to propagate — fine to do this
early and let it settle while you do the rest.

## 3. RDP in and install prerequisites

Connect via Remote Desktop (`mstsc` on Windows, or Microsoft Remote Desktop
on Mac) to the VPS IP with the Administrator credentials. Then install:

1. **Node.js LTS** — download the Windows installer from nodejs.org and run it.
2. **SQL Server Express** (free) — download from Microsoft, choose "Basic"
   install. After install, open **SQL Server Configuration Manager**:
   - Enable **TCP/IP** under SQL Server Network Configuration → Protocols.
   - Set the TCP port to a static **1433** (TCP/IP properties → IP Addresses
     tab → IPAll → TCP Port = 1433, clear TCP Dynamic Ports).
   - Restart the SQL Server service for this to take effect.
3. In **SQL Server Management Studio (SSMS)** (also free, install it too):
   - Connect to `localhost` using Windows auth (works locally by default).
   - Server properties → Security → set authentication mode to
     **SQL Server and Windows Authentication mode** (mixed mode), then
     restart the SQL Server service again.
   - Enable the `sa` login and set a strong password (Security → Logins →
     sa → General: set password; Status: enable).
4. **IIS** — enable via Server Manager → Add Roles and Features → Web
   Server (IIS). Then install two IIS extensions from Microsoft:
   - **URL Rewrite**
   - **Application Request Routing (ARR)**
   These let IIS reverse-proxy to your Node app instead of serving it
   directly.
5. **win-acme** — a free Let's Encrypt client for Windows/IIS, handles
   HTTPS certificates and auto-renewal. Download and keep it on the server.

## 4. Get the app onto the server

Easiest without git: zip this project folder locally and drag-drop it into
the RDP session (or use `scp` from this machine once RDP/SSH access is
confirmed). Unzip to e.g. `C:\apps\niyotinew`.

## 5. Configure production environment

On the server, copy `.env.production.example` to `.env` in the app folder,
then edit:
- `DB_SERVER=localhost`
- `DB_USER=sa`, `DB_PASSWORD=<the sa password you set in step 3>`
- `SESSION_SECRET` — a long random string
- `CORS_ORIGIN=https://niyotishrivastava.com`
- Fill in real SMTP / admin bootstrap / WhatsApp values as needed

`DB_DRIVER` stays `tedious` — simplest and works identically to local dev,
no Windows-auth ODBC driver needed even though the box itself is Windows.

## 6. Install dependencies and initialize the database

In an elevated PowerShell/cmd in the app folder:
```
npm install
```
Then run the schema against the local SQL Server instance:
```
sqlcmd -S localhost -U sa -P "<sa password>" -i server\sql\database.sql
```
Bootstrap the admin user:
```
npm run create-admin
```

## 7. Run the app as a background Windows service

RDP sessions don't keep processes running after you disconnect by default.
Use **NSSM** (Non-Sucking Service Manager, free) to run the app as a proper
Windows service:
```
nssm install NiyotiApp "C:\Program Files\nodejs\node.exe" "C:\apps\niyotinew\server\server.js"
nssm set NiyotiApp AppDirectory "C:\apps\niyotinew"
nssm start NiyotiApp
```
This keeps it running and restarts it if it crashes or the server reboots.

## 8. Reverse proxy + HTTPS via IIS

1. In IIS Manager, create a new Site bound to port 80/443 for
   `niyotishrivastava.com`.
2. Add a URL Rewrite rule (inbound rule, type "Reverse Proxy") pointing to
   `http://localhost:3000` — this makes IIS forward all traffic to the Node
   app instead of serving static files directly.
3. Run `win-acme` and follow its prompts to issue a certificate for
   `niyotishrivastava.com` bound to the IIS site — it configures HTTPS and
   sets up a scheduled task for auto-renewal.

## 9. Verify

From your own machine: `curl https://niyotishrivastava.com/api/health` should
return a healthy response with `"database": "connected"`.

## Adding the other two apps later

Run each as its own NSSM service on a different port (3001, 3002, ...), then
add matching IIS sites/bindings for their subdomains, each with its own
win-acme certificate.
