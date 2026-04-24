import type { drive_v3, calendar_v3 } from 'googleapis';
import type { google as GoogleApisType } from 'googleapis';
import type { Account } from './auth/accountManager.js';

export type { Account } from './auth/accountManager.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  authClient: any;
  account: string;
  google: typeof GoogleApisType;
  getDrive: () => drive_v3.Drive;
  getCalendar: () => calendar_v3.Calendar;
  log: (message: string, data?: any) => void;
  resolvePath: (pathStr: string) => Promise<string>;
  resolveFolderId: (input: string | undefined) => Promise<string>;
  checkFileExists: (name: string, parentFolderId?: string) => Promise<string | null>;
  validateTextFileExtension: (name: string) => void;
  getTokenPath: () => string;
  // Account-management callbacks — only populated for account-mgmt tools
  listAccounts?: () => Promise<Account[]>;
  triggerAuth?: (alias: string, email?: string) => Promise<string>;
  removeAccount?: (aliasOrEmail: string) => Promise<string>;
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function withAccountParam(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown>) ?? {};
  return {
    ...schema,
    properties: {
      account: {
        type: 'string',
        description:
          'Account alias or email to use. Required when multiple accounts are configured.',
      },
      ...props,
    },
  };
}
