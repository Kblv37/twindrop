# Twindrop

Twindrop is a browser-based peer-to-peer file transfer app built on WebRTC DataChannels. The backend provides room creation, signaling, validation, rate limiting, and runtime client config. The frontend is a static vanilla JavaScript app that connects directly to the signaling server and transfers files browser-to-browser.

## Project overview

### What it does

- Creates short-lived 6-digit rooms for two participants
- Uses Socket.IO for signaling only
- Transfers files directly over WebRTC
- Supports configurable STUN/TURN servers
- Applies input validation, CORS controls, payload limits, and basic abuse protection

### Repository structure

```text
.
├── public/                  # Static frontend for Netlify or local static hosting
│   ├── index.html           # Receive page
│   ├── send.html            # Send page
│   ├── app-config.js        # Generated runtime frontend config
│   └── js/
│       ├── core/            # Shared frontend modules
│       └── pages/           # Page entry points
├── scripts/
│   ├── load-env.js
│   ├── write-client-config.js
│   └── serve-static.js
├── src/server/              # Express + Socket.IO backend
├── test/                    # Node test files
├── server.js                # Backend entry point
├── render.yaml              # Render deployment template
└── netlify.toml             # Netlify deployment template
```

### Frontend and backend split

- **Frontend**: static files in `public/`
- **Backend**: Node.js app in `server.js` + `src/server/`
- **Connection flow**:
  1. Receiver creates a room through the backend API
  2. Both clients join the room over Socket.IO
  3. SDP and ICE are exchanged through the signaling server
  4. Files move directly between browsers over WebRTC

## Local development

### Prerequisites

- Node.js 20+ recommended
- npm 10+ recommended

### Install dependencies

```bash
npm install
```

### Environment variables

Copy the example file and adjust values for your local setup:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

The local backend and helper scripts automatically load variables from `.env`.

Important local values:

- `TWINDROP_SIGNALING_URL=http://localhost:3000`
- `TWINDROP_FRONTEND_URL=http://127.0.0.1:4173` if you run the frontend separately
- `TWINDROP_FRONTEND_ORIGINS=http://127.0.0.1:4173,http://localhost:4173`

If you run the frontend through the backend only, you can also use:

- `TWINDROP_FRONTEND_URL=http://localhost:3000`
- `TWINDROP_FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000`

### Run the backend locally

```bash
npm run dev:backend
```

The backend listens on:

- `http://127.0.0.1:3000`
- WebSocket / Socket.IO path: `/socket.io`

### Run the frontend locally

This project supports two practical local modes.

#### Option A: simplest local run

Run only the backend:

```bash
npm start
```

Then open:

- `http://127.0.0.1:3000/`

In this mode, Express serves the frontend from `public/`.

#### Option B: frontend and backend on separate local origins

Start the backend in one terminal:

```bash
npm run dev:backend
```

Start the static frontend in another terminal:

```bash
npm run dev:frontend
```

This serves the frontend at:

- `http://127.0.0.1:4173`

`npm run dev:frontend` automatically regenerates `public/app-config.js` before starting the static server.

### How to test locally

1. Start the backend
2. Open the receive page:
   - `http://127.0.0.1:3000/` or `http://127.0.0.1:4173/`
3. Copy the room code
4. Open the send page in another browser tab or device:
   - `http://127.0.0.1:3000/send.html` or `http://127.0.0.1:4173/send.html`
5. Join the room and send a small test file
6. Confirm the file appears on the receive page

### Run tests

```bash
npm test
```

### Useful local endpoints

- Health check: `GET /api/health`
- Client config: `GET /api/client-config`
- Room create: `POST /api/rooms`
- Room lookup: `GET /api/rooms/:code`

## Backend deployment on Render

### Recommended Render setup

This repo includes `render.yaml`:

- `D:\projects\web\twindropCodex\twindrop\render.yaml:1`

You can use Blueprint deploy or create the service manually.

### Manual Render deployment steps

1. Push the repository to GitHub/GitLab
2. In Render, click **New +** → **Web Service**
3. Connect the repository
4. Use these settings:
   - **Runtime**: Node
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Root Directory**: repository root
5. Set the environment variables listed below
6. Deploy

### Required Render environment variables

At minimum, set:

- `NODE_ENV=production`
- `TWINDROP_FRONTEND_URL=https://your-site.netlify.app`
- `TWINDROP_FRONTEND_ORIGINS=https://your-site.netlify.app`
- `TWINDROP_SIGNALING_URL=https://your-render-service.onrender.com` if you also want generated frontend config from this backend deployment

Recommended:

- `TWINDROP_LOG_LEVEL=info`
- `TWINDROP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"turn-user","credential":"turn-password"}]`

### Render notes

