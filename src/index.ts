#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from 'crypto';
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";
import { initializeOAuth2Client, AuthServer } from './auth.js';
import {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig, createExternalOAuth2Client,
} from './auth.js';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  getExtensionFromFilename,
  escapeDriveQuery,
} from './utils.js';
import type { ToolContext } from './types.js';
import { errorResponse, withAccountParam } from './types.js';
import { AccountManager } from './auth/accountManager.js';
import { DriveClientCache } from './auth/driveClientCache.js';

import * as driveTools from './tools/drive.js';
import * as docsTools from './tools/docs.js';
import * as sheetsTools from './tools/sheets.js';
import * as slidesTools from './tools/slides.js';
import * as calendarTools from './tools/calendar.js';
import * as accountsTools from './tools/accounts.js';

// Module-level singletons
const accountManager = new AccountManager();
const driveClientCache = new DriveClientCache(accountManager);

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

// Get package version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

// -----------------------------------------------------------------------------
// LOGGING UTILITY
// -----------------------------------------------------------------------------
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logMessage = data
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}`
    : `[${timestamp}] ${message}`;
  console.error(logMessage);
}

// -----------------------------------------------------------------------------
// SERVER READINESS
// -----------------------------------------------------------------------------

const SYNTHETIC_SERVICE_ACCOUNT = '__service_account__';
const SYNTHETIC_EXTERNAL_TOKEN = '__external_token__';

let _serverReadyPromise: Promise<void> | null = null;

async function ensureServerReady(): Promise<void> {
  if (_serverReadyPromise) return _serverReadyPromise;
  _serverReadyPromise = (async () => {
    // Migrate old single-account tokens.json → accounts/default/tokens.json
    await accountManager.migrateDefaultAccount();

    if (isServiceAccountMode()) {
      const client = await createServiceAccountAuth();
      driveClientCache.setPrebuiltClient(SYNTHETIC_SERVICE_ACCOUNT, client);
      log('Service account mode initialized');
    } else if (isExternalTokenMode()) {
      validateExternalTokenConfig();
      const client = createExternalOAuth2Client();
      driveClientCache.setPrebuiltClient(SYNTHETIC_EXTERNAL_TOKEN, client);
      log('External token mode initialized');
    }
    // OAuth accounts are loaded lazily by DriveClientCache on first use
  })();
  return _serverReadyPromise;
}

// -----------------------------------------------------------------------------
// ACCOUNT RESOLUTION
// -----------------------------------------------------------------------------

async function resolveAccount(raw: string | undefined): Promise<string> {
  // Non-OAuth modes bypass account registry
  if (isServiceAccountMode()) return SYNTHETIC_SERVICE_ACCOUNT;
  if (isExternalTokenMode()) return SYNTHETIC_EXTERNAL_TOKEN;

  // OAuth mode
  if (raw) {
    // Prebuilt (test-injected) aliases resolve immediately without file I/O
    if (driveClientCache.hasPrebuilt(raw)) return raw;
    const found = await accountManager.getAccount(raw);
    if (!found) {
      const accounts = await accountManager.listAccounts();
      const names = accounts.map((a) => `${a.alias} (${a.email})`).join(', ');
      throw new Error(
        `Account not found: "${raw}".${names ? ` Available: ${names}` : ' No accounts configured — run authenticate_account first.'}`
      );
    }
    return found.alias;
  }

  // No account param — prebuilt aliases take priority (test mode compatibility)
  const prebuiltAliases = driveClientCache.getPrebuiltAliases();
  if (prebuiltAliases.length === 1) return prebuiltAliases[0];

  const accounts = await accountManager.listAccounts();
  // Merge prebuilt + file-based, deduped
  const allAliases = [...new Set([...prebuiltAliases, ...accounts.map((a) => a.alias)])];
  if (allAliases.length === 1) return allAliases[0];
  if (allAliases.length === 0) {
    throw new Error('No accounts configured. Run authenticate_account to add one.');
  }
  const names = [...prebuiltAliases.map((a) => a), ...accounts.map((a) => `${a.alias} (${a.email})`)].join(', ');
  throw new Error(
    `Multiple accounts configured. Specify the "account" parameter. Available: ${names}`
  );
}

// -----------------------------------------------------------------------------
// TOOL CONTEXT FACTORY
// -----------------------------------------------------------------------------

async function buildToolContext(alias: string): Promise<ToolContext> {
  const entry = await driveClientCache.getEntry(alias);
  const { drive, calendar, authClient } = entry;

  async function resolvePath(pathStr: string): Promise<string> {
    if (!pathStr || pathStr === '/') return 'root';

    const parts = pathStr.replace(/^\/+|\/+$/g, '').split('/');
    let currentFolderId: string = 'root';

    for (const part of parts) {
      if (!part) continue;
      const escapedPart = escapeDriveQuery(part);
      const response = await drive.files.list({
        q: `'${currentFolderId}' in parents and name = '${escapedPart}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
        fields: 'files(id)',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });

      if (!response.data.files?.length) {
        const folderMetadata = {
          name: part,
          mimeType: FOLDER_MIME_TYPE,
          parents: [currentFolderId]
        };
        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id',
          supportsAllDrives: true
        });

        if (!folder.data.id) {
          throw new Error(`Failed to create intermediate folder: ${part}`);
        }

        currentFolderId = folder.data.id;
      } else {
        currentFolderId = response.data.files[0].id!;
      }
    }

    return currentFolderId;
  }

  async function resolveFolderId(input: string | undefined): Promise<string> {
    if (!input) return 'root';
    if (input.startsWith('/')) return resolvePath(input);
    return input;
  }

  function validateTextFileExtension(name: string) {
    const ext = getExtensionFromFilename(name);
    if (!['txt', 'md'].includes(ext)) {
      throw new Error("File name must end with .txt or .md for text files.");
    }
  }

  async function checkFileExists(name: string, parentFolderId: string = 'root'): Promise<string | null> {
    try {
      const escapedName = escapeDriveQuery(name);
      const query = `name = '${escapedName}' and '${parentFolderId}' in parents and trashed = false`;

      const res = await drive.files.list({
        q: query,
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      });

      if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id || null;
      }
      return null;
    } catch (error) {
      log('Error checking file existence:', error);
      return null;
    }
  }

  return {
    authClient,
    account: alias,
    google,
    getDrive: () => drive,
    getCalendar: () => calendar,
    log,
    resolvePath,
    resolveFolderId,
    checkFileExists,
    validateTextFileExtension,
    getTokenPath: () => accountManager.getTokensPath(alias),
  };
}

