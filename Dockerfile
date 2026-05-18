# =============================================================================
# Stage 1: Build TypeScript → JavaScript
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /build

# Copy dependency manifests first to maximise layer cache reuse
COPY package*.json ./

# Install all dependencies (devDeps required for tsc + esbuild)
RUN npm ci

# Copy only the files the build needs
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

# Typecheck + compile via esbuild → dist/index.js
RUN npm run build

# =============================================================================
# Stage 2: Minimal production runtime
# =============================================================================
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy manifests and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /build/dist ./dist

# Create the config volume directory and hand ownership to the node user
# (this must be done as root, before USER is switched)
RUN mkdir -p /config && chown node:node /config

# Defaults that can all be overridden at runtime via -e
ENV NODE_ENV=production \
    GOOGLE_DRIVE_OAUTH_CREDENTIALS=/config/gcp-oauth.keys.json \
    GOOGLE_DRIVE_MCP_TOKEN_PATH=/config/tokens.json \
    XDG_CONFIG_HOME=/config \
    MCP_TRANSPORT=stdio \
    MCP_HTTP_PORT=3100 \
    MCP_HTTP_HOST=0.0.0.0 \
    GOOGLE_DRIVE_MCP_AUTH_PORT=3000

# HTTP transport port (only relevant when MCP_TRANSPORT=http)
EXPOSE 3100

# Document /config as the expected mount point for credentials and tokens
VOLUME ["/config"]

# Drop to non-root user — node (UID 1000) is built into node:20-alpine
USER node

# Direct process invocation — no shell wrapper so stdio streams are clean
# MCP clients communicate via stdin/stdout; any wrapper would swallow output
ENTRYPOINT ["node", "dist/index.js"]
