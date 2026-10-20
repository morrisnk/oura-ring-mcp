# Oura MCP Server

[![npm version](https://img.shields.io/npm/v/oura-ring-mcp.svg)](https://www.npmjs.com/package/oura-ring-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![CI](https://github.com/mitchhankins01/oura-ring-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mitchhankins01/oura-ring-mcp/actions/workflows/ci.yml)

An MCP server that connects your Oura Ring to Claude and other AI assistants. Get human-readable insights about your sleep, readiness, and activity—not just raw JSON.

## Features

<img src="docs/outputs/demo.gif" width="500" alt="Demo">

- **Smart formatting** - Durations in hours/minutes, scores with context ("85 - Optimal")
- **Sleep analysis** - Sleep stages, efficiency, HRV, and biometrics
- **Readiness tracking** - Recovery scores and contributor breakdown
- **Activity data** - Steps, calories, and intensity breakdown
- **Health metrics** - Heart rate, SpO2, stress, cardiovascular age
- **Smart analysis** - Anomaly detection, correlations, trend analysis
- **Tags support** - Compare metrics with/without conditions

[See example outputs](docs/outputs/EXAMPLES.md) — what Claude returns for sleep, readiness, weekly summaries, and smart analysis

## Quick Start

### 1. Install

```bash
npm install -g oura-ring-mcp
```

Or use directly with npx (no install needed):
```bash
npx oura-ring-mcp
```

### 2. Authenticate with Oura

Oura personal access tokens are deprecated. Use the authorization-code OAuth flow with PKCE:

1. Create an app at [Oura OAuth Applications](https://cloud.ouraring.com/oauth/applications).
2. Register the exact redirect URI `http://localhost:3000/callback`.
3. Stop any server using the same credentials, then authorize:

   ```bash
   export OURA_CLIENT_ID=your_client_id
   export OURA_CLIENT_SECRET=your_client_secret
   export OURA_REDIRECT_URI=http://localhost:3000/callback
   npx oura-ring-mcp auth
   ```

Credentials are saved to `~/.oura-mcp/credentials.json`, or `OURA_CREDENTIALS_PATH` if set. The CLI callback must be an HTTP loopback address; custom ports and paths are supported. Keep the client ID and secret configured in the running server so it can refresh tokens.

### 3. Configure Claude Desktop

After authorization, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "oura": {
      "command": "npx",
      "args": ["oura-ring-mcp"],
      "env": {
        "OURA_CLIENT_ID": "your_client_id",
        "OURA_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

The server refreshes tokens before expiry and retries API requests once after a 401. Defaults request `personal daily heartrate workout tag session spo2`; set `OURA_SCOPES` to a space-separated subset if you only use some tools. Oura may grant fewer permissions than requested; a 403 requires checking permissions and authorizing again. The deprecated callback `scope` parameter is not required.

`oura-ring-mcp status` inspects the saved expiry and local configuration; it does not verify access with Oura. `oura-ring-mcp logout` clears the local file. Stop servers first, and revoke the application in your Oura account if you want to withdraw access completely.

### Migrating an existing installation

1. Register the OAuth app and configure the client ID/secret as above.
2. Stop all processes using the same Oura credential pair, including before CLI reauthorization.
3. Run this checkout's `pnpm build` and `node dist/index.js auth`. For a container, set `OURA_CREDENTIALS_PATH` to the host path of the credentials file in its mounted volume.
4. Remove `OURA_PERSONAL_ACCESS_TOKEN` and `OURA_ACCESS_TOKEN` from the server environment, then restart with OAuth configuration.
5. Confirm a data request succeeds, the credentials file is writable, and the service can restart using that file.

`OURA_PERSONAL_ACCESS_TOKEN` is no longer supported. `OURA_ACCESS_TOKEN` remains a temporary, non-refreshing override only when neither OAuth client setting is configured. It must contain a currently valid bearer token; OAuth configuration takes precedence. New deployments should use OAuth.

Only one process may own a credential pair. Refresh tokens rotate and are single-use. Persist the credentials **directory** on a durable volume so atomic file replacement works; do not bind-mount only the JSON file. Explicit transient refresh failures receive up to three background retries. Rejected credentials or an unknown exchange outcome require reauthorization; token requests are not blindly replayed after network failure. Failed disk writes retain the rotated pair in memory and retry saving it; fix storage before restarting the process.

Restart Claude Desktop. Requires Node >=18.

## What Can I Ask?

**Daily check-ins:**
- "How did I sleep last night?"
- "Am I recovered enough to work out today?"
- "What's my body telling me right now?"

**Patterns & trends:**
- "Do I sleep better on weekends?"
- "What time should I go to bed for optimal sleep?"
- "Is my HRV improving or declining?"

**Correlations & insights:**
- "Does alcohol affect my sleep quality?"
- "What predicts my best sleep nights?"
- "How does exercise timing affect my recovery?"

**Comparisons:**
- "Compare my sleep this week vs last week"
- "How do I sleep after meditation vs without?"
- "What changed when I started taking magnesium?"

**Anomalies:**
- "Are there any unusual readings in my data?"
- "Why was my readiness so low yesterday?"
- "Find days where my metrics were off"

## Available Tools

### Data Retrieval

| Tool | Description |
|------|-------------|
| `get_sleep` | Sleep data with stages, efficiency, HR, HRV |
| `get_daily_sleep` | Daily sleep scores with contributors |
| `get_readiness` | Readiness scores and recovery metrics |
| `get_activity` | Steps, calories, intensity breakdown |
| `get_workouts` | Workout sessions with type and intensity |
| `get_sessions` | Meditation and relaxation sessions |
| `get_heart_rate` | HR readings throughout the day |
| `get_stress` | Stress levels and recovery time |
| `get_spo2` | Blood oxygen and breathing disturbance |
| `get_tags` | User-created tags and notes |

### Smart Analysis

| Tool | Description |
|------|-------------|
| `detect_anomalies` | Find unusual readings using outlier detection |
| `analyze_sleep_quality` | Sleep analysis with trends, patterns, debt |
| `correlate_metrics` | Find correlations between health metrics |
| `compare_periods` | Compare this week vs last week |
| `compare_conditions` | Compare metrics with/without a tag |
| `best_sleep_conditions` | What predicts your good vs poor sleep |
| `analyze_hrv_trend` | HRV trend with rolling averages |

## Resources

| Resource | Description |
|----------|-------------|
| `oura://today` | Today's health summary |
| `oura://weekly-summary` | Last 7 days with averages |
| `oura://baseline` | Your 30-day averages and normal ranges |
| `oura://monthly-insights` | 30-day analysis with trends and anomalies |
| `oura://tag-summary` | Your tags and usage frequency |

## Prompts

| Prompt | Description |
|--------|-------------|
| `weekly-review` | Comprehensive weekly health review |
| `sleep-optimization` | Identify what leads to your best sleep |
| `recovery-check` | Should you train hard or rest today? |
| `compare-weeks` | This week vs last week comparison |
| `tag-analysis` | How a specific tag affects your health |

## Remote Deployment (Railway)

Deploy the MCP server for remote access. The server proxies OAuth through Oura, so you authorize access directly with your Oura account.

This is a **single-owner service**. All accepted MCP clients share one Oura account. Restrict access to trusted clients; this implementation does not isolate multiple users. MCP OAuth registrations and MCP-issued tokens are in memory, so reconnect clients after a server restart. If saved Oura credentials are rejected, this mode keeps the consent endpoints available so you can authorize again. Oura credentials are persisted separately. Run one instance per credential pair.

### 1. Create an Oura OAuth App

1. Go to [Oura OAuth Applications](https://cloud.ouraring.com/oauth/applications)
2. Create a new application
3. Set the **Redirect URI** to: `https://your-app.railway.app/oauth/callback`
4. Note the **Client ID** and **Client Secret**

### 2. Deploy

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login, init, and deploy
railway login
railway init
railway up
```

### 3. Set Environment Variables

In the Railway dashboard, add:

| Variable | Description |
|----------|-------------|
| `OURA_CLIENT_ID` | From your Oura OAuth app |
| `OURA_CLIENT_SECRET` | From your Oura OAuth app |
| `NODE_ENV` | `production` |
| `MCP_SECRET` | *(Optional)* Static bearer token for Claude Desktop (`openssl rand -base64 32`) |
| `MCP_AUTH_MODE` | *(Optional)* Set to `static` for bearer-only auth with server-managed Oura OAuth (see below) |
| `OURA_REFRESH_TOKEN` | *(Optional)* Initial seed only when no saved credentials exist; prefer saving the full pair with the CLI |
| `OURA_CREDENTIALS_PATH` | File path for persisted Oura credentials; mount its parent directory on a durable volume in either HTTP mode |
| `OURA_SCOPES` | Optional space-separated Oura permissions; defaults listed above |

Railway automatically sets `PORT` and `RAILWAY_PUBLIC_DOMAIN`.

#### Static bearer + server-managed Oura OAuth (`MCP_AUTH_MODE=static`)

Use this for agents (e.g. Hermes) that authenticate with a static bearer token but where the server manages Oura OAuth token refresh. Works on any Docker host (Railway, unraid, self-hosted, etc.).

- MCP clients authenticate with `Authorization: Bearer $MCP_SECRET`. The public MCP OAuth 2.1 endpoints (`/authorize`, `/token`, `/register`) are **not** mounted.
- The server holds a long-running Oura OAuth session, refreshing in the background and persisting the rotated refresh token to `OURA_CREDENTIALS_PATH`.
- Required env: `MCP_SECRET`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, and either `OURA_REFRESH_TOKEN` (first run) or pre-seeded credentials at `OURA_CREDENTIALS_PATH`.
- Mount a persistent volume so the rotating refresh token survives restarts. Examples:
  - Docker (unraid/self-hosted): `-v /mnt/user/appdata/oura-mcp:/data` with `OURA_CREDENTIALS_PATH=/data/credentials.json`
  - Railway: attach a volume at `/data`, set `OURA_CREDENTIALS_PATH=/data/credentials.json`

If startup reports `Token refresh failed: 400`, Oura rejected the refresh request. Check that `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` belong to the OAuth app that issued the token. Oura refresh tokens are single-use, so an old `OURA_REFRESH_TOKEN` cannot be reused after the server rotates it; the latest credentials must be saved on the persistent volume. Stop other server instances using the same credentials before recovering.

To recover, run this build's `node dist/index.js auth` on a machine with a browser, using that same OAuth app and a registered local callback URL. Set `OURA_CREDENTIALS_PATH` to the **host path** of the mounted credentials file so the CLI writes the new token pair directly to the volume, then restart the container. If you instead supply a new `OURA_REFRESH_TOKEN`, move any stale credentials file aside first: stored credentials take precedence over the seed. `OURA_ACCESS_TOKEN` does not bypass OAuth in `MCP_AUTH_MODE=static`.

### 4. Connect from Claude.ai

Use the **connector** in Claude.ai:
1. Go to Settings > MCP Connectors > Add
2. Enter your server URL: `https://your-app.railway.app` (without `/mcp`)
3. Leave OAuth Client ID and Secret empty (dynamic registration handles it)
4. You'll be redirected to Oura to authorize access to your data

### 5. Connect from Claude Desktop

For Claude Desktop, configure static mode with server-managed Oura OAuth as above, then use `MCP_SECRET` in the client:

```json
{
  "mcpServers": {
    "oura-remote": {
      "url": "https://your-app.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your_mcp_secret_here"
      }
    }
  }
}
```

### Local Testing

```bash
# With Oura OAuth (full flow)
OURA_CLIENT_ID=your_id OURA_CLIENT_SECRET=your_secret pnpm start:http

# With server-managed Oura OAuth (authorize first, keep OAuth app env configured)
MCP_AUTH_MODE=static MCP_SECRET=test-secret pnpm start:http

# Verify health endpoint
curl http://localhost:3000/health

# Check OAuth metadata (only available when OURA_CLIENT_ID is set)
curl http://localhost:3000/.well-known/oauth-authorization-server

# Test authenticated request (with static secret)
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":1}'
```

## Contributing

See [CLAUDE.md](CLAUDE.md) for architecture details and development guidelines.

## License

MIT