function buildAccountMgmtContext(): ToolContext {
  const noop = () => { throw new Error('Drive not available in account-management context'); };
  return {
    authClient: null,
    account: '',
    google,
    getDrive: noop as any,
    getCalendar: noop as any,
    log,
    resolvePath: async () => { throw new Error('not available'); },
    resolveFolderId: async () => { throw new Error('not available'); },
    checkFileExists: async () => null,
    validateTextFileExtension: () => {},
    getTokenPath: () => '',
    listAccounts: () => accountManager.listAccounts(),
    triggerAuth: async (alias: string, email?: string) => {
      // Ensure the account exists in registry
      const existing = await accountManager.getAccount(alias);
      if (!existing) {
        await accountManager.addAccount(alias, email ?? alias);
      } else if (email && existing.email !== email) {
        await accountManager.addAccount(alias, email);
      }
      const tokenPath = accountManager.getTokensPath(alias);
      const oauth2Client = await initializeOAuth2Client();
      const authServer = new AuthServer(oauth2Client, tokenPath);
      const started = await authServer.start(true);
      if (!started) {
        throw new Error('Failed to start authentication server. Check port availability.');
      }
      driveClientCache.clearEntry(alias);
      if (authServer.authCompletedSuccessfully) {
        return `Account "${alias}" authenticated successfully.`;
      }
      return `Authentication flow started for "${alias}". Complete sign-in in your browser.`;
    },
    removeAccount: async (aliasOrEmail: string) => {
      const account = await accountManager.getAccount(aliasOrEmail);
      if (!account) {
        throw new Error(`Account not found: "${aliasOrEmail}"`);
      }
      await accountManager.removeAccount(account.alias);
      driveClientCache.clearEntry(account.alias);
      return `Account "${account.alias}" removed.`;
    },
  };
}

// -----------------------------------------------------------------------------
// DOMAIN MODULES
// -----------------------------------------------------------------------------
const domainModules = [accountsTools, driveTools, docsTools, sheetsTools, slidesTools, calendarTools];

const ACCOUNT_MGMT_TOOLS = new Set(['list_accounts', 'authenticate_account', 'remove_account']);

