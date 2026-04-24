import type { ToolContext, ToolResult, ToolDefinition } from '../types.js';
import { errorResponse } from '../types.js';

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'list_accounts',
    description: 'List all configured Google accounts and their authentication status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'authenticate_account',
    description:
      'Authenticate a Google account by starting the OAuth browser flow. ' +
      'Use alias "default" for a single-account setup.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'Short name for the account (e.g. "personal", "work"). Defaults to "default".',
        },
        email: {
          type: 'string',
          description: 'Email label for the account (informational — used as display name).',
        },
      },
    },
  },
  {
    name: 'remove_account',
    description: 'Remove a configured Google account from the registry.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Alias or email of the account to remove.',
        },
      },
      required: ['account'],
    },
  },
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (toolName) {
    case 'list_accounts': {
      if (!ctx.listAccounts) return errorResponse('list_accounts not available in this context');
      const accounts = await ctx.listAccounts();
      if (accounts.length === 0) {
        return {
          content: [{ type: 'text', text: 'No accounts configured. Run authenticate_account to add one.' }],
          isError: false,
        };
      }
      const lines = accounts.map(
        (a) => `• ${a.alias} (${a.email}) — ${a.authenticated ? 'authenticated' : 'NOT authenticated'}`
      );
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      };
    }

    case 'authenticate_account': {
      if (!ctx.triggerAuth) return errorResponse('authenticate_account not available in this context');
      const alias = typeof args.alias === 'string' ? args.alias : 'default';
      const email = typeof args.email === 'string' ? args.email : undefined;
      try {
        const msg = await ctx.triggerAuth(alias, email);
        return { content: [{ type: 'text', text: msg }], isError: false };
      } catch (err) {
        return errorResponse((err as Error).message);
      }
    }

    case 'remove_account': {
      if (!ctx.removeAccount) return errorResponse('remove_account not available in this context');
      const account = typeof args.account === 'string' ? args.account : '';
      if (!account) return errorResponse('account parameter is required');
      try {
        const msg = await ctx.removeAccount(account);
        return { content: [{ type: 'text', text: msg }], isError: false };
      } catch (err) {
        return errorResponse((err as Error).message);
      }
    }

    default:
      return null;
  }
}
