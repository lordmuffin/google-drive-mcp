import * as fs from 'fs/promises';
import * as path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { Credentials } from 'google-auth-library';
import { getAccountsFilePath, getSecureTokenPath } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
  id_token?: string | null;
  encrypted?: boolean;
}

interface AccountEntry {
  email: string;
  addedAt: string;
  tokens: StoredTokens;
}

interface AccountsFile {
  version: 1;
  defaultAccount?: string;
  accounts: Record<string, AccountEntry>;
}

// ---------------------------------------------------------------------------
// Encryption helpers
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, raw.length === 64 ? 'hex' : 'base64');
  if (buf.length !== 32) {
    console.error('Warning: TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars). Encryption disabled.');
    return null;
  }
  return buf;
}

function encryptToken(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptToken(value: string, key: Buffer): string {
  const buf = Buffer.from(value, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}

function encryptTokenFields(tokens: StoredTokens, key: Buffer): StoredTokens {
  const result: StoredTokens = { ...tokens, encrypted: true };
  if (result.access_token) result.access_token = encryptToken(result.access_token, key);
  if (result.refresh_token) result.refresh_token = encryptToken(result.refresh_token, key);
  return result;
}

function decryptTokenFields(tokens: StoredTokens, key: Buffer): StoredTokens {
  const result: StoredTokens = { ...tokens, encrypted: false };
  try {
    if (result.access_token) result.access_token = decryptToken(result.access_token, key);
    if (result.refresh_token) result.refresh_token = decryptToken(result.refresh_token, key);
  } catch {
    throw new Error('Failed to decrypt tokens. The TOKEN_ENCRYPTION_KEY may be incorrect.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// TokenStore
// ---------------------------------------------------------------------------

export class TokenStore {
  private storePath: string;

  constructor() {
    this.storePath = getAccountsFilePath();
  }

  getStorePath(): string {
    return this.storePath;
  }

  async load(): Promise<AccountsFile> {
    // Cloud mode: read from TOKENS_DATA env var
    const tokensData = process.env.TOKENS_DATA;
    if (tokensData) {
      try {
        return JSON.parse(tokensData) as AccountsFile;
      } catch {
        console.error('Warning: TOKENS_DATA env var contains invalid JSON. Using empty store.');
        return { version: 1, accounts: {} };
      }
    }

    try {
      const content = await fs.readFile(this.storePath, 'utf-8');
      return JSON.parse(content) as AccountsFile;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { version: 1, accounts: {} };
      }
      throw err;
    }
  }

  async save(data: AccountsFile): Promise<void> {
    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async getTokens(email: string): Promise<Credentials | null> {
    const data = await this.load();
    const entry = data.accounts[email];
    if (!entry) return null;

    let tokens = entry.tokens;
    if (tokens.encrypted) {
      const key = getEncryptionKey();
      if (!key) {
        console.error('Warning: tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set. Cannot decrypt.');
        return null;
      }
      tokens = decryptTokenFields(tokens, key);
    }

    return {
      access_token: tokens.access_token ?? undefined,
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
      scope: tokens.scope,
      token_type: tokens.token_type ?? undefined,
      id_token: tokens.id_token ?? undefined,
    } as Credentials;
  }

  async saveTokens(email: string, tokens: Credentials): Promise<void> {
    const data = await this.load();
    const key = getEncryptionKey();

    let storedTokens: StoredTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      token_type: tokens.token_type,
      id_token: tokens.id_token,
    };

    if (key) {
      storedTokens = encryptTokenFields(storedTokens, key);
    }

    const existing = data.accounts[email];
    data.accounts[email] = {
      email,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      tokens: storedTokens,
    };

    // Auto-set default if this is the first account
    if (!data.defaultAccount) {
      data.defaultAccount = email;
    }

    await this.save(data);
  }

  async removeAccount(email: string): Promise<void> {
    const data = await this.load();
    delete data.accounts[email];
    if (data.defaultAccount === email) {
      const remaining = Object.keys(data.accounts);
      data.defaultAccount = remaining.length > 0 ? remaining[0] : undefined;
    }
    await this.save(data);
  }

  async listEmails(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.accounts);
  }

  async getDefaultAccount(): Promise<string | null> {
    const data = await this.load();
    if (data.defaultAccount && data.accounts[data.defaultAccount]) {
      return data.defaultAccount;
    }
    // Fall back to first account if default is stale
    const keys = Object.keys(data.accounts);
    if (keys.length === 1) return keys[0];
    return null;
  }

  async setDefaultAccount(email: string): Promise<void> {
    const data = await this.load();
    if (!data.accounts[email]) {
      throw new Error(`Account ${email} is not connected.`);
    }
    data.defaultAccount = email;
    await this.save(data);
  }

  async migrateFromLegacy(): Promise<boolean> {
    const legacyPath = getSecureTokenPath();
    try {
      await fs.access(legacyPath);
    } catch {
      return false; // No legacy file
    }

    try {
      const content = await fs.readFile(legacyPath, 'utf-8');
      const tokens = JSON.parse(content) as Credentials;
      if (!tokens || typeof tokens !== 'object') return false;

      const email = 'migrated@legacy.local';
      await this.saveTokens(email, tokens);

      // Rename so we don't re-import
      await fs.rename(legacyPath, legacyPath + '.migrated');
      console.error(`Migrated legacy tokens to accounts.json under "${email}".`);
      console.error('Please re-authenticate with your real account using the auth command.');
      return true;
    } catch (err) {
      console.error('Error migrating legacy tokens:', err);
      return false;
    }
  }
}

export const tokenStore = new TokenStore();