// -----------------------------------------------------------------------------
// SERVER FACTORY
// -----------------------------------------------------------------------------

function createMcpServer(): Server {
  const s = new Server(
    {
      name: "google-drive-mcp",
      version: VERSION,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  s.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    await ensureServerReady();
    log('Handling ListResources request', { params: request.params });
    const alias = await resolveAccount(undefined);
    const entry = await driveClientCache.getEntry(alias);
    const drive: drive_v3.Drive = entry.drive;

    const pageSize = 10;
    const params: {
      pageSize: number,
      fields: string,
      pageToken?: string,
      q: string,
      includeItemsFromAllDrives: boolean,
      supportsAllDrives: boolean
    } = {
      pageSize,
      fields: "nextPageToken, files(id, name, mimeType)",
      q: `trashed = false`,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    };

    if (request.params?.cursor) {
      params.pageToken = request.params.cursor;
    }

    const res = await drive.files.list(params);
    log('Listed files', { count: res.data.files?.length });
    const files = res.data.files || [];

    return {
      resources: files.map((file: drive_v3.Schema$File) => ({
        uri: `gdrive:///${file.id}`,
        mimeType: file.mimeType || 'application/octet-stream',
        name: file.name || 'Untitled',
      })),
      nextCursor: res.data.nextPageToken,
    };
  });

  s.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await ensureServerReady();
    log('Handling ReadResource request', { uri: request.params.uri });
    const alias = await resolveAccount(undefined);
    const entry = await driveClientCache.getEntry(alias);
    const drive: drive_v3.Drive = entry.drive;

    const fileId = request.params.uri.replace("gdrive:///", "");

    const file = await drive.files.get({
      fileId,
      fields: "mimeType",
      supportsAllDrives: true
    });
    const mimeType = file.data.mimeType;

    if (!mimeType) {
      throw new Error("File has no MIME type.");
    }

    if (mimeType.startsWith("application/vnd.google-apps")) {
      let exportMimeType;
      switch (mimeType) {
        case "application/vnd.google-apps.document": exportMimeType = "text/markdown"; break;
        case "application/vnd.google-apps.spreadsheet": exportMimeType = "text/csv"; break;
        case "application/vnd.google-apps.presentation": exportMimeType = "text/plain"; break;
        case "application/vnd.google-apps.drawing": exportMimeType = "image/png"; break;
        default: exportMimeType = "text/plain"; break;
      }

      const res = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: "text" },
      );

      log('Successfully read resource', { fileId, mimeType });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: exportMimeType,
            text: res.data,
          },
        ],
      };
    } else {
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      const contentMime = mimeType || "application/octet-stream";

      if (contentMime.startsWith("text/") || contentMime === "application/json") {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              text: Buffer.from(res.data as ArrayBuffer).toString("utf-8"),
            },
          ],
        };
      } else {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: contentMime,
              blob: Buffer.from(res.data as ArrayBuffer).toString("base64"),
            },
          ],
        };
      }
    }
  });

  s.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: domainModules.flatMap(m => m.toolDefinitions).map(def =>
        ACCOUNT_MGMT_TOOLS.has(def.name)
          ? def
          : { ...def, inputSchema: withAccountParam(def.inputSchema) }
      ),
    };
  });

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    await ensureServerReady();
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    log('Handling tool request', { tool: toolName });

    try {
      // Account-management tools get a special context with no Drive/Calendar
      if (ACCOUNT_MGMT_TOOLS.has(toolName)) {
        const ctx = buildAccountMgmtContext();
        for (const mod of domainModules) {
          const result = await mod.handleTool(toolName, args, ctx);
          if (result !== null) return result;
        }
        return errorResponse('Tool not found');
      }

      const alias = await resolveAccount(args.account as string | undefined);
      const ctx = await buildToolContext(alias);

      for (const mod of domainModules) {
        const result = await mod.handleTool(toolName, args, ctx);
        if (result !== null) return result;
      }
      return errorResponse("Tool not found");
    } catch (error) {
      log('Error in tool request handler', { error: (error as Error).message });
      return errorResponse((error as Error).message);
    }
  });

  return s;
}

// Module-level server instance (used by stdio mode and tests)
const server = createMcpServer();

// -----------------------------------------------------------------------------
// CLI FUNCTIONS
// -----------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Google Drive MCP Server v${VERSION}

Usage:
  npx @yourusername/google-drive-mcp [command] [options]