- Render provides `PORT`; do not hardcode it
- The server already binds to `0.0.0.0`
- CORS is controlled by `TWINDROP_FRONTEND_ORIGINS` and `TWINDROP_FRONTEND_URL`
- Socket.IO runs on the same service and same origin as the backend
- No extra websocket configuration is needed beyond exposing the Render web service publicly

### Render CORS / origin checklist

If your Netlify site is:

```text
https://twindrop-example.netlify.app
```

then set:

```text
TWINDROP_FRONTEND_URL=https://twindrop-example.netlify.app
TWINDROP_FRONTEND_ORIGINS=https://twindrop-example.netlify.app
```

If you use a custom frontend domain, include that exact origin instead.

## Frontend deployment on Netlify

### Recommended Netlify setup

This repo includes `netlify.toml`:

- `D:\projects\web\twindropCodex\twindrop\netlify.toml:1`

Netlify builds the static frontend from `public/`.

### Manual Netlify deployment steps

1. Push the repository to GitHub/GitLab
2. In Netlify, click **Add new site** → **Import an existing project**
3. Connect the repository
4. Use these settings:
   - **Base directory**: leave empty
   - **Build command**: `npm run build`
   - **Publish directory**: `public`
5. Add the frontend environment variables below
6. Deploy

### Required Netlify environment variables

Set these in **Site configuration → Environment variables**:

- `TWINDROP_SIGNALING_URL=https://your-render-service.onrender.com`
- `TWINDROP_FRONTEND_URL=https://your-site.netlify.app`

Then trigger a new deploy.

### How frontend config generation works

The frontend does not hardcode backend URLs in page code.

During build:

- `npm run build`
- calls `node scripts/write-client-config.js`
- which generates `public/app-config.js`

That file is loaded by `public/index.html` and `public/send.html`.

### Make the frontend point to the Render backend

Set:

```text
TWINDROP_SIGNALING_URL=https://your-render-service.onrender.com
TWINDROP_FRONTEND_URL=https://your-site.netlify.app
```

Then redeploy Netlify.

### Netlify publish output

After build, Netlify publishes:

- `public/index.html`
- `public/send.html`
- `public/app-config.js`
- `public/js/**`
- `public/styles.css`

## Environment variables

### Required for most deployments

| Name | Purpose | Example value | Where to set |
|---|---|---|---|
| `NODE_ENV` | Enables production behavior and logging defaults | `production` | Render |
| `TWINDROP_FRONTEND_URL` | Canonical frontend origin used for CORS and generated client links | `https://twindrop-example.netlify.app` | Render, Netlify |
| `TWINDROP_FRONTEND_ORIGINS` | Comma-separated allowed browser origins for CORS | `https://twindrop-example.netlify.app` | Render |
| `TWINDROP_SIGNALING_URL` | Backend base URL written into generated frontend config | `https://twindrop-api.onrender.com` | Netlify, optional on Render |

### Common optional variables

| Name | Purpose | Example value | Where to set |
|---|---|---|---|
| `PORT` | HTTP port for backend | `3000` | Local, Render auto-provides |
| `HOST` | Bind address | `0.0.0.0` | Local |
| `TWINDROP_LOG_LEVEL` | Backend log verbosity | `info` | Local, Render |
| `TWINDROP_ICE_SERVERS` | JSON array of STUN/TURN servers exposed to the client | `[{"urls":["stun:stun.l.google.com:19302"]}]` | Local, Render |
| `TWINDROP_SOCKET_PATH` | Socket.IO path | `/socket.io` | Local, Render |
| `TWINDROP_RECONNECT_ATTEMPTS` | Frontend Socket.IO reconnect attempts | `4` | Local, Render |
| `FRONTEND_HOST` | Host used by the local static frontend server | `127.0.0.1` | Local only |
| `FRONTEND_PORT` | Port used by the local static frontend server | `4173` | Local only |

### Security / limit variables

| Name | Purpose | Example value | Where to set |
|---|---|---|---|
| `TWINDROP_MAX_HTTP_PAYLOAD_BYTES` | Max Express request payload size | `16384` | Local, Render |
| `TWINDROP_MAX_SOCKET_PAYLOAD_BYTES` | Max Socket.IO payload size | `24576` | Local, Render |
| `TWINDROP_MAX_SIGNAL_PAYLOAD_BYTES` | Max normalized SDP/ICE payload size | `12288` | Local, Render |
| `TWINDROP_MAX_FILE_SIZE_BYTES` | Max file size accepted by frontend transfer validation | `2147483648` | Local, Render |
| `TWINDROP_MAX_FILES_PER_TRANSFER` | Max number of files per transfer batch | `10` | Local, Render |

### Room / rate-limit variables

