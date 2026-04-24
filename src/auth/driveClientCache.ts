import { google } from 'googleapis';
import type { drive_v3, calendar_v3 } from 'googleapis';
import { AccountManager } from './accountManager.js';
import { TokenManager } from './tokenManager.js';
import { initializeOAuth2Client } from './client.js';

interface OAuthCachedEntry {
  kind: 'oauth';
  drive: drive_v3.Drive;
  calendar: calendar_v3.Calendar;
  authClient: any;
}

interface PrebuiltEntry {
  kind: 'prebuilt';
  authClient: any;
}

type CacheEntry = OAuthCachedEntry | PrebuiltEntry;

export interface ResolvedEntry {
  drive: drive_v3.Drive;
  calendar: calendar_v3.Calendar;
  authClient: any;
}

export class DriveClientCache {
  private cache: Map<string, CacheEntry> = new Map();
  private accountManager: AccountManager;

  constructor(accountManager: AccountManager) {
    this.accountManager = accountManager;
  }

  hasPrebuilt(alias: string): boolean {
    return this.cache.get(alias)?.kind === 'prebuilt';
  }

  getPrebuiltAliases(): string[] {
    const result: string[] = [];
    for (const [alias, entry] of this.cache.entries()) {
      if (entry.kind === 'prebuilt') result.push(alias);
    }
    return result;
  }

  async getEntry(alias: string): Promise<ResolvedEntry> {
    const cached = this.cache.get(alias);

    if (cached) {
      if (cached.kind === 'prebuilt') {
        // Call google.drive/calendar at request time so tests that monkey-patch
        // `google.drive` after _setAuthClientForTesting get the correct mock service.
        return {
          drive: google.drive({ version: 'v3', auth: cached.authClient }),
          calendar: google.calendar({ version: 'v3', auth: cached.authClient }),
          authClient: cached.authClient,
        };
      }
      return cached;
    }

    const account = await this.accountManager.getAccount(alias);
    if (!account) {
      const accounts = await this.accountManager.listAccounts();
      const names = accounts.map((a) => `${a.alias} (${a.email})`).join(', ');
      throw new Error(
        `Account not found: "${alias}".${names ? ` Available: ${names}` : ' No accounts configured — run authenticate_account first.'}`
      );
    }

    const tokenPath = this.accountManager.getTokensPath(alias);
    const oauth2Client = await initializeOAuth2Client();
    const tokenManager = new TokenManager(oauth2Client, tokenPath);

    const valid = await tokenManager.validateTokens();
    if (!valid) {
      throw new Error(
        `Account "${alias}" is not authenticated. Run authenticate_account with alias "${alias}" to authenticate.`
      );
    }

    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const entry: OAuthCachedEntry = { kind: 'oauth', drive, calendar, authClient: oauth2Client };
    this.cache.set(alias, entry);
    return entry;
  }

  setPrebuiltClient(alias: string, authClient: any): void {
    this.cache.set(alias, { kind: 'prebuilt', authClient });
  }

  clearEntry(alias: string): void {
    this.cache.delete(alias);
  }

  clearAll(): void {
    this.cache.clear();
  }
}
