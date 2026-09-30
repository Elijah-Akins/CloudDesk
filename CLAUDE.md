# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CloudDesk is a web application for managing remote desktop connections to cloud instances (EC2/OCI) via VNC. It consists of:
- **Frontend**: Next.js 16 with React 19, TypeScript, and Tailwind CSS 4 (Vercel-hosted)
- **Backend**: Node.js/Express with MongoDB, Redis, containerized with Docker

## Commands

### Frontend Development
```bash
npm run dev      # Start Next.js dev server (http://localhost:3000)
npm run build    # Production build
npm run start    # Start production server
npm run lint     # Run ESLint
```

### Backend Development
```bash
cd backend
npm run dev      # Start with hot reload (ts-node-dev)
npm run build    # Compile TypeScript
npm start        # Start production server
npm test         # Unit/integration tests (node:test, files in backend/test/)
```

### Docker (Production)
```bash
cd backend
docker compose -f docker-compose.prod.yml up -d   # Start full stack
docker compose -f docker-compose.prod.yml down    # Stop stack
docker compose -f docker-compose.prod.yml logs    # View logs
```

### Testing
Use Playwright for frontend and E2E tests (`e2e/`). Run tests sequentially for database consistency:
```bash
npx playwright test --workers=1
```
- `playwright.config.ts` builds and starts the app on port 3100 with `NEXT_PUBLIC_API_URL=''`, so API calls are same-origin and specs mock them with `page.route()` / `page.routeWebSocket()` (no backend needed)
- To use a locally installed Chromium instead of `npx playwright install`, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
- Backend tests: `cd backend && npm test` (node:test via ts-node; `test/setup.ts` provides the env vars the config requires)
- CI (`.github/workflows/ci.yml`) runs frontend lint + typecheck, backend build + tests, controller/worker typecheck, Playwright, and Docker test builds

## Architecture

### Frontend (Next.js App Router)
- Uses App Router (`app/` directory)
- Path alias: `@/*` maps to project root
- State Management: Zustand (stores in `lib/stores/`)
- API Client: Axios with JWT interceptors (`lib/api/client.ts`); only token errors trigger a refresh, credential errors (`INVALID_CREDENTIALS`, `INCORRECT_PASSWORD`) are surfaced as-is
- `NEXT_PUBLIC_API_URL`: backend base URL; an empty string means same-origin (used by the Docker image), unset falls back to the hosted API
- VNC Integration: vendored noVNC (`public/novnc/`) loaded in an iframe (`public/vnc.html`); the parent page passes the WebSocket URL via same-origin `postMessage`, never in the frame URL
- Forms: React Hook Form + Zod validation
- Styling: Tailwind CSS with monochrome + glassy design system
- Key Pages: Login, Register, Dashboard, Instances, Sessions, Settings, DesktopView

### Backend (Containerized)
- **API Server**: Express.js (`backend/src/`)
- **Database**: MongoDB 7 (containerized)
- **Cache/PubSub**: Redis 7 (containerized)
- **Session Controller**: Manages VNC worker containers (`backend/session-controller/`) - **not wired in**: nothing publishes `session:create`, see below
- **Session Worker**: Isolated VNC proxy per session (`backend/session-worker/`) - not used by the live connection path
- **Host NGINX**: SSL termination (port 443)

> **Current state:** live sessions run *in the API process* (SSH tunnel + WebSocket proxy in `backend/src`). The Redis/controller/worker design below is the intended architecture, but the backend never publishes to it, so tunnels and viewer connections live in API memory and the API can only run as a single instance.

