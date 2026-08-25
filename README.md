# @arispay/payagent-mcp

One coherent USDC payment product for AI agents: call x402-paid APIs, with spend mandates, receipts, and idempotency. Works with Claude Desktop, Cursor, Windsurf, or any MCP client. A thin wrapper around the [`payagent`](https://www.npmjs.com/package/payagent) SDK.

Two ways to hold the wallet:

- **Local key (zero signup).** Set `PAYAGENT_PRIVATE_KEY` to a funded EOA key. `pay` signs EIP-3009 locally — no ArisPay account, no email. The only guardrail is the wallet balance; use a dedicated low-balance wallet.
- **Delegated custody (managed, recommended).** `setup({ email })` self-provisions an account, a CDP-managed wallet, and a spend mandate in one call. ArisPay enforces per-transaction, daily, and monthly limits server-side **before** signing; no private key ever lives in this process.

## Tools

Six core tools (the default surface):

| Tool | What it does | Money |
|------|--------------|-------|
| `setup` | Create or recover an account + payer wallet in one call (delegated mode) | moves none |
| `discover` | Search the paid-API catalog by intent + budget | read-only |
| `inspect` | Read a URL's price and payment requirements without paying | read-only |
| `pay` | The complete machine path: request → 402 → select variant → validate policy → pay → structured receipt. Requires an `idempotencyKey`; a repeated key returns the cached receipt without paying again | **spends real money** |
| `balance` | Active identity, deposit address, on-chain USDC balance, mandate limits | read-only |
| `history` | Recent payments — server feed (delegated) or local receipts (self-custody) | read-only |

Wallet administration (`create_agent`, `fund_agent`, `list_agents`, `rename_agent`) loads only when the host config sets `PAYAGENT_MCP_PROFILE=admin`.

Every tool declares MCP safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); `pay` is the only destructive tool.

## Support matrix

| Asset | Network | Local key (self-custody) | Delegated (managed mandate) |
|-------|---------|--------------------------|------------------------------|
| USDC | Base (default) | ✅ | ✅ |
| USDC | Ethereum, Polygon | ✅ | ✅ |
| USDC | Base Sepolia (testnet) | ✅ | ✅ |
| USDC (SPL) | Solana, Solana devnet | ❌ (EVM signing only) | ✅ (deployment-gated) |
| USD1 | BNB Chain | ✅ | ✅ |

Notes:

- All prices are quoted by sellers in the 402 challenge; `pay` prefers an EVM variant and falls back to Solana when the seller offers no EVM option.
- Delegated mandates are **integer cents**, validated server-side before any signature exists. Local mode has no server-side cap.
- Settlement is a single on-chain `transferWithAuthorization` (EIP-3009): it succeeds or reverts atomically. When the seller returns `X-PAYMENT-RESPONSE`, the receipt carries the settlement transaction hash.
- ArisPay's own facilitator (`facilitator.arispay.app`) charges no facilitator fee; sellers may use any facilitator, and their fee/finality policy applies.

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

- **Zero signup:** generate a key with `npx payagent wallet new`, put it in the host config as `PAYAGENT_PRIVATE_KEY`, send USDC on Base to the printed address. `balance` shows the deposit address; `pay` pays.
- **Managed:** ask the agent to run `setup({ email: "you@example.com" })` — it returns the wallet address and mandate. Fund the wallet with USDC, confirm with `balance`, then `pay`. Credentials persist to `~/.payagent/config.json` and are shared with the `payagent` CLI.

## Environment variables (all optional)

| Variable | Description |
|----------|-------------|
| `PAYAGENT_PRIVATE_KEY` | Funded EOA key for local self-custody signing (zero-signup mode). |
| `ARISPAY_API_KEY` | Developer key — usually unneeded; `setup` self-provisions one. |
| `ARISPAY_URL` | ArisPay API base URL. Default `https://api.arispay.app`. |
| `PAYAGENT_MCP_PROFILE` | `admin` additionally loads the four wallet-administration tools. Default: core (six tools). |
| `ARISPAY_AGENT_KEY` / `PAYAGENT_WALLET` | Legacy single-agent pair for v2.0.x hosts. |

## Migrating from v3

v4 is a breaking release: the surface collapsed to one x402/USDC product.

| v3 tool | v4 |
|---------|----|
| `create_user` | `setup` |
| `pay_api` | `pay` (now requires `idempotencyKey`, returns a structured receipt) |
| `discover_paid_api` | `discover` |
| `inspect_paid_api` | `inspect` |
| `check_wallet`, `get_balance_agent` | `balance` |
| — | `history` (new) |
| `create_agent`, `fund_agent`, `list_agents`, `rename_agent` | unchanged, behind `PAYAGENT_MCP_PROFILE=admin` |
| `create_wallet`, `list_wallets`, `fund_wallet`, `get_balance`, `pay_merchant`, `create_enduser`, `attach_card_for_user`, `set_user_limits`, `get_user_status` | removed — the fiat funding and platform (end-user) surfaces left the public MCP |

## Receipts and idempotency

`pay` requires a caller-chosen `idempotencyKey` (min 8 chars — use a UUID). Every completed payment writes a machine-readable receipt (amount, asset, network, wallet, settlement tx, remaining mandate) to `~/.payagent/mcp-receipts.json`. Re-calling `pay` with a key that already paid returns the stored receipt and does **not** pay again — including when the paid request failed mid-flight. `history` lists receipts in self-custody mode; delegated mode reads the authoritative server feed.

## How it works

1. The agent calls `pay` with a URL and an `idempotencyKey`; the seller answers HTTP 402 with its price.
2. With `PAYAGENT_PRIVATE_KEY` set, `payagent` signs the EIP-3009 authorization locally. Otherwise ArisPay validates the request against the agent's mandate and signs via Coinbase CDP.
3. `payagent` retries with the signed payment header; the seller's facilitator settles USDC on-chain.
4. The tool returns the paid response plus a structured receipt.

In delegated mode, no private key lives in this process and payments that breach the mandate are rejected before any on-chain action. In local mode, the key is yours and stays in your process.

## Install

```bash
npm install @arispay/payagent-mcp
```

Or invoke directly via `npx @arispay/payagent-mcp` from an MCP client config — no pre-install required. `npx buyforme-mcp` is the same server under the consumer brand.

## Related

- [payagent](https://www.npmjs.com/package/payagent) — the SDK + CLI for programmatic use
- [facilitator.arispay.app](https://facilitator.arispay.app) — ArisPay's open x402 facilitator, where paid 402s settle
- [x402 protocol](https://github.com/coinbase/x402) — HTTP 402 payment standard

## License

MIT