Commands:
  auth [alias]  Run the authentication flow (alias defaults to "default")
  start         Start the MCP server (default)
  version       Show version information
  help          Show this help message

Transport Options:
  --transport <stdio|http>   Transport mode (default: stdio)
  --port <number>            HTTP listen port (default: 3100)
  --host <address>           HTTP bind address (default: 127.0.0.1)

Examples:
  npx @yourusername/google-drive-mcp auth
  npx @yourusername/google-drive-mcp auth work
  npx @yourusername/google-drive-mcp start
  npx @yourusername/google-drive-mcp start --transport http --port 3100
  npx @yourusername/google-drive-mcp version
  npx @yourusername/google-drive-mcp

Environment Variables:
  GOOGLE_DRIVE_OAUTH_CREDENTIALS        Path to OAuth credentials file
  GOOGLE_DRIVE_MCP_TOKEN_PATH           Path to store authentication tokens
  GOOGLE_DRIVE_MCP_AUTH_PORT            Starting port for OAuth callback server (default: 3000, uses 5 consecutive ports)

  Transport Configuration:
  MCP_TRANSPORT                         Transport mode: stdio or http (default: stdio)
  MCP_HTTP_PORT                         HTTP listen port (default: 3100)
  MCP_HTTP_HOST                         HTTP bind address (default: 127.0.0.1)

  Service Account Mode:
  GOOGLE_APPLICATION_CREDENTIALS        Path to service account JSON key file

  External OAuth Token Mode:
  GOOGLE_DRIVE_MCP_ACCESS_TOKEN         Pre-obtained Google OAuth access token
  GOOGLE_DRIVE_MCP_REFRESH_TOKEN        Refresh token for auto-refresh (optional)
  GOOGLE_DRIVE_MCP_CLIENT_ID            OAuth client ID (required with refresh token)
  GOOGLE_DRIVE_MCP_CLIENT_SECRET        OAuth client secret (required with refresh token)