### Container Architecture
```
┌─────────────────────────────────────────────────────────┐
│  Host NGINX (SSL)  ←───────────────────────────────────┤
│        │                                                │
│        ↓                                                │
│  ┌─────────────────────────────────────────────────┐  │
│  │  docker-compose.prod.yml                         │  │
│  │  ┌──────────┐  ┌────────┐  ┌─────────────────┐ │  │
│  │  │  Redis   │  │ MongoDB│  │ Backend API     │ │  │
│  │  │  :6379   │  │ :27017 │  │ :3000           │ │  │
│  │  └──────────┘  └────────┘  └─────────────────┘ │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │ Session Controller                        │  │  │
│  │  │ (Spawns worker containers via Docker API)│  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
│                         ↓                              │
│  ┌─────────────────────────────────────────────────┐  │
│  │  Session Workers (Dynamic)                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐      │  │
│  │  │ Worker 1 │  │ Worker 2 │  │ Worker N │      │  │
│  │  │ :8080    │  │ :8081    │  │ :808X    │      │  │
│  │  └──────────┘  └──────────┘  └──────────┘      │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Services
- **sshService**: SSH2 connections
- **vncService**: VNC server management on remote instances
- **tunnelService**: SSH tunnel management (closing a tunnel also ends its SSH connection)
- **encryptionService**: Server-side AES-256 encryption plus the password-based layer (mirrors `lib/utils/crypto.ts`)
- **sessionService**: Session lifecycle management
- **licenseService**: Validates `LICENSE_KEY` online against `LICENSE_SERVER_URL` (cached, 14-day offline grace); no key or a rejected key = Community tier
- **sessionRegistry**: Redis-based session state and pub/sub (only used by startup session recovery)
- **websocket/SessionBridge**: One TCP connection through the tunnel per viewer; `rfbClientFilter` drops input from view-only viewers

## Design System

Monochrome palette with glassy effects:
- Base colors: `clouddesk-black` (#000000) through `clouddesk-white` (#ffffff)
- Status colors only for indicators: success (#10b981), error (#ef4444), warning (#f59e0b), info (#3b82f6)
- Glass effects: `bg-white/5 backdrop-blur-md border border-white/10`

## Key Patterns

### API Response Format
```typescript
// Success
{ success: true, data: { ... } }

// Error
{ success: false, error: { message: string, code: string } }
```

### JWT Authentication
- Access Token: 15min expiry (`JWT_ACCESS_EXPIRY`, default `15m`)
- Refresh Token: 7 days, with version tracking for invalidation
- Sliding session via token refresh

### Credential Security
- Frontend encrypts SSH keys/passwords with the user's account password (Web Crypto: PBKDF2-SHA256 100k + AES-256-GCM) and sends the password along; the backend verifies both the password and that the blob decrypts, then wraps it in server-side AES-256
- **Not zero-knowledge**: to connect (and for every instance tool), the client sends the account password and the server decrypts the credential in memory. Never log request bodies
- Changing the account password re-encrypts all stored credentials (`authService.changePassword`)
- Credentials stored without the password layer (old quick-edit bug) still work and are upgraded on the next successful connect

### SSH/VNC Flow (in-process, current)
1. `POST /api/sessions/connect` checks the account password, decrypts the credential, opens SSH
2. Provisions VNC if missing, starts it on `-localhost` (`-SecurityTypes None -AlwaysShared`), opens a local SSH tunnel (6000-7000)
3. The browser connects to `wss://<api>/vnc?sessionId=...&token=<JWT>`; `vncProxy` authorizes owner or invited viewer and hands the socket to the session's `SessionBridge`
4. Each viewer gets its own RFB connection through the tunnel; view-only input is filtered, kick/permission changes apply live
5. Connected viewers keep the session active; after `SESSION_TIMEOUT_MINUTES` without any viewer, cleanup stops VNC and closes the tunnel
6. `GET /api/sessions/:id/status` tells the viewer whether an auto-reconnect can work

## Backend Server Deployment

### Server Credentials
- **SSH Key**: `backend/CloudDesk.pem`
- **IP Address**: 54.156.134.142
- **Domain**: cldesk.duckdns.org
- **Username**: ubuntu
- **Working Directory**: `~/clouddesk`
- **Credentials File**: `backend/Backend_Server_Credentials.txt`

### Deploy Backend Changes
After making backend changes, deploy to the server (runs in Docker):

