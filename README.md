# @arispay/payagent-mcp

MCP server for [ArisPay](https://arispay.app)-delegated x402 USDC payments. Lets AI agents call paid APIs and settle HTTP 402 challenges with USDC on Base — no private keys ever live in this process.

Works with Claude Desktop, Cursor, Windsurf, or any MCP client. A thin wrapper around the [`payagent`](https://www.npmjs.com/package/payagent) SDK.

## Setup

1. Provision an agent at [payagent.arispay.app](https://payagent.arispay.app). You'll get:
   - A CDP-managed wallet address to fund with USDC on Base
   - An `ARISPAY_AGENT_KEY` (returned exactly once — store it securely)
2. Fund the wallet with USDC on Base.
3. Add the MCP server to your client config:

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arispay": {
      "command": "npx",
      "args": ["-y", "@arispay/payagent-mcp"],
      "env": {
        "ARISPAY_AGENT_KEY": "ap_live_...",
        "PAYAGENT_WALLET": "0x..."
      }
    }
  }
}
```

### Cursor

Edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "arispay": {
      "command": "npx",
      "args": ["-y", "@arispay/payagent-mcp"],
      "env": {
        "ARISPAY_AGENT_KEY": "ap_live_...",
        "PAYAGENT_WALLET": "0x..."
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` with the same pattern.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ARISPAY_AGENT_KEY` | Yes | — | Agent-scoped API key from `payagent.arispay.app` |
| `ARISPAY_URL` | No | `https://api.arispay.app` | ArisPay API base URL |
| `PAYAGENT_WALLET` | No | — | Wallet address (for `check_wallet` tool output) |

## Tools

### `pay_api`

Make an HTTP request to a paid API. Automatically handles HTTP 402 payment challenges via ArisPay-delegated signing.

**Parameters:**
- `url` (string, required) — The API endpoint URL
- `method` (string, default: "GET") — HTTP method
- `headers` (object, optional) — Additional HTTP headers
- `body` (string, optional) — Request body

Spend caps (`maxPerTx`, `maxDaily`, `maxMonthly`, `allowedDomains`) are set on the agent at provisioning time and enforced server-side by ArisPay. There is no client-side budget parameter — attempts that exceed the delegation return a `PaymentRejectedError`.

**Example prompt:** "Use pay_api to fetch https://api.example.com/premium-data"

### `check_wallet`

Report the configured agent, and — if `PAYAGENT_WALLET` is set — the on-chain USDC balance on Base.

**Parameters:** None

**Example prompt:** "Check my agent wallet"

Full delegation limits and spend history live at [payagent.arispay.app](https://payagent.arispay.app).

## How It Works

1. Agent calls `pay_api` with a URL.
2. If the server returns HTTP 402, `payagent` asks ArisPay to sign via CDP.
3. ArisPay validates the request against the agent's delegation limits and signs.
4. `payagent` retries with the signed `X-PAYMENT` header; the seller's facilitator settles on-chain.

No private key lives in this process. The signing key is held by Coinbase CDP; ArisPay enforces limits before signing. If a payment breaches the delegation, it's rejected before any on-chain action.

## Install

```bash
npm install @arispay/payagent-mcp
```

Or invoke directly via `npx @arispay/payagent-mcp` from an MCP client config — no pre-install required.

## Related

- [payagent](https://www.npmjs.com/package/payagent) — the SDK for programmatic use
- [x402 protocol](https://github.com/coinbase/x402) — HTTP 402 payment standard

## License

MIT
