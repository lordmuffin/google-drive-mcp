import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface AccountConfig {
  alias: string;
  email: string;
}

export interface Account extends AccountConfig {
  authenticated: boolean;
}

interface AccountsFile {
  accounts: AccountConfig[];
}

function defaultConfigDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'google-drive-mcp');
}

export class AccountManager {
  private configPath: string;
  private accountsDir: string;
  private legacyTokenPath: string;

  constructor(baseConfigDir?: string) {
    const base = baseConfigDir ?? defaultConfigDir();
    this.configPath = path.join(base, 'accounts.json');
    this.accountsDir = path.join(base, 'accounts');
    this.legacyTokenPath = path.join(base, 'tokens.json');
  }

  getAccountDir(alias: string): string {
    return path.join(this.accountsDir, alias);
  }

  getTokensPath(alias: string): string {
    return path.join(this.getAccountDir(alias), 'tokens.json');
  }

  private async readConfig(): Promise<AccountsFile> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(raw) as AccountsFile;
    } catch (err: any) {
      if (err.code === 'ENOENT') return { accounts: [] };
      throw err;
    }
  }

  private async writeConfig(cfg: AccountsFile): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }

  async listAccounts(): Promise<Account[]> {
    const cfg = await this.readConfig();
    return Promise.all(
      cfg.accounts.map(async (a) => ({
        ...a,
        authenticated: await this.isAuthenticated(a.alias),
      }))
    );
  }

  async getAccount(aliasOrEmail: string): Promise<AccountConfig | undefined> {
    const cfg = await this.readConfig();
    const lower = aliasOrEmail.toLowerCase();
    return cfg.accounts.find(
      (a) => a.alias === aliasOrEmail || a.email.toLowerCase() === lower
    );
  }

  async addAccount(alias: string, email: string): Promise<void> {
    const cfg = await this.readConfig();
    const existing = cfg.accounts.findIndex((a) => a.alias === alias);
    if (existing >= 0) {
      cfg.accounts[existing] = { alias, email };
    } else {
      cfg.accounts.push({ alias, email });
    }
    await this.writeConfig(cfg);
    await fs.mkdir(this.getAccountDir(alias), { recursive: true });
  }

  async removeAccount(alias: string): Promise<boolean> {
    const cfg = await this.readConfig();
    const before = cfg.accounts.length;
    cfg.accounts = cfg.accounts.filter((a) => a.alias !== alias);
    if (cfg.accounts.length === before) return false;
    await this.writeConfig(cfg);
    return true;
  }

  async isAuthenticated(alias: string): Promise<boolean> {
    return fs.access(this.getTokensPath(alias)).then(() => true).catch(() => false);
  }

  async migrateDefaultAccount(): Promise<void> {
    // Skip if legacy tokens.json doesn't exist
    const legacyExists = await fs.access(this.legacyTokenPath).then(() => true).catch(() => false);
    if (!legacyExists) return;

    // Skip if "default" account already exists
    const cfg = await this.readConfig();
    if (cfg.accounts.some((a) => a.alias === 'default')) return;

    // Read legacy tokens to get email if possible
    let email = 'default';
    try {
      const raw = JSON.parse(await fs.readFile(this.legacyTokenPath, 'utf-8'));
      if (raw && typeof raw === 'object' && typeof raw.email === 'string') {
        email = raw.email;
      }
    } catch {
      // ignore — email stays as "default"
    }

    // Create the account directory and copy tokens
    const destDir = this.getAccountDir('default');
    const destPath = this.getTokensPath('default');
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(this.legacyTokenPath, destPath);

    // Register in accounts.json
    cfg.accounts.push({ alias: 'default', email });
    await this.writeConfig(cfg);

    console.error(`[AccountManager] Migrated tokens.json → accounts/default/tokens.json`);
  }
}