```bash
# 1. Build locally first to verify no TypeScript errors
cd backend && npm run build

# 2. SCP the backend source code to the server
scp -i backend/CloudDesk.pem -r backend/src ubuntu@54.156.134.142:~/clouddesk/

# 3. SSH into the server and rebuild Docker container
ssh -i backend/CloudDesk.pem ubuntu@54.156.134.142 "cd ~/clouddesk && docker compose up -d --build backend"
```

### Quick Deployment Commands (from project root)
```bash
# Deploy and rebuild (one-liner)
scp -i backend/CloudDesk.pem -r backend/src ubuntu@54.156.134.142:~/clouddesk/ && ssh -i backend/CloudDesk.pem ubuntu@54.156.134.142 "cd ~/clouddesk && docker compose up -d --build backend"

# SSH into server
ssh -i backend/CloudDesk.pem ubuntu@54.156.134.142

# Check backend logs
ssh -i backend/CloudDesk.pem ubuntu@54.156.134.142 "docker logs clouddesk-backend --tail 50"

# Check all container status
ssh -i backend/CloudDesk.pem ubuntu@54.156.134.142 "cd ~/clouddesk && docker compose ps"
```

### Server URLs
- Production API: https://cldesk.duckdns.org (SSL via Certbot/Let's Encrypt)
- Health Check: https://cldesk.duckdns.org/api/health

## Key Files

### Frontend
- `lib/utils/crypto.ts` - Client-side encryption utilities
- `lib/stores/` - Zustand stores for state management
- `components/ui/InfoPanel.tsx` - Contextual help panels
- `components/instances/InstanceForm.tsx` - Instance creation with encryption

### Backend
- `backend/docker-compose.prod.yml` - Production container orchestration
- `backend/src/services/sessionService.ts` - Session lifecycle
- `backend/src/websocket/` - VNC WebSocket proxy, per-viewer bridge, RFB input filter
- `backend/src/services/licenseService.ts` - License validation and tier limits
- `backend/src/admin/` - Server-rendered admin dashboard (escape user data with `escapeHtml`)
- `backend/src/services/redis/sessionRegistry.ts` - Redis session state
- `backend/session-controller/` - Container orchestration (not wired in)
- `backend/session-worker/` - Per-session VNC proxy (not wired in)

### API Endpoints

#### Sessions
- `POST /api/sessions/connect` - Start VNC session
- `POST /api/sessions/disconnect/:id` - End session
- `GET /api/sessions/active` - Get active sessions
- `GET /api/sessions/history` - Session history with pagination
- `GET /api/sessions/stats` - Session statistics
- `POST /api/sessions/disconnect-all` - Disconnect all sessions
- `GET /api/sessions/:id/status` - Whether the session can be reconnected to
- Collaboration: `POST /:id/invite`, `GET /:id/invites`, `POST /join/:token`, `GET /invite-info/:token`, `GET /:id/viewers`, `PATCH|DELETE /:id/viewers/:viewerId`, `POST /:id/collaboration`
- Clipboard: `POST /:id/clipboard/get`, `POST /:id/clipboard` (display comes from the session record)

#### Users
- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update user profile
- `DELETE /api/users/account` - Delete account and all data (requires password + "DELETE" confirmation)

#### Instances
- `GET /api/instances` - List all instances
- `POST /api/instances` - Create instance
- `GET /api/instances/:id` - Get instance
- `PUT /api/instances/:id` - Update instance
- `DELETE /api/instances/:id` - Delete instance
- `POST /api/instances/:id/test-connection` - Test SSH connection (body: `{ password }`)
- Instance tools (all take the account password in the body): `preflight`, `software/*`, `files/*` (SFTP), `database/*`, `terminal/execute`, `port-forward/*`

#### Other
- `GET /api/license` - Current tier, limits and features (public)
- `GET /api/health` - Health check

#### Auth
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh` - Refresh tokens
- `GET /api/auth/me` - Get current user
- `POST /api/auth/change-password` - Change password