# Docker Usage

This document covers building and running the Google Drive MCP server in Docker
for all supported authentication modes.

---

## Building the Image

```bash
docker build -t google-drive-mcp .
```

TypeScript is compiled inside Docker via a multi-stage build. No local `dist/`
directory or pre-built assets are required — a clean source checkout is
sufficient.

To tag a specific version:

```bash
docker build -t google-drive-mcp:2.2.0 -t google-drive-mcp:latest .
```

---

## Running the Server

### The `-i` flag is required for stdio mode

The default transport is `stdio`. MCP clients communicate with the server by
writing to its stdin and reading from its stdout. Docker closes stdin when `-i`
is omitted, which causes the server to receive EOF and exit immediately.

**Always use `docker run -i` for stdio MCP.**

---

## Auth Mode 1: OAuth2 with Pre-Authenticated Credentials

Use this mode when you have a Google Cloud OAuth2 Desktop App credentials file
(`gcp-oauth.keys.json`) and want the server to manage token storage.

### Step 1 — First-time OAuth flow (interactive, opens a browser)

```bash
docker run -it --rm \
  -v "$HOME/.config/google-drive-mcp:/config" \
  -p 3000:3000 \
  google-drive-mcp auth
```

This starts the OAuth callback server on port 3000. Complete the browser flow;
tokens are written to the mounted `/config` directory on the host.

> If port 3000 is already in use:
> ```bash
> docker run -it --rm \
>   -v "$HOME/.config/google-drive-mcp:/config" \
>   -e GOOGLE_DRIVE_MCP_AUTH_PORT=3001 \
>   -p 3001:3001 \
>   google-drive-mcp auth
> ```

The `gcp-oauth.keys.json` must already exist in the mounted directory. Copy
the example template and fill in your credentials from the Google Cloud Console:

```bash
mkdir -p "$HOME/.config/google-drive-mcp"
cp gcp-oauth.keys.example.json "$HOME/.config/google-drive-mcp/gcp-oauth.keys.json"
# Edit the file and replace YOUR_CLIENT_ID and related fields
```

### Step 2 — Run the MCP server (tokens already present)

```bash
docker run -i --rm \
  -v "$HOME/.config/google-drive-mcp:/config" \
  google-drive-mcp
```

The image already sets these ENV defaults, so no extra `-e` flags are needed:

| Variable | Image default |
|---|---|
| `GOOGLE_DRIVE_OAUTH_CREDENTIALS` | `/config/gcp-oauth.keys.json` |
| `GOOGLE_DRIVE_MCP_TOKEN_PATH` | `/config/tokens.json` |
| `XDG_CONFIG_HOME` | `/config` |

### With a custom config directory

```bash
docker run -i --rm \
  -v "/path/to/my-credentials:/config" \
  google-drive-mcp
```

---

## Auth Mode 2: Service Account

Use this mode for server-to-server access without user interaction. No browser
flow is required.

```bash
docker run -i --rm \
  -v "/path/to/service-account-key.json:/config/sa.json:ro" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/config/sa.json \
  google-drive-mcp
```

The `:ro` mount flag makes the key file read-only inside the container.

---

## Auth Mode 3: External OAuth Tokens via Environment Variables

Use this mode when tokens are managed externally — injected by a secrets manager,
Kubernetes secret, or CI system. No volume mounts are needed.

### Access token only (no auto-refresh)

```bash
docker run -i --rm \
  -e GOOGLE_DRIVE_MCP_ACCESS_TOKEN="ya29.your-access-token" \
  google-drive-mcp
```

### Access token with auto-refresh

```bash
docker run -i --rm \
  -e GOOGLE_DRIVE_MCP_ACCESS_TOKEN="ya29.your-access-token" \
  -e GOOGLE_DRIVE_MCP_REFRESH_TOKEN="1//your-refresh-token" \
  -e GOOGLE_DRIVE_MCP_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
  -e GOOGLE_DRIVE_MCP_CLIENT_SECRET="your-client-secret" \
  google-drive-mcp
```

---

## HTTP Transport Mode

