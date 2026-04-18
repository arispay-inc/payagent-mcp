/**
 * payagent-mcp — MCP server that lets AI agents pay for APIs.
 *
 * Thin wrapper around `payagent`'s delegated signing path. No private keys
 * touch this process — ArisPay holds a Coinbase CDP-managed wallet and
 * enforces spend limits server-side.
 *
 * Configuration via environment variables:
 *   - ARISPAY_URL:         ArisPay API base URL (default: https://api.arispay.app)
 *   - ARISPAY_AGENT_KEY:   The agent-scoped API key returned by createX402Agent (required)
 *   - PAYAGENT_WALLET:     Optional wallet address for `check_wallet` tool output
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { payFetchDelegated, getUSDCBalance, formatUSDC } from 'payagent';

// ── Config from env ─────────────────────────────────

const arispayUrl = process.env.ARISPAY_URL ?? 'https://api.arispay.app';
const agentKey = process.env.ARISPAY_AGENT_KEY;
const walletAddress = process.env.PAYAGENT_WALLET;

if (!agentKey) {
  console.error(
    'Error: ARISPAY_AGENT_KEY environment variable is required.\n' +
    'Provision an agent at https://payagent.arispay.app to get a key.',
  );
  process.exit(1);
}

const fetch402 = payFetchDelegated({
  arispayUrl,
  apiKey: agentKey,
});

// ── MCP Server ──────────────────────────────────────

const server = new McpServer({
  name: 'payagent',
  version: '2.0.0',
});

server.tool(
  'pay_api',
  {
    url: z.string().describe('The full URL of the API endpoint to call'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .default('GET')
      .describe('HTTP method'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Additional HTTP headers to include'),
    body: z
      .string()
      .optional()
      .describe('Request body (for POST/PUT/PATCH)'),
  },
  async ({ url, method, headers, body }) => {
    try {
      const response = await fetch402(url, {
        method,
        headers,
        body,
      });
      const responseBody = await response.text();

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `HTTP ${response.status}`,
              '',
              responseBody,
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'check_wallet',
  {},
  async () => {
    const lines = [
      `ArisPay URL: ${arispayUrl}`,
      `Agent key:   ${agentKey.slice(0, 10)}…`,
    ];

    if (walletAddress) {
      lines.push(`Wallet:      ${walletAddress}`);
      try {
        const raw = await getUSDCBalance(walletAddress, 'base');
        lines.push(`Balance:     ${formatUSDC(raw)} USDC on Base`);
      } catch (err) {
        lines.push(`Balance:     unavailable (${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      lines.push('', 'Set PAYAGENT_WALLET=0x… in env to include on-chain balance.');
    }

    lines.push('', 'Delegation limits + full spend history: https://payagent.arispay.app');

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

// ── Start ───────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
