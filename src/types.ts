import type { drive_v3, calendar_v3 } from 'googleapis';
import type { google as GoogleApisType } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

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
  google: typeof GoogleApisType;
  getDriveForAccount(email: string): Promise<drive_v3.Drive>;
  getCalendarForAccount(email: string): Promise<calendar_v3.Calendar>;
  getAuthClientForAccount(email: string): Promise<OAuth2Client>;
  log: (message: string, data?: any) => void;
  resolvePath(pathStr: string, drive: drive_v3.Drive): Promise<string>;
  resolveFolderId(input: string | undefined, drive: drive_v3.Drive): Promise<string>;
  checkFileExists(name: string, drive: drive_v3.Drive, parentFolderId?: string): Promise<string | null>;
  validateTextFileExtension: (name: string) => void;
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
