/**
 * payagent-mcp — single source of truth for the tool surface.
 *
 * One entry per tool: name, description, and MCP safety annotations
 * (readOnlyHint / destructiveHint / idempotentHint / openWorldHint).
 * `server.ts` registers from this table; `surface.test.ts` enforces the
 * count, the names, the annotation completeness, and the description
 * rubric (every tool states whether it spends real funds).
 *
 * Profiles:
 *   - core (default): the six agent-facing tools. This is what a fresh
 *     `npx @arispay/payagent-mcp` (and Glama's inspector) sees.
 *   - admin: core + the four wallet-administration tools.
 */

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolMeta {
  description: string;
  annotations: ToolAnnotations;
}

export const CORE_TOOL_NAMES = [
  "setup",
  "discover",
  "inspect",
  "pay",
  "balance",
  "history",
] as const;

export const ADMIN_TOOL_NAMES = [
  "create_agent",
  "fund_agent",
  "list_agents",
  "rename_agent",
] as const;

export type ToolName = (typeof CORE_TOOL_NAMES)[number] | (typeof ADMIN_TOOL_NAMES)[number];

export type Profile = "core" | "admin";

/**
 * Resolve the tool profile from the environment. Default is `core`.
 * `admin` (aliases: `all`, `full` — kept so pre-4.0 host configs that set
 * PAYAGENT_MCP_PROFILE=all keep loading the widest surface) adds the
 * wallet-administration tools.
 */
export function resolveProfile(raw: string | undefined): Profile {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "admin" || v === "all" || v === "full") return "admin";
  return "core";
}

export function toolNamesForProfile(profile: Profile): readonly string[] {
  return profile === "admin" ? [...CORE_TOOL_NAMES, ...ADMIN_TOOL_NAMES] : CORE_TOOL_NAMES;
}

export const TOOL_META: Record<ToolName, ToolMeta> = {
  // ── Core ──────────────────────────────────────────────────────────
  setup: {
    description:
      "Creates or recovers an ArisPay account for delegated custody and provisions a USDC payer wallet in one call (side effects: registers the email, creates a Coinbase CDP-managed wallet, writes credentials to ~/.payagent/config.json on this machine). Moves no money — it does NOT spend funds. Idempotent: re-running with the same email recovers the existing account and its wallets. Not needed in self-custody mode: if PAYAGENT_PRIVATE_KEY is set, skip setup entirely — pay works with the local key alone.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  discover: {
    description:
      "Searches the ArisPay marketplace for paid APIs by capability or plain-language intent, optionally budget-bounded (integer cents). Read-only — spends no money, needs no API key. Returns ranked candidates with endpoint URL, price in cents, health and verification flags. Select this to FIND an endpoint; then inspect to price a specific URL, then pay to call it.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  inspect: {
    description:
      "Fetches an x402-protected URL WITHOUT paying and reports its price, asset, network, and payment requirements. Read-only — spends no money, sends no payment header, needs no API key or account. Always safe. Select this before pay to know exactly what a resource costs.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  pay: {
    description:
      "SPENDS REAL MONEY — on-chain and irreversible. The complete machine payment path: makes the HTTP request, and if the server answers 402, selects the supported asset/network variant (USDC on Base/Ethereum/Polygon; delegated mode also settles Solana and BNB Chain variants), validates policy, pays, retries the request, and returns the response plus a structured machine-readable receipt. Requires an idempotencyKey: re-calling with a key that already paid returns the cached receipt and does NOT pay again. Mode selection: PAYAGENT_PRIVATE_KEY set → signs locally (self-custody; wallet balance is the only cap); otherwise pays through the stored ArisPay agent whose per-tx/daily/monthly mandate is enforced server-side BEFORE signing. Use inspect first to see the price. Do not use for ordinary unpaid HTTP requests.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  balance: {
    description:
      "Read-only: shows the active payment identity — the stored ArisPay agent (delegated) or the PAYAGENT_PRIVATE_KEY-derived address (self-custody) — with its USDC deposit address, on-chain balance, and (delegated) spend-mandate limits. Spends no money, never pays. Select this to find where to send USDC, to confirm a deposit landed, or when a payment fails.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  history: {
    description:
      "Read-only: lists recent payments — the server-side activity feed in delegated mode (newest first), or locally recorded receipts in self-custody mode. Spends no money. Select this to reconcile what was paid, retrieve a past receipt, or audit an agent's spending.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // ── Admin (PAYAGENT_MCP_PROFILE=admin) ────────────────────────────
  create_agent: {
    description:
      "Provisions an additional x402 payer agent under delegated custody (side effects: creates a Coinbase CDP-managed wallet and an agent-scoped API key on the ArisPay account, persisted to ~/.payagent/config.json). Moves no money. Requires an account — run setup first. Limits are INTEGER CENTS, enforced server-side on every payment. setup already provisions a first agent; use this only to give different tasks separate budgets. Unnecessary in self-custody mode.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  fund_agent: {
    description:
      "Read-only: prints the USDC deposit address for a stored agent wallet so a human can fund it. Sends nothing and moves no money. IMPORTANT: only send USDC on the shown network — other tokens or networks may be lost permanently. Use balance to confirm the deposit landed.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_agents: {
    description:
      "Lists all x402 payer agents on the account from the server (authoritative — works on a fresh machine). Moves no money; its only side effect is refreshing the local config cache. withBalance=true additionally fetches each wallet's on-chain USDC balance (slower). Requires a developer key.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  rename_agent: {
    description:
      "Renames an x402 payer agent (side effect: server-side rename, mirrored to the local cache). Moves no money. Names are unique per organization — a conflict returns an error and changes nothing. The name doubles as the account-recovery key for this agent, so rename deliberately.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
};
