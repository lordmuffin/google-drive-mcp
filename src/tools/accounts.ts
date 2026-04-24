import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { accountManager } from '../auth/accountManager.js';
import { tokenStore } from '../auth/tokenStore.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ListAccountsSchema = z.object({});

const SetDefaultAccountSchema = z.object({
  account: z.string().email("Valid account email is required"),
});

const RemoveAccountSchema = z.object({
  account: z.string().email("Valid account email is required"),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "list_accounts",
    description: "List all connected Google accounts and show which one is the default",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "set_default_account",
    description: "Set the default Google account used when no account is specified (e.g. for ListResources/ReadResource)",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Email address to set as the default account" }
      },
      required: ["account"]
    }
  },
  {
    name: "remove_account",
    description: "Remove a connected Google account and its stored tokens",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Email address of the account to remove" }
      },
      required: ["account"]
    }
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleTool(toolName: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  switch (toolName) {

    case "list_accounts": {
      const emails = await accountManager.listAccounts();
      const defaultAccount = await accountManager.getDefaultAccount();

      if (emails.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No Google accounts are connected.\n\nRun the auth command to add an account:\n  npx google-drive-mcp auth"
          }],
          isError: false
        };
      }

      const lines = emails.map(email => {
        const isDefault = email === defaultAccount;
        return `  ${isDefault ? '★' : '·'} ${email}${isDefault ? ' (default)' : ''}`;
      });

      return {
        content: [{
          type: "text",
          text: `Connected Google accounts (${emails.length}):\n\n${lines.join('\n')}\n\n★ = default account used for ListResources/ReadResource`
        }],
        isError: false
      };
    }

    case "set_default_account": {
      const validation = SetDefaultAccountSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const { account } = validation.data;

      const emails = await accountManager.listAccounts();
      if (!emails.includes(account)) {
        return errorResponse(
          `Account "${account}" is not connected. Connected accounts: ${emails.join(', ') || 'none'}`
        );
      }

      await tokenStore.setDefaultAccount(account);
      return {
        content: [{ type: "text", text: `Default account set to: ${account}` }],
        isError: false
      };
    }

    case "remove_account": {
      const validation = RemoveAccountSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.errors[0].message);
      }
      const { account } = validation.data;

      const emails = await accountManager.listAccounts();
      if (!emails.includes(account)) {
        return errorResponse(
          `Account "${account}" is not connected. Connected accounts: ${emails.join(', ') || 'none'}`
        );
      }

      await accountManager.removeAccount(account);
      return {
        content: [{ type: "text", text: `Account "${account}" has been removed.` }],
        isError: false
      };
    }

    default:
      return null;
  }
}
