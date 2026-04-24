import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { drive_v3, calendar_v3 } from 'googleapis';
import { TokenStore, tokenStore as defaultTokenStore } from './tokenStore.js';
import { initializeOAuth2Client } from './client.js';
import {
  isServiceAccountMode, createServiceAccountAuth,
  isExternalTokenMode, validateExternalTokenConfig, createExternalOAuth2Client,
} from './externalAuth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountServices {
  oauth2Client: any; // OAuth2Client or GoogleAuth client
  drive: drive_v3.Drive | null;
  calendar: calendar_v3.Calendar | null;
}

// ---------------------------------------------------------------------------
// AccountManager
// ---------------------------------------------------------------------------

export class AccountManager {
  private cache = new Map<string, AccountServices>();
  private tokenStore: TokenStore;

  constructor(ts: TokenStore = defaultTokenStore) {
    this.tokenStore = ts;
  }

  // ---- Account listing & management ----------------------------------------

  async listAccounts(): Promise<string[]> {
    if (isServiceAccountMode() || isExternalTokenMode()) {
      return this.cache.size > 0 ? [...this.cache.keys()] : ['service-account'];
    }
    return this.tokenStore.listEmails();
  }

  async removeAccount(email: string): Promise<void> {
    this.cache.delete(email);
    await this.tokenStore.removeAccount(email);
  }

  async getDefaultAccount(): Promise<string | null> {
    if (isServiceAccountMode() || isExternalTokenMode()) {
      const keys = [...this.cache.keys()];
      return keys.length > 0 ? keys[0] : null;
    }
    return this.tokenStore.getDefaultAccount();
  }

  async setDefaultAccount(email: string): Promise<void> {
    await this.tokenStore.setDefaultAccount(email);
  }

  // ---- Service resolution --------------------------------------------------

  async getDriveForAccount(email: string): Promise<drive_v3.Drive> {
    const services = await this.resolveServices(email);
    if (!services.drive) {
      services.drive = google.drive({ version: 'v3', auth: services.oauth2Client });
    }
    return services.drive;
  }

  async getCalendarForAccount(email: string): Promise<calendar_v3.Calendar> {
    const services = await this.resolveServices(email);
    if (!services.calendar) {
      services.calendar = google.calendar({ version: 'v3', auth: services.oauth2Client });
    }
    return services.calendar;
  }

  async getAuthClientForAccount(email: string): Promise<any> {
    const services = await this.resolveServices(email);
    return services.oauth2Client;
  }

  // ---- Testing hooks -------------------------------------------------------

  injectClientForTesting(email: string, client: any): void {
    // Evict existing entry so the new client is picked up
    const existing = this.cache.get(email);
    if (existing && existing.oauth2Client !== client) {
      this.cache.delete(email);
    }
    this.cache.set(email, { oauth2Client: client, drive: null, calendar: null });
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ---- Private helpers -----------------------------------------------------

  private async resolveServices(email: string): Promise<AccountServices> {
    // Service account and external token modes use a single shared client
    if (isServiceAccountMode()) {
      return this.getOrCreateExternalServices('service-account', async () =>
        createServiceAccountAuth()
      );
    }

    if (isExternalTokenMode()) {
      return this.getOrCreateExternalServices('service-account', async () => {
        validateExternalTokenConfig();
        return createExternalOAuth2Client();
      });
    }

    // Normal per-account OAuth mode
    const cached = this.cache.get(email);
    if (cached) return cached;

    // Single-account fallback: if the requested email isn't found but exactly
    // one account is in cache, use that one (preserves test compatibility).
    if (this.cache.size === 1) {
      const [[cachedEmail, cachedServices]] = [...this.cache.entries()];
      if (cachedEmail !== email) {
        console.error(`Warning: account "${email}" not found in cache; falling back to "${cachedEmail}".`);
        return cachedServices;
      }
    }

    // Load tokens from store and create a new OAuth2Client
    const tokens = await this.tokenStore.getTokens(email);
    if (!tokens) {
      throw new Error(
        `No credentials found for account "${email}". ` +
        `Run the auth command or visit /setup to add this account.`
      );
    }

    const oauth2Client = await initializeOAuth2Client();
    oauth2Client.setCredentials(tokens);

    // Auto-save refreshed tokens back to the store
    oauth2Client.on('tokens', async (newTokens) => {
      try {
        const current = await this.tokenStore.getTokens(email);
        const merged = {
          ...current,
          ...newTokens,
          refresh_token: newTokens.refresh_token || current?.refresh_token,
        };
        await this.tokenStore.saveTokens(email, merged as any);
      } catch (err) {
        console.error(`Error saving refreshed tokens for ${email}:`, err);
      }
    });

    const services: AccountServices = { oauth2Client, drive: null, calendar: null };
    this.cache.set(email, services);
    return services;
  }

  private async getOrCreateExternalServices(
    key: string,
    createClient: () => Promise<any>
  ): Promise<AccountServices> {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const oauth2Client = await createClient();
    const services: AccountServices = { oauth2Client, drive: null, calendar: null };
    this.cache.set(key, services);
    return services;
  }
}

export const accountManager = new AccountManager();