Set `MCP_TRANSPORT=http` to switch from stdio to HTTP/SSE. The server listens
on `MCP_HTTP_HOST:MCP_HTTP_PORT` (image defaults: `0.0.0.0:3100`).

```bash
docker run -d --rm \
  -v "$HOME/.config/google-drive-mcp:/config" \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_PORT=3100 \
  -p 3100:3100 \
  google-drive-mcp
```

Do **not** use `-i` in HTTP mode — stdin is not used.

---

## Claude Desktop Integration

Add to your Claude Desktop MCP configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### OAuth2 mode (pre-authenticated — most common)

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/Users/yourname/.config/google-drive-mcp:/config",
        "google-drive-mcp"
      ]
    }
  }
}
```

Replace `/Users/yourname/.config/google-drive-mcp` with the absolute path to
your config directory. Relative paths and `~` are not expanded by Claude Desktop.

### Service Account mode

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/absolute/path/to/service-account-key.json:/config/sa.json:ro",
        "-e", "GOOGLE_APPLICATION_CREDENTIALS=/config/sa.json",
        "google-drive-mcp"
      ]
    }
  }
}
```

### External tokens mode

```json
{
  "mcpServers": {
    "google-drive": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GOOGLE_DRIVE_MCP_ACCESS_TOKEN=ya29.your-access-token",
        "-e", "GOOGLE_DRIVE_MCP_REFRESH_TOKEN=1//your-refresh-token",
        "-e", "GOOGLE_DRIVE_MCP_CLIENT_ID=your-client-id.apps.googleusercontent.com",
        "-e", "GOOGLE_DRIVE_MCP_CLIENT_SECRET=your-client-secret",
        "google-drive-mcp"
      ]
    }
  }
}
```

---

## Environment Variable Reference

| Variable | Image default | Description |
|---|---|---|
| `NODE_ENV` | `production` | Node environment |
| `GOOGLE_DRIVE_OAUTH_CREDENTIALS` | `/config/gcp-oauth.keys.json` | Path to OAuth2 desktop credentials JSON |
| `GOOGLE_DRIVE_MCP_TOKEN_PATH` | `/config/tokens.json` | Path for single-account token storage |
| `XDG_CONFIG_HOME` | `/config` | Base dir for multi-account token storage |
| `GOOGLE_APPLICATION_CREDENTIALS` | _(unset)_ | Path to service account JSON key |
| `GOOGLE_DRIVE_MCP_ACCESS_TOKEN` | _(unset)_ | Pre-obtained OAuth access token |
| `GOOGLE_DRIVE_MCP_REFRESH_TOKEN` | _(unset)_ | OAuth refresh token (enables auto-refresh) |
| `GOOGLE_DRIVE_MCP_CLIENT_ID` | _(unset)_ | OAuth client ID (required with refresh token) |
| `GOOGLE_DRIVE_MCP_CLIENT_SECRET` | _(unset)_ | OAuth client secret (required with refresh token) |
| `GOOGLE_DRIVE_MCP_SCOPES` | _(unset)_ | Comma-separated scope aliases (drive, documents, etc.) |
| `MCP_TRANSPORT` | `stdio` | Transport protocol: `stdio` or `http` |
| `MCP_HTTP_PORT` | `3100` | HTTP server port (http transport only) |
| `MCP_HTTP_HOST` | `0.0.0.0` | HTTP server bind host (http transport only) |
| `GOOGLE_DRIVE_MCP_AUTH_PORT` | `3000` | OAuth callback server starting port |

---

## Security Notes

- **Never bake credential files into the image.** Always mount them via `-v`.
- Use `:ro` when mounting files the server only needs to read (credentials JSON,
  service account key).
- The container runs as the non-root `node` user (UID 1000).
- Token files written to `/config` during the OAuth flow will be owned by
  UID 1000. Pre-create the host directory with appropriate permissions:
  ```bash
  mkdir -p "$HOME/.config/google-drive-mcp"
  chmod 700 "$HOME/.config/google-drive-mcp"
  ```
- To verify the container runs as non-root:
  ```bash
  docker run --rm --entrypoint id google-drive-mcp
  # uid=1000(node) gid=1000(node)
  ```