`);
}

function showVersion(): void {
  console.log(`Google Drive MCP Server v${VERSION}`);
}

async function runAuthServer(alias = 'default'): Promise<void> {
  try {
    await accountManager.migrateDefaultAccount();

    // Ensure the account entry exists
    const existing = await accountManager.getAccount(alias);
    if (!existing) {
      await accountManager.addAccount(alias, alias);
    }

    const tokenPath = accountManager.getTokensPath(alias);
    const oauth2Client = await initializeOAuth2Client();
    const authServerInstance = new AuthServer(oauth2Client, tokenPath);
    const success = await authServerInstance.start(true);

    if (!success && !authServerInstance.authCompletedSuccessfully) {
      const { start, end } = authServerInstance.portRange;
      console.error(
        `Authentication failed. Could not start server or validate existing tokens. Check port availability (${start}-${end}) and try again.`
      );
      process.exit(1);
    } else if (authServerInstance.authCompletedSuccessfully) {
      console.log(`Authentication successful for account "${alias}".`);
      process.exit(0);
    }

    console.log(
      "Authentication server started. Please complete the authentication in your browser..."
    );

    const intervalId = setInterval(async () => {
      if (authServerInstance.authCompletedSuccessfully) {
        clearInterval(intervalId);
        await authServerInstance.stop();
        console.log(`Authentication completed successfully for account "${alias}"!`);
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    console.error("Authentication failed:", error);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION
// -----------------------------------------------------------------------------

interface CliArgs {
  command: string | undefined;
  authAlias: string;
  transport: 'stdio' | 'http';
  httpPort: number;
  httpHost: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let command: string | undefined;
  let authAlias = 'default';
  let transport: string | undefined;
  let httpPort: string | undefined;
  let httpHost: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v' || arg === '--help' || arg === '-h') {
      command = arg;
      continue;
    }

    if (arg === '--transport' && i + 1 < args.length) {
      transport = args[++i];
      continue;
    }
    if (arg === '--port' && i + 1 < args.length) {
      httpPort = args[++i];
      continue;
    }
    if (arg === '--host' && i + 1 < args.length) {
      httpHost = args[++i];
      continue;
    }

    if (!command && !arg.startsWith('--')) {
      command = arg;
      continue;
    }

    // Positional after 'auth' is the alias
    if (command === 'auth' && !arg.startsWith('--')) {
      authAlias = arg;
      continue;
    }
  }

  const resolvedTransport = transport || process.env.MCP_TRANSPORT || 'stdio';
  if (resolvedTransport !== 'stdio' && resolvedTransport !== 'http') {
    console.error(`Invalid transport: ${resolvedTransport}. Must be "stdio" or "http".`);
    process.exit(1);
  }

  const resolvedPort = parseInt(httpPort || process.env.MCP_HTTP_PORT || '3100', 10);
  if (isNaN(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    console.error(`Invalid port: ${httpPort || process.env.MCP_HTTP_PORT}. Must be 1-65535.`);
    process.exit(1);
  }

  return {
    command,
    authAlias,
    transport: resolvedTransport,
    httpPort: resolvedPort,
    httpHost: httpHost || process.env.MCP_HTTP_HOST || '127.0.0.1',
  };
}

async function main() {
  const args = parseCliArgs();

  switch (args.command) {
    case "auth":
      await runAuthServer(args.authAlias);
      break;
    case "start":
    case undefined:
      if (args.transport === 'http') {
        await startHttpTransport(args);
      } else {
        await startStdioTransport();
      }
      break;
    case "version":
    case "--version":
    case "-v":
      showVersion();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

async function startStdioTransport(): Promise<void> {
  try {
    console.error("Starting Google Drive MCP server (stdio)...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Server started successfully');

    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface CreateHttpAppOptions {
  sessionIdleTimeoutMs?: number;
}

function createHttpApp(host: string, options?: CreateHttpAppOptions) {
  const idleTimeoutMs = options?.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  const app = createMcpExpressApp({ host });
  const sessions = new Map<string, HttpSession>();
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function resetSessionTimer(sid: string) {
    const existing = sessionTimers.get(sid);
    if (existing) clearTimeout(existing);
    sessionTimers.set(sid, setTimeout(async () => {
      const session = sessions.get(sid);
      if (session) {
        log(`Session idle timeout: ${sid}`);
        await session.transport.close();
        await session.server.close();
        sessions.delete(sid);
      }
      sessionTimers.delete(sid);
    }, idleTimeoutMs));
  }

  function clearSessionTimer(sid: string) {
    const timer = sessionTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      sessionTimers.delete(sid);
    }
  }

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        resetSessionTimer(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: expected initialize request or valid session ID' },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const sessionServer = createMcpServer();

      await sessionServer.connect(transport);

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          clearSessionTimer(sid);
          sessions.delete(sid);
          log(`Session closed: ${sid}`);
        }
      };

      await transport.handleRequest(req, res, req.body);

      const sid = transport.sessionId;
      if (sid) {
        sessions.set(sid, { transport, server: sessionServer });
        resetSessionTimer(sid);
        log(`New session created: ${sid}`);
      }
    } catch (error) {
      log('Error handling POST /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: missing or invalid session ID' },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId)!;
      resetSessionTimer(sessionId);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      log('Error handling GET /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.delete('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: missing or invalid session ID' },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId)!;
      await session.transport.close();
      await session.server.close();
      sessions.delete(sessionId);
      res.status(200).end();
    } catch (error) {
      log('Error handling DELETE /mcp', { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  return { app, sessions };
}

async function startHttpTransport(args: CliArgs): Promise<void> {
  try {
    const { httpPort, httpHost } = args;
    console.error(`Starting Google Drive MCP server (HTTP on ${httpHost}:${httpPort})...`);

    const { app, sessions } = createHttpApp(httpHost);

    const httpServer = app.listen(httpPort, httpHost, () => {
      log(`HTTP server listening on ${httpHost}:${httpPort}`);
    });

    const shutdown = async () => {
      log('Shutting down HTTP server...');
      for (const [sid, session] of sessions) {
        await session.transport.close();
        await session.server.close();
        sessions.delete(sid);
      }
      httpServer.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error('Failed to start HTTP server:', error);
    process.exit(1);
  }
}

// Export server, factory, and main for testing or potential programmatic use
export { main, server, createMcpServer, createHttpApp };

/** Inject a fake auth client for testing — bypasses authenticate(). */
export function _setAuthClientForTesting(client: any, alias = 'default') {
  driveClientCache.setPrebuiltClient(alias, client);
  // Seed account manager so list_accounts works in tests
  accountManager.addAccount(alias, alias).catch(() => {});
}

// Run the CLI (skip when imported by tests)
if (!process.env.MCP_TESTING) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