| Name | Purpose | Example value | Where to set |
|---|---|---|---|
| `TWINDROP_ROOM_CODE_LENGTH` | Room code length | `6` | Local, Render |
| `TWINDROP_ROOM_CAPACITY` | Room participant limit | `2` | Local, Render |
| `TWINDROP_ROOM_TTL_MS` | Active room TTL setting loaded by backend config | `3600000` | Local, Render |
| `TWINDROP_EMPTY_ROOM_TTL_MS` | Time before empty rooms are cleaned up | `900000` | Local, Render |
| `TWINDROP_CLEANUP_INTERVAL_MS` | Cleanup interval for stale empty rooms | `60000` | Local, Render |
| `TWINDROP_REQUEST_WINDOW_MS` | Window used for HTTP and socket rate limiting | `60000` | Local, Render |
| `TWINDROP_ROOM_CREATE_LIMIT` | Room create requests allowed per window | `30` | Local, Render |
| `TWINDROP_ROOM_CHECK_LIMIT` | Room lookup requests allowed per window | `120` | Local, Render |
| `TWINDROP_SOCKET_JOIN_LIMIT` | Join-room socket events allowed per window | `20` | Local, Render |
| `TWINDROP_SOCKET_SIGNAL_LIMIT` | Signal socket events allowed per window | `240` | Local, Render |

### Frontend chunk-size variable

| Name | Purpose | Example value | Where to set |
|---|---|---|---|
| `TWINDROP_ALLOWED_CHUNK_SIZES` | Comma-separated list of file chunk sizes shown in the sender UI | `16384,65536,131072,262144,524288` | Local, Render |

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `npm install` | Installs dependencies | First-time setup |
| `npm run build` | `node scripts/write-client-config.js` | Generates `public/app-config.js` for frontend deployment |
| `npm run build:client-config` | `node scripts/write-client-config.js` | Regenerates frontend runtime config manually |
| `npm run dev:backend` | `node server.js` | Starts backend locally |
| `npm run dev:frontend` | `node scripts/write-client-config.js && node scripts/serve-static.js` | Regenerates frontend config and serves static frontend at `http://127.0.0.1:4173` |
| `npm start` | `node server.js` | Production-style backend start; also serves frontend from `public/` |
| `npm test` | `node --test --test-concurrency=1 --test-isolation=none test/server.test.js` | Runs backend validation tests |

## Deployment-related files

These files may need to be reviewed or configured when deploying:

- `D:\projects\web\twindropCodex\twindrop\.env.example:1`
- `D:\projects\web\twindropCodex\twindrop\public\app-config.js:1`
- `D:\projects\web\twindropCodex\twindrop\scripts\write-client-config.js:1`
- `D:\projects\web\twindropCodex\twindrop\render.yaml:1`
- `D:\projects\web\twindropCodex\twindrop\netlify.toml:1`
- `D:\projects\web\twindropCodex\twindrop\src\server\config.js:1`

## Troubleshooting

### CORS errors

Symptoms:

- Browser blocks API or Socket.IO requests
- `origin-not-allowed`
- polling/websocket upgrade fails

Fix:

- Make sure `TWINDROP_FRONTEND_URL` matches the real frontend origin
- Make sure `TWINDROP_FRONTEND_ORIGINS` includes the exact Netlify origin
- Redeploy Render after changing backend env vars

### Backend not reachable

Symptoms:

- `fetch` to `/api/client-config` fails
- room creation fails
- health check unavailable

Fix:

- Open `https://your-render-service.onrender.com/api/health`
- Confirm the Render service is deployed and public
- Confirm `TWINDROP_SIGNALING_URL` on Netlify points to the correct Render URL

### Wrong API URL in frontend

Symptoms:

- frontend loads but cannot create or join rooms
- UI points to old backend

Fix:

- Check `TWINDROP_SIGNALING_URL` in Netlify env vars
- Trigger a fresh Netlify deploy
- Inspect the generated `public/app-config.js`

### WebSocket / Socket.IO issues

Symptoms:

- room lookup works but connection stays in reconnect loop
- signaling never completes

Fix:

- Verify Render is serving Socket.IO on the same origin as the API
- Keep `TWINDROP_SOCKET_PATH=/socket.io` unless you changed it in both backend and frontend
- Make sure the browser origin is present in Render CORS env vars

### Netlify build issues

Symptoms:

- deploy succeeds but frontend still points to old backend
- `app-config.js` contains unexpected values

Fix:

- Confirm Netlify build command is `npm run build`
- Confirm publish directory is `public`
- Confirm environment variables are set in Netlify UI
- Redeploy after each env change

### Local split-origin issues

Symptoms:

- backend on `:3000`, frontend on `:4173`, but join/create fails

Fix:

- Set `TWINDROP_FRONTEND_ORIGINS=http://127.0.0.1:4173,http://localhost:4173`
- Run `npm run build:client-config` or `npm run dev:frontend` after changing env vars
