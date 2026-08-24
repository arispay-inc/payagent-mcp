> [!NOTE]
> **Canonical source has moved.** `@arispay/payagent-mcp` is developed and released from ArisPay's consolidated monorepo; this repository is a pre-consolidation snapshot (April 2026) kept for history and may lag the published package. The npm package is authoritative: https://www.npmjs.com/package/@arispay/payagent-mcp

# @arispay/payagent-mcp

MCP server that lets AI agents pay for things: call x402-paid APIs (USDC on Base), pay merchants, and manage wallets with spend limits. Works with Claude Desktop, Cursor, Windsurf, or any MCP client. A thin wrapper around the [`payagent`](https://www.npmjs.com/package/payagent) SDK.

Two ways to hold the wallet:

- **Local key (zero signup).** Set `PAYAGENT_PRIVATE_KEY` to a funded EOA key. `pay_api` signs EIP-3009 locally — no ArisPay account, no email. The only guardrail is client-side; use a dedicated low-balance wallet.
- **Delegated custody (managed).** `create_user({ email })` self-provisions an account, a CDP-managed wallet, and credentials in one call. ArisPay enforces per-transaction, daily, and monthly limits server-side; no private key ever lives in this process.

## Setup

Add the server to your MCP client config. No environment variables are required — pick a wallet mode later, from inside the chat, or set one of the env options below.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "arispay": {
      "command": "npx",
      "args": ["-y", "@arispay/payagent-mcp"]
    }
  }
}
```

For the zero-signup mode, add the key to the env block:

```json
      "env": { "PAYAGENT_PRIVATE_KEY": "0x..." }
```

### Cursor

Same server block in `.cursor/mcp.json`. **Windsurf:** same pattern in `~/.codeium/windsurf/mcp_config.json`.

## Cold start, from nothing

- **Zero signup:** generate a key with `npx payagent wallet new`, put it in the host config as `PAYAGENT_PRIVATE_KEY`, send USDC on Base to the printed address. `check_wallet` shows the deposit address and balance; `pay_api` pays.
- **Managed:** ask the agent to run `create_user({ email: "you@example.com" })`, then `fund_agent({ name })` for a deposit address. Credentials persist to `~/.payagent/config.json` and are shared with the `payagent` CLI.

## Environment variables (all optional)

| Variable | Description |
|----------|-------------|
| `PAYAGENT_PRIVATE_KEY` | Funded EOA key for local self-custody signing (zero-signup mode). |
| `ARISPAY_API_KEY` | Developer key — usually unneeded; `create_user` self-provisions one. |
| `ARISPAY_URL` | ArisPay API base URL. Default `https://api.arispay.app`. |
| `PAYAGENT_MCP_PROFILE` | `core` loads only the 8 pay-URL tools instead of the full surface. |
| `ARISPAY_AGENT_KEY` / `PAYAGENT_WALLET` | Legacy single-agent pair for v2.0.x hosts. |

## Tools

Wallet-centric core: `create_user`, `create_wallet`, `list_wallets`, `fund_wallet`, `get_balance`, `pay_merchant`.

x402 rail: `pay_api` (HTTP request with transparent 402 payment — local key or delegated), `create_agent`, `fund_agent`, `get_balance_agent`, `list_agents`, `rename_agent`.

Discovery (read-only, free, no key): `discover_paid_api` (search the paid-API catalog by intent + budget), `inspect_paid_api` (see a URL's price without paying).

Platform (end-user) tools: `create_enduser`, `attach_card_for_user`, `set_user_limits`, `get_user_status`. Diagnostic: `check_wallet`.

**Example prompts:** "Pay https://api.example.com/premium and show me the data." · "Find a paid API that extracts text from PDFs, under 50 cents." · "Check my wallet."

## How it works

1. The agent calls `pay_api` with a URL; the seller answers HTTP 402 with its price.
2. With `PAYAGENT_PRIVATE_KEY` set, `payagent` signs the EIP-3009 authorization locally. Otherwise ArisPay validates the request against the agent's delegation limits and signs via Coinbase CDP.
3. `payagent` retries with the signed payment header; the seller's facilitator settles USDC on-chain.

In delegated mode, no private key lives in this process and payments that breach the delegation are rejected before any on-chain action. In local mode, the key is yours and stays in your process.

## Install

```bash
npm install @arispay/payagent-mcp
```

Or invoke directly via `npx @arispay/payagent-mcp` from an MCP client config — no pre-install required. `npx buyforme-mcp` is the same server under the consumer brand.

## Related

- [payagent](https://www.npmjs.com/package/payagent) — the SDK + CLI for programmatic use
- [facilitator.arispay.app](https://facilitator.arispay.app) — ArisPay's open x402 facilitator (USDC + EURC on Base), where paid 402s settle
- [x402 protocol](https://github.com/coinbase/x402) — HTTP 402 payment standard

## License

MIT
