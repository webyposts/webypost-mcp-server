# Webypost MCP Server (HTTP / SSE)

Production-ready **Model Context Protocol** server that lets Grok (or any MCP client) automate **webypost.com**:

| Tool | Purpose |
|------|---------|
| `check_webypost_status` | Reachability + credential validation |
| `publish_webypost_post` | Login + publish a text post, return story URL |

Transport: **MCP over SSE (HTTP)** — required for Grok public URL integration.

---

## Requirements

- **Node.js 18+** (20 LTS recommended)
- A Webypost account (email + password)
- For local Webypost site tests: XAMPP Apache + MySQL running with `http://localhost/webypost`

---

## Install

```bash
cd webypost-mcp-server
npm install
cp .env.example .env
# edit .env — set WEBYPOST_EMAIL and WEBYPOST_PASSWORD
```

### Dependencies (`package.json`)

| Package | Role |
|---------|------|
| `@modelcontextprotocol/sdk` | Official MCP server + SSE transport |
| `express` | HTTP server (`/sse`, `/messages`, `/health`) |
| `zod` | Tool argument schemas |
| `dotenv` | `.env` loading |
| `axios` + `tough-cookie` + `axios-cookiejar-support` | Session cookies, login, form POST |
| `typescript` / `tsx` | Build & dev runner |

---

## `.env` configuration

```env
PORT=8787
HOST=0.0.0.0

# Production (default)
WEBYPOST_BASE_URL=https://webypost.com

# Or local XAMPP
# WEBYPOST_BASE_URL=http://localhost/webypost

WEBYPOST_EMAIL=you@example.com
WEBYPOST_PASSWORD=your-password

# Optional cookie-only auth (advanced)
# WEBYPOST_SESSION_COOKIE=PHPSESSID=...; wyp_remember=...

WEBYPOST_DEFAULT_PRIVACY=Public
WEBYPOST_TIMEOUT_MS=30000
```

---

## Run (localhost)

### Development (hot TypeScript)

```bash
cd /home/sravanimahesh/webypost-mcp-server
npm run dev
```

### Production build

```bash
npm run build
npm start
```

### Smoke-test tools without Grok

```bash
# Status only
npm run test:tools

# Status + publish a Private test post
SMOKE_PUBLISH=1 npm run test:tools
```

### Local URLs (when running)

| Endpoint | URL |
|----------|-----|
| Info page | http://127.0.0.1:8787/ |
| Health JSON | http://127.0.0.1:8787/health |
| **MCP Streamable HTTP (preferred for Grok)** | **http://127.0.0.1:8787/mcp** |
| MCP legacy SSE | http://127.0.0.1:8787/sse |
| MCP legacy messages | `POST http://127.0.0.1:8787/messages?sessionId=…` |

> **Important:** Grok cannot connect to `127.0.0.1` from the cloud. You must expose the port with **ngrok** (or deploy to Render) and paste the **public HTTPS** URL.

---

## How posting works

1. `GET {WEBYPOST_BASE_URL}/` — establish `PHPSESSID`
2. `POST {base}/logcode.php` JSON `{ email, password, remember_me: "1" }`
3. `POST {base}/poscode.php` form body:
   - `submit=1`, `wp_ajax=1`
   - `name` = **content** (body)
   - `titles` = **title**
   - `privacy` = Public|Private|Friends
4. Parse JSON `{ success, pid, slug, message }` → public URL `{slug}/story/{pid}`

Errors are returned as structured JSON text so Grok can explain failures (wrong password, site down, validation, session expired).

---

## Expose to Grok with ngrok

Grok runs in the cloud and **cannot** reach `http://127.0.0.1:8787`.  
You need a public HTTPS tunnel.

```bash
# terminal 1 — MCP server
cd /home/sravanimahesh/webypost-mcp-server
npm run dev

# terminal 2 — public tunnel
ngrok http 8787
```

ngrok prints something like:

```text
Forwarding  https://abc123.ngrok-free.app -> http://localhost:8787
```

In **grok.com → MCP / connectors**, paste **exactly**:

```text
https://abc123.ngrok-free.app/mcp
```

| Client type | Path |
|-------------|------|
| **Grok / modern MCP** | `/mcp` (Streamable HTTP) ← use this |
| Older SSE-only clients | `/sse` |

**Common connection failures**
1. Using `http://127.0.0.1:8787/...` in Grok → always fails (not public).
2. Using ngrok root URL without `/mcp` → may fail.
3. Server not running (`npm run dev`).
4. Free ngrok interstitial page — open the ngrok URL once in a browser and click through, or use an ngrok auth token.

---

## Deploy on Render (permanent Grok URL)

This is the recommended production setup. Free Render URLs stay the same after restarts
(unlike free ngrok, which often changes subdomain).

### Option A — Blueprint (easiest)

1. Push this repo to GitHub.
2. On [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
3. Connect the GitHub repo (root has `render.yaml`).
4. When prompted, set secrets:
   - `WEBYPOST_EMAIL` — your Webypost login email
   - `WEBYPOST_PASSWORD` — your Webypost password
5. Deploy. Copy the service URL from the dashboard.

### Option B — Manual Web Service

1. Push this folder to a GitHub repo.
2. Create a **Web Service** on [render.com](https://render.com):
   - **Runtime:** Node
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
3. Set environment variables:
   - `WEBYPOST_BASE_URL=https://webypost.com`
   - `WEBYPOST_EMAIL=…`
   - `WEBYPOST_PASSWORD=…`
   - `NODE_ENV=production`
   - `HOST=0.0.0.0`
   - `PORT` is injected by Render automatically

### Grok URL (after deploy)

```text
https://YOUR-SERVICE.onrender.com/mcp
```

Example: if the service is `webypost-mcp-server`, use:

```text
https://webypost-mcp-server.onrender.com/mcp
```

Legacy clients can use `/sse` instead of `/mcp`.

### Free-plan notes

- Free instances **spin down** after idle time; the first request may take ~30–60s (cold start).
- The hostname stays permanent while the service exists.
- Keep credentials only in Render **Environment** secrets — never commit `.env`.

---

## Tools (for Grok)

### `check_webypost_status`

No arguments. Returns:

```json
{
  "ok": true,
  "reachable": true,
  "authenticated": true,
  "baseUrl": "https://webypost.com",
  "message": "Authenticated as you@example.com"
}
```

### `publish_webypost_post`

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `title` | string | yes (may be `""`) | Post title |
| `content` | string | yes | Post body |
| `privacy` | enum | no | `Public` / `Private` / `Friends` |

Success example:

```json
{
  "ok": true,
  "message": "Post published",
  "url": "https://webypost.com/my-title/story/12345",
  "pid": 12345,
  "slug": "my-title"
}
```

---

## Security notes

- Never commit `.env` (gitignored).
- Prefer a dedicated Webypost account for automation.
- On Render, use secret env vars only.
- This server holds session cookies in memory for the process lifetime.

---

## Project layout

```text
webypost-mcp-server/
├── package.json
├── tsconfig.json
├── .env.example
├── render.yaml
├── README.md
└── src/
    ├── index.ts            # Express + SSE transport
    ├── server.ts           # MCP tools
    ├── webypost-client.ts  # Login + publish automation
    ├── config.ts           # dotenv config
    └── smoke-test.ts       # CLI smoke test
```
