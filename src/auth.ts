// Main authentication module that re-exports and orchestrates the modular components
import { initializeOAuth2Client } from './auth/client.js';
import { AuthServer } from './auth/server.js';
import { TokenManager } from './auth/tokenManager.js';
import { tokenStore } from './auth/tokenStore.js';
import { accountManager } from './auth/accountManager.js';
import {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig,
  createExternalOAuth2Client,
} from './auth/externalAuth.js';

export { TokenManager } from './auth/tokenManager.js';
export { TokenStore, tokenStore } from './auth/tokenStore.js';
export { AccountManager, accountManager } from './auth/accountManager.js';
export { initializeOAuth2Client } from './auth/client.js';
export { AuthServer } from './auth/server.js';
export { SCOPE_ALIASES, SCOPE_PRESETS, DEFAULT_SCOPES, resolveOAuthScopes } from './auth/scopes.js';
export {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig,
  createExternalOAuth2Client,
} from './auth/externalAuth.js';

/**
 * Authenticate and return OAuth2 client for the default account.
 * This is the main entry point for authentication in the MCP server.
 */
export async function authenticate(): Promise<any> {
  console.error('Initializing authentication...');

  // Priority 1: Service account
  if (isServiceAccountMode()) {
    return await createServiceAccountAuth();
  }

  // Priority 2: External OAuth tokens
  if (isExternalTokenMode()) {
    validateExternalTokenConfig();
    return createExternalOAuth2Client();
  }

  // Priority 3: Local OAuth flow with multi-account token store

  // Migrate legacy single-account tokens on first run
  await tokenStore.migrateFromLegacy();

  // Check if we already have at least one account
  const existingEmails = await tokenStore.listEmails();
  if (existingEmails.length > 0) {
    const defaultEmail = await tokenStore.getDefaultAccount() || existingEmails[0];
    console.error(`Authentication successful – using existing account: ${defaultEmail}`);
    return await accountManager.getAuthClientForAccount(defaultEmail);
  }

  // No valid tokens, need to authenticate
  console.error('\n🔐 No valid authentication tokens found.');
  console.error('Starting authentication flow...\n');

  const oauth2Client = await initializeOAuth2Client();
  const authServer = new AuthServer(oauth2Client);
  const authSuccess = await authServer.start(true);

  if (!authSuccess) {
    throw new Error('Authentication failed. Please check your credentials and try again.');
  }

  // Wait for authentication to complete
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(async () => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(checkInterval);
        await authServer.stop();
        resolve();
      }
    }, 1000);
  });

  // Return client for the newly authenticated account
  const email = authServer.lastAuthenticatedEmail;
  if (email) {
    return await accountManager.getAuthClientForAccount(email);
  }

  // Fallback: return the base oauth2Client
  return oauth2Client;
}

/**
 * Manual authentication command
 * Used when running "npm run auth" or when the user needs to re-authenticate
 */
export async function runAuthCommand(): Promise<void> {
  try {
    console.error('Google Drive MCP - Manual Authentication');
    console.error('════════════════════════════════════════\n');

    const oauth2Client = await initializeOAuth2Client();
    const authServer = new AuthServer(oauth2Client);

    const success = await authServer.start(true);

    if (!success && !authServer.authCompletedSuccessfully) {
      console.error(
        "Authentication failed. Could not start server or validate existing tokens. Check port availability (3000-3004) and try again."
      );
      process.exit(1);
    } else if (authServer.authCompletedSuccessfully) {
      const email = authServer.lastAuthenticatedEmail;
      console.error(`\n✅ Authentication successful!${email ? ` Account: ${email}` : ''}`);
      console.error("You can now use the Google Drive MCP server.");
      process.exit(0);
    }

    console.error(
      "Authentication server started. Please complete the authentication in your browser..."
    );

    const intervalId = setInterval(() => {
      if (authServer.authCompletedSuccessfully) {
        clearInterval(intervalId);
        const email = authServer.lastAuthenticatedEmail;
        console.error(`\n✅ Authentication completed successfully!${email ? ` Account: ${email}` : ''}`);
        console.error("You can now use the Google Drive MCP server.");
        process.exit(0);
      }
    }, 1000);
  } catch (error) {
    console.error("\n❌ Authentication failed:", error);
    process.exit(1);
  }
}
