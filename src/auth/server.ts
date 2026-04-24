import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { tokenStore } from './tokenStore.js';
import http from 'http';
import open from 'open';
import { loadCredentials } from './client.js';
import { resolveOAuthScopes } from './scopes.js';

const SCOPES = [...resolveOAuthScopes(), 'openid', 'email'];

// Deduplicate scopes
const UNIQUE_SCOPES = [...new Set(SCOPES)];

export class AuthServer {
  private baseOAuth2Client: OAuth2Client;
  private flowOAuth2Client: OAuth2Client | null = null;
  private app: express.Express;
  private server: http.Server | null = null;
  public readonly portRange: { start: number; end: number };
  public authCompletedSuccessfully = false;
  public lastAuthenticatedEmail: string | null = null;

  constructor(oauth2Client: OAuth2Client) {
    this.baseOAuth2Client = oauth2Client;
    this.app = express();
    const raw = process.env.GOOGLE_DRIVE_MCP_AUTH_PORT;
    const portStart = raw ? Number(raw) : 3000;
    if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65531) {
      throw new Error(
        `Invalid GOOGLE_DRIVE_MCP_AUTH_PORT: "${raw}". Must be an integer between 1 and 65531.`
      );
    }
    this.portRange = { start: portStart, end: portStart + 4 };
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // ---- Setup / account management page ----
    this.app.get('/setup', async (_req, res) => {
      const emails = await tokenStore.listEmails();
      const defaultAccount = await tokenStore.getDefaultAccount();
      const storePath = tokenStore.getStorePath();

      const accountRows = emails.length === 0
        ? '<tr><td colspan="3"><em>No accounts connected yet.</em></td></tr>'
        : emails.map(email => {
            const isDefault = email === defaultAccount;
            return `
              <tr>
                <td>${email}${isDefault ? ' <strong>(default)</strong>' : ''}</td>
                <td>
                  ${!isDefault ? `<a href="/set-default?email=${encodeURIComponent(email)}">Set as default</a>` : '—'}
                </td>
                <td>
                  <a href="/remove-account?email=${encodeURIComponent(email)}" onclick="return confirm('Remove ${email}?')">Remove</a>
                </td>
              </tr>`;
          }).join('\n');

      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Google Drive MCP – Account Setup</title>
  <style>
    body { font-family: sans-serif; max-width: 700px; margin: 2em auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5em 1em; text-align: left; }
    th { background: #f0f0f0; }
    .actions { margin-top: 1.5em; }
  </style>
</head>
<body>
  <h1>Google Drive MCP – Account Setup</h1>
  <p>Token store: <code>${storePath}</code></p>

  <h2>Connected accounts</h2>
  <table>
    <thead><tr><th>Email</th><th>Default</th><th>Remove</th></tr></thead>
    <tbody>${accountRows}</tbody>
  </table>

  <div class="actions">
    <a href="/">➕ Add another account</a>
  </div>
</body>
</html>`);
    });

    // ---- Remove account ----
    this.app.get('/remove-account', async (req, res) => {
      const email = req.query.email as string;
      if (!email) { res.status(400).send('Missing email parameter'); return; }
      try {
        await tokenStore.removeAccount(email);
        res.redirect('/setup');
      } catch (err) {
        res.status(500).send(`Failed to remove account: ${err instanceof Error ? err.message : err}`);
      }
    });

    // ---- Set default account ----
    this.app.get('/set-default', async (req, res) => {
      const email = req.query.email as string;
      if (!email) { res.status(400).send('Missing email parameter'); return; }
      try {
        await tokenStore.setDefaultAccount(email);
        res.redirect('/setup');
      } catch (err) {
        res.status(500).send(`Failed to set default: ${err instanceof Error ? err.message : err}`);
      }
    });

    // ---- Auth start page ----
    this.app.get('/', (_req, res) => {
      const clientForUrl = this.flowOAuth2Client || this.baseOAuth2Client;
      const authUrl = clientForUrl.generateAuthUrl({
        access_type: 'offline',
        scope: UNIQUE_SCOPES,
        prompt: 'consent'
      });
      res.send(`<h1>Google Drive MCP – Add Account</h1><a href="${authUrl}">Authenticate with Google</a><br><br><a href="/setup">← Back to setup</a>`);
    });

    // ---- OAuth callback ----
    this.app.get('/oauth2callback', async (req, res) => {
      const code = req.query.code as string;
      if (!code) {
        res.status(400).send('Authorization code missing');
        return;
      }
      if (!this.flowOAuth2Client) {
        res.status(500).send('Authentication flow not properly initiated.');
        return;
      }
      try {
        const { tokens } = await this.flowOAuth2Client.getToken(code);

        // Discover the authenticated email via userinfo endpoint
        let email: string;
        try {
          this.flowOAuth2Client.setCredentials(tokens);
          const userinfoRes = await this.flowOAuth2Client.request<{ email: string }>({
            url: 'https://www.googleapis.com/oauth2/v3/userinfo',
          });
          email = userinfoRes.data.email;
        } catch {
          email = `account-${Date.now()}@unknown.local`;
          console.error('Warning: could not discover email from userinfo, using placeholder:', email);
        }

        // Save tokens to multi-account store
        await tokenStore.saveTokens(email, tokens);
        this.lastAuthenticatedEmail = email;
        this.authCompletedSuccessfully = true;

        const tokenPath = tokenStore.getStorePath();

        res.send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <title>Authentication Successful</title>
              <style>
                  body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                  .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                  h1 { color: #4CAF50; }
                  p { color: #333; margin-bottom: 0.5em; }
                  code { background-color: #eee; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
              </style>
          </head>
          <body>
              <div class="container">
                  <h1>Authentication Successful!</h1>
                  <p>Account <strong>${email}</strong> has been connected.</p>
                  <p>Tokens saved to: <code>${tokenPath}</code></p>
                  <p>You can now close this browser window.</p>
                  <p><a href="/setup">Manage accounts →</a></p>
              </div>
          </body>
          </html>
        `);
      } catch (error: unknown) {
        this.authCompletedSuccessfully = false;
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <title>Authentication Failed</title>
              <style>
                  body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background-color: #f4f4f4; margin: 0; }
                  .container { text-align: center; padding: 2em; background-color: #fff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                  h1 { color: #F44336; }
                  p { color: #333; }
              </style>
          </head>
          <body>
              <div class="container">
                  <h1>Authentication Failed</h1>
                  <p>An error occurred during authentication:</p>
                  <p><code>${message}</code></p>
                  <p>Please try again or check the server logs.</p>
              </div>
          </body>
          </html>
        `);
      }
    });
  }

  async start(openBrowser = true): Promise<boolean> {
    // Fast path: if any accounts exist, consider authentication complete
    const existingEmails = await tokenStore.listEmails();
    if (existingEmails.length > 0) {
      this.authCompletedSuccessfully = true;
      return true;
    }

    // Try to start the server and get the port
    const port = await this.startServerOnAvailablePort();
    if (port === null) {
      this.authCompletedSuccessfully = false;
      return false;
    }

    // Create the flow-specific OAuth client with the correct redirect URI
    try {
      const { client_id, client_secret } = await loadCredentials();
      this.flowOAuth2Client = new OAuth2Client(
        client_id,
        client_secret || undefined,
        `http://localhost:${port}/oauth2callback`
      );
    } catch (error) {
      console.error('Failed to load credentials for auth flow:', error);
      this.authCompletedSuccessfully = false;
      await this.stop();
      return false;
    }

    if (openBrowser) {
      const authorizeUrl = this.flowOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: UNIQUE_SCOPES,
        prompt: 'consent'
      });

      console.error('\n🔐 AUTHENTICATION REQUIRED');
      console.error('══════════════════════════════════════════');
      console.error('\nOpening your browser to authenticate...');
      console.error(`If the browser doesn't open, visit:\n${authorizeUrl}\n`);

      await open(authorizeUrl);
    }

    return true;
  }

  private async startServerOnAvailablePort(): Promise<number | null> {
    for (let port = this.portRange.start; port <= this.portRange.end; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const testServer = this.app.listen(port, () => {
            this.server = testServer;
            console.error(`Authentication server listening on http://localhost:${port}`);
            resolve();
          });
          testServer.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              testServer.close(() => reject(err));
            } else {
              reject(err);
            }
          });
        });
        return port;
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && (error as any).code === 'EADDRINUSE')) {
          console.error('Failed to start auth server:', error);
          return null;
        }
      }
    }
    console.error('No available ports for authentication server (tried ports', this.portRange.start, '-', this.portRange.end, ')');
    return null;
  }

  public getRunningPort(): number | null {
    if (this.server) {
      const address = this.server.address();
      if (typeof address === 'object' && address !== null) {
        return address.port;
      }
    }
    return null;
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            this.server = null;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}
