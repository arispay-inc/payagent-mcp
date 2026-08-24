/**
 * payagent-mcp — MCP server for ArisPay's wallet-centric model.
 *
 * Core idea: the user has a master funding account and one or more
 * sub-wallets (spending profiles). Sub-wallets do NOT hold their own
 * on-chain keys; they draw from the user's FundingAccount when making
 * payments. The AI (Claude, Cursor, etc.) is the agent that operates the
 * sub-wallet on the user's behalf.
 *
 * Default tools:
 *   - create_user({ email, name? })          — sign up + create master funding account
 *   - create_wallet({ name, perTx, daily, monthly, allowedDomains? })
 *                                            — create a sub-wallet / spending profile
 *   - list_wallets()                         — list sub-wallets
 *   - fund_wallet({ wallet, rail, amount? }) — fund the master wallet (card via hosted card-setup;
 *                                              europ only with a configured BUYFORME_URL host,
 *                                              else structured FUNDING_HANDOFF_UNAVAILABLE)
 *   - get_balance({ wallet? })               — sub-wallet + master funding-account balances
 *   - pay_merchant({ wallet, merchantUrl, amount, memo, merchantId?, currency? })
 *                                            — pay from the master wallet via balance/card rail
 *
 * Advanced / x402 rail:
 *   - pay_api(url, ...)                      — pay an x402-protected HTTP resource (Base USDC)
 *   - create_agent(...)                      — provision an x402 payer with its own Base wallet
 *   - list_agents()                          — list x402 payer agents
 *   - rename_agent({ name, newName })        — rename an x402 payer agent (server-side)
 *   - fund_agent({ name })                   — fund an x402 agent's Base wallet
 *   - get_balance_agent({ name })            — on-chain USDC balance for an x402 agent
 *
 * Discovery (read-only, free — no key, no payment):
 *   - discover_paid_api({ query, budgetCentsMax?, category?, limit? })
 *                                            — search the ArisPay paid-API catalog
 *   - inspect_paid_api({ url })              — fetch an x402 URL WITHOUT paying; show price/asset/network
 *
 * Platform (end-user) tools — skipped under PAYAGENT_MCP_PROFILE=core:
 *   - create_enduser, attach_card_for_user, set_user_limits, get_user_status
 *
 * Legacy diagnostic:
 *   - check_wallet({ agent? })               — x402 agent credentials + on-chain balance
 *
 * Auth: developer bearer key from ~/.payagent/config.json or ARISPAY_API_KEY.
 * (discover_paid_api / inspect_paid_api need no auth at all.)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BootstrapError,
  type DelegatedPaymentInfo,
  DelegationClient,
  HostedTopupNotConfiguredError,
  type StoredAgent,
  bootstrapAgent,
  discover,
  formatUSDC,
  getAgent,
  getApiKey,
  getArispayUrl,
  getUSDCBalance,
  inspectChallenge,
  launchAgent,
  listAgents,
  payFetchDelegated,
  payFetchLocal,
  renameStoredAgent,
  syncAgents,
} from "payagent";
// deriveLocalWalletAddress shipped in payagent 2.19.0. Access it tolerantly
// (namespace lookup, not a named import) so this server still starts against
// the older published payagent versions the declared floor allows — there,
// check_wallet simply cannot derive the local-key deposit address.
import * as payagentExports from "payagent";
import { z } from "zod";

const deriveLocalWalletAddress = (
  payagentExports as { deriveLocalWalletAddress?: (privateKey: string) => string }
).deriveLocalWalletAddress;
import { runDiscoverPaidApi, runInspectPaidApi } from "./discover-tools.js";
import { buildEuropFundingResult, resolveFundingHandoffBase } from "./funding-handoff.js";
import { looksLikeInsufficientFunds } from "./pay-api-helpers.js";
import { platformToolsEnabled } from "./profile.js";

// ── Configuration ─────────────────────────────────────

const arispayUrl = getArispayUrl(process.env.ARISPAY_URL);
const legacyAgentKey = process.env.ARISPAY_AGENT_KEY;
const legacyWalletAddress = process.env.PAYAGENT_WALLET;

/** External id used to represent the developer user as their own EndUser/payer. */
const SELF_ENDUSER_EXTERNAL_ID = "self";

/**
 * Browser handoff host for EURØP / Schuman KYC. No default: no production
 * handoff host exists (the retired consumer domain serves a static notice).
 * See src/funding-handoff.ts.
 */
const fundingHandoffBase = resolveFundingHandoffBase();

function requireDevKey(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "No ArisPay developer key found. Run `npx payagent init` or set ARISPAY_API_KEY.",
    );
  }
  return key;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError } : {}),
  };
}

// ── Wallet resolution ─────────────────────────────────

/**
 * Resolve a locally-known sub-wallet name to its server-side wallet id.
 * Wallets are authoritative on the server; we look them up by name each time
 * so renaming on the server is always reflected immediately.
 */
async function resolveWallet(
  client: DelegationClient,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const list = await client.listWallets();
  return list.wallets.find((w) => w.name === name);
}

/**
 * Resolve the "self" EndUser id for the authenticated developer. This is the
 * payer record that owns the master FundingAccount.
 */
async function resolveSelfEndUserId(client: DelegationClient): Promise<string | undefined> {
  try {
    const user = await client.getEndUserByExternalId(SELF_ENDUSER_EXTERNAL_ID);
    return user.id;
  } catch {
    return undefined;
  }
}

// ── MCP Server ────────────────────────────────────────

const server = new McpServer({
  name: "payagent",
  version: "3.0.0",
});

// --- create_user ------------------------------------------------------------

server.tool(
  "create_user",
  "Cold-start in one call: create an ArisPay user account plus the master funding account. Safe to re-run — it recovers the existing account instead of creating duplicates.",
  {
    email: z.string().describe("Email for the new ArisPay account."),
    name: z.string().optional().describe("Human name. Falls back to the email local-part."),
  },
  async ({ email, name }) => {
    try {
      const result = await bootstrapAgent({
        email,
        name,
        arispayUrl: process.env.ARISPAY_URL,
        clientId: "payagent-mcp-bootstrap",
      });

      // Ensure the developer user has a self EndUser record so the master
      // FundingAccount can be provisioned.
      const devKey = getApiKey();
      if (devKey) {
        const client = new DelegationClient(arispayUrl, devKey);
        try {
          await client.createEndUser({
            externalId: SELF_ENDUSER_EXTERNAL_ID,
            email,
            findOrCreate: true,
          });
        } catch {
          // Best-effort; the wallets route will create it on demand if needed.
        }
      }

      const lines = [
        `✓ Account: ${result.email}  (org \`${result.orgName}\`)`,
        `✓ Master funding account ready.`,
        "",
        "Next steps:",
        "  1. create_wallet({ name: 'Daily', perTx, daily, monthly })",
        "  2. fund_wallet({ wallet: 'Daily', rail: 'europ' }) for SEPA / EURØP", 
        "     or fund_wallet({ wallet: 'Daily', rail: 'card' }) for card top-up.",
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      if (err instanceof BootstrapError) {
        return textResult(`create_user failed (${err.code}): ${err.message}`, true);
      }
      return textResult(
        `create_user failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- create_wallet ----------------------------------------------------------

server.tool(
  "create_wallet",
  "Create a sub-wallet / spending profile. Sub-wallets draw from the master funding account and enforce per-transaction, daily, and monthly spend limits.",
  {
    name: z.string().describe("Human name for this sub-wallet, e.g. 'Daily' or 'Travel'."),
    perTx: z.number().int().positive().describe("Per-transaction spend cap in cents."),
    daily: z.number().int().positive().describe("Daily spend cap in cents."),
    monthly: z.number().int().positive().describe("Monthly spend cap in cents."),
    allowedDomains: z
      .array(z.string())
      .optional()
      .describe("If provided, restrict this sub-wallet to paying only these domains."),
  },
  async ({ name, perTx, daily, monthly, allowedDomains }) => {
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const wallet = await client.createWallet({
        name,
        perTx,
        daily,
        monthly,
        allowedDomains,
      });
      const lines = [
        `✓ Sub-wallet \`${wallet.name}\` created.`,
        `  id: ${wallet.id}`,
        `  limits: ${wallet.limits.perTx ?? "—"}¢ / tx, ${wallet.limits.daily ?? "—"}¢ / day, ${wallet.limits.monthly ?? "—"}¢ / month`,
        "",
        `Fund it with fund_wallet({ wallet: "${wallet.name}", rail: "europ" | "card" }).`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(
        `create_wallet failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- list_wallets -----------------------------------------------------------

server.tool(
  "list_wallets",
  "List all sub-wallets under this account.",
  {},
  async () => {
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const list = await client.listWallets();
      if (!list.wallets.length) {
        return textResult(
          "No sub-wallets yet. Create one with create_wallet({ name, perTx, daily, monthly }).",
        );
      }
      const lines = list.wallets.map((w) =>
        [
          `\`${w.name}\` (${w.id})`,
          `  status:  ${w.status}`,
          `  limits:  ${w.limits.perTx ?? "—"}¢ / tx, ${w.limits.daily ?? "—"}¢ / day, ${w.limits.monthly ?? "—"}¢ / month`,
          `  balance: ${w.balance} ${w.balanceCurrency}`,
        ].join("\n"),
      );
      return textResult(lines.join("\n\n"));
    } catch (err) {
      return textResult(
        `list_wallets failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- fund_wallet ------------------------------------------------------------

server.tool(
  "fund_wallet",
  "Add money to the master funding account so a sub-wallet can spend. rail='card' mints a hosted card-setup URL. rail='europ' needs an operator-configured handoff host (BUYFORME_URL); without one it returns a structured FUNDING_HANDOFF_UNAVAILABLE error that lists alternatives, including permissionless x402 via PAYAGENT_PRIVATE_KEY.",
  {
    wallet: z.string().describe("Name of a sub-wallet (used only for handoff context)."),
    rail: z
      .enum(["europ", "card"])
      .describe("Funding rail: 'europ' for SEPA/EURØP, 'card' for debit/credit card."),
    amount: z.number().positive().optional().describe("Optional preset amount in dollars."),
  },
  async ({ wallet, rail, amount }) => {
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const resolved = await resolveWallet(client, wallet);
      if (!resolved) {
        return textResult(`No sub-wallet named \`${wallet}\`. Run list_wallets().`, true);
      }

      if (rail === "europ") {
        const result = buildEuropFundingResult(fundingHandoffBase, wallet, resolved.id);
        return textResult(result.text, result.isError);
      }

      // rail === 'card'
      const endUserId = await resolveSelfEndUserId(client);
      if (!endUserId) {
        return textResult(
          "No payer record found. Run create_user first, then retry fund_wallet with rail='card'.",
          true,
        );
      }
      const session = await client.createCardSetupSession({ endUserId });
      const lines = [
        `Add a card to fund the master wallet for \`${wallet}\`:`,
        "",
        `  ${session.setupUrl}`,
        "",
        `  Expires at: ${session.expiresAt}`,
        "",
        "After the card is verified, you can top up. Card top-ups are not yet exposed via MCP; use the ArisPay dashboard for now.",
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(
        `fund_wallet failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- get_balance ------------------------------------------------------------

server.tool(
  "get_balance",
  "Show the master funding-account balance(s) and a sub-wallet's spend limits. If no wallet is named, lists all sub-wallets.",
  {
    wallet: z
      .string()
      .optional()
      .describe("Optional sub-wallet name. Omit to list all sub-wallets."),
  },
  async ({ wallet }) => {
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);

      if (!wallet) {
        const list = await client.listWallets();
        if (!list.wallets.length) {
          return textResult("No sub-wallets yet. Create one with create_wallet().");
        }
        const lines = list.wallets.map((w) => {
          const lim = `limits: ${w.limits.perTx ?? "—"}¢ / tx, ${w.limits.daily ?? "—"}¢ / day, ${w.limits.monthly ?? "—"}¢ / month`;
          return `\`${w.name}\` — ${w.balance} ${w.balanceCurrency} — ${lim}`;
        });
        return textResult(lines.join("\n"));
      }

      const resolved = await resolveWallet(client, wallet);
      if (!resolved) {
        return textResult(`No sub-wallet named \`${wallet}\`.`, true);
      }

      const bal = await client.getWalletBalance(resolved.id);
      const lines = [
        `Sub-wallet: \`${bal.wallet.name}\``,
        `  status:  ${bal.wallet.status}`,
        `  limits:  ${bal.wallet.limits.perTx ?? "—"}¢ / tx, ${bal.wallet.limits.daily ?? "—"}¢ / day, ${bal.wallet.limits.monthly ?? "—"}¢ / month`,
        "",
        "Master funding accounts:",
      ];
      if (!bal.fundingAccounts.length) {
        lines.push("  No funded accounts yet. Use fund_wallet() to add money.");
      } else {
        for (const acct of bal.fundingAccounts) {
          lines.push(`  ${acct.currency}: ${acct.balance}¢ (${acct.provider ?? "internal"})`);
        }
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(
        `get_balance failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- pay_merchant -----------------------------------------------------------

server.tool(
  "pay_merchant",
  "Pay a merchant from the master wallet through a sub-wallet. For balance-rail payments (from FundingAccount), merchantId is required. For card-rail payments, the user must have a verified card on file.",
  {
    wallet: z.string().describe("Name of the sub-wallet to spend through."),
    merchantUrl: z.string().describe("Canonical merchant URL for this payment."),
    amount: z.number().int().positive().describe("Amount in cents."),
    memo: z.string().describe("Human-readable memo, e.g. 'T-shirt from getwatta.com'."),
    merchantId: z
      .string()
      .optional()
      .describe("Required for balance-rail payments to a registered merchant."),
    currency: z.string().optional().describe("Currency code. Default: USD."),
    rail: z
      .enum(["balance", "card"])
      .optional()
      .describe("Force balance or card rail. Default: server picks based on available funding."),
  },
  async ({ wallet, merchantUrl, amount, memo, merchantId, currency, rail }) => {
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const resolved = await resolveWallet(client, wallet);
      if (!resolved) {
        return textResult(`No sub-wallet named \`${wallet}\`.`, true);
      }

      const endUserId = await resolveSelfEndUserId(client);
      if (!endUserId) {
        return textResult(
          "No payer record found. Run create_user first, then retry the payment.",
          true,
        );
      }

      const payment = await client.createPayment(resolved.id, {
        userId: endUserId,
        amount,
        currency: currency ?? "USD",
        memo,
        merchantUrl,
        merchantId,
        rail,
      });

      const lines = [
        `Payment ${payment.id}: ${payment.status}`,
        `  rail:    ${payment.rail}`,
        `  amount:  ${payment.amount}¢ ${payment.currency}`,
      ];
      if (payment.merchantName) lines.push(`  merchant: ${payment.merchantName}`);
      if (payment.txHash) lines.push(`  tx hash:  ${payment.txHash}`);
      if (payment.spend) {
        const fmtCap = (v: number | null) => (v == null ? "no cap" : `${v}¢`);
        lines.push(
          `  budget:  ${fmtCap(payment.spend.remainingDaily)} left today, ${fmtCap(payment.spend.remainingMonthly)} this month`,
        );
      }
      if (payment.nextAction?.challengeUrl) {
        lines.push(`  3DS challenge URL: ${payment.nextAction.challengeUrl}`);
      }
      if (payment.error) {
        lines.push(`  error:   ${payment.error.code} — ${payment.error.message}`);
      }
      return textResult(lines.join("\n"), payment.status === "failed");
    } catch (err) {
      return textResult(
        `pay_merchant failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- pay_api (advanced x402) ------------------------------------------------

server.tool(
  "pay_api",
  "Advanced: make an HTTP request to an x402-protected API, paying with USDC on Base. Signs locally when PAYAGENT_PRIVATE_KEY is set (self-custody, no ArisPay account needed); otherwise pays via delegated signing with server-enforced limits. This is a separate rail from the wallet-centric balance/card flows.",
  {
    url: z.string().describe("The full URL of the API endpoint to call."),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    agent: z.string().optional().describe("Optional name of a stored x402 payer agent."),
  },
  async ({ url, method, headers, body, agent }) => {
    // Permissionless mode: a local key signs in-process — no ArisPay
    // account, no stored agent, no server-enforced limits (mirrors the
    // payagent CLI's PAYAGENT_PRIVATE_KEY path).
    const localKey = process.env.PAYAGENT_PRIVATE_KEY;
    if (localKey) {
      try {
        const fetch402 = payFetchLocal({ privateKey: localKey });
        const response = await fetch402(url, { method, headers, body });
        const responseBody = await response.text();
        return textResult(
          [
            `HTTP ${response.status} (paid locally — permissionless mode, no server-enforced limits)`,
            "",
            responseBody,
          ].join("\n"),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (looksLikeInsufficientFunds(message)) {
          return textResult(
            [
              `Error: ${message}`,
              "",
              "The local wallet is out of USDC. Fund it on Base, or unset PAYAGENT_PRIVATE_KEY to use delegated custody.",
            ].join("\n"),
            true,
          );
        }
        return textResult(`Error: ${message}`, true);
      }
    }

    const stored = agent ? getAgent(agent) : listAgents()[0];
    if (!stored?.apiKey) {
      return textResult(
        [
          "No x402 payer agent available. For wallet-centric payments use pay_merchant.",
          "To create an x402 agent, use create_agent({ name, perTx, daily, monthly }).",
          "Or set PAYAGENT_PRIVATE_KEY to pay with a local key (permissionless mode — no ArisPay account).",
        ].join("\n"),
        true,
      );
    }
    try {
      let paymentInfo: DelegatedPaymentInfo | undefined;
      const fetch402 = payFetchDelegated({
        arispayUrl,
        apiKey: stored.apiKey,
        onPayment: (info) => {
          paymentInfo = info;
        },
      });
      const response = await fetch402(url, { method, headers, body });
      const responseBody = await response.text();
      const statusLine = paymentInfo
        ? `HTTP ${response.status} (paid ${paymentInfo.amountCents}¢ via \`${stored.name}\` — budget left: ${paymentInfo.remainingDaily}¢ today, ${paymentInfo.remainingMonthly}¢ this month)`
        : `HTTP ${response.status} (paid via \`${stored.name}\`)`;
      return textResult([statusLine, "", responseBody].join("\n"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (looksLikeInsufficientFunds(message)) {
        return textResult(
          [
            `Error: ${message}`,
            "",
            "The x402 agent wallet is out of USDC. Fund it with fund_agent({ name }) or switch to wallet-centric pay_merchant.",
          ].join("\n"),
          true,
        );
      }
      return textResult(`Error: ${message}`, true);
    }
  },
);

// --- create_agent (advanced x402) -------------------------------------------

server.tool(
  "create_agent",
  "Advanced: provision an x402 payer agent with its own Base USDC wallet. Use create_wallet instead unless you specifically need to pay x402-protected HTTP resources.",
  {
    name: z.string().describe("Local identifier for this x402 agent."),
    perTx: z.number().int().positive().describe("Per-transaction spend cap in cents."),
    daily: z.number().int().positive().describe("Daily spend cap in cents."),
    monthly: z.number().int().positive().describe("Monthly spend cap in cents."),
    allowedDomains: z.array(z.string()).optional(),
    network: z.enum(["base", "base-sepolia", "ethereum", "polygon"]).default("base"),
    agentType: z.string().optional(),
  },
  async ({ name, perTx, daily, monthly, allowedDomains, network, agentType }) => {
    try {
      requireDevKey();
      const agent = await launchAgent({
        name,
        limits: { perTx, daily, monthly },
        allowedDomains,
        network,
        agentType,
      });
      const lines = [
        `✓ x402 agent \`${name}\` created.`,
        `  Agent ID:  ${agent.agentId}`,
        `  Wallet:    ${agent.walletAddress}`,
        `  Network:   ${agent.network}`,
        `  Limits:    ${perTx}¢ / tx, ${daily}¢ / day, ${monthly}¢ / month`,
        "",
        `  Fund the wallet with USDC on ${agent.network}, then call get_balance_agent with name="${name}".`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(
        `create_agent failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- fund_agent (advanced x402) ---------------------------------------------

server.tool(
  "fund_agent",
  "Advanced: get the USDC deposit address for an x402 payer agent.",
  {
    name: z.string().describe("Name of a locally-stored x402 agent."),
  },
  async ({ name }) => {
    const stored = getAgent(name);
    if (!stored) return textResult(`No x402 agent named \`${name}\`.`, true);
    const lines = [
      `Fund x402 agent \`${name}\` by sending USDC on ${stored.network ?? "base"} to:`,
      "",
      `  ${stored.walletAddress}`,
      "",
      "Only send USDC on the network shown above. Other tokens or networks may be lost.",
      "Call get_balance_agent when the deposit lands.",
    ];
    return textResult(lines.join("\n"));
  },
);

// --- get_balance_agent (advanced x402) --------------------------------------

server.tool(
  "get_balance_agent",
  "Advanced: on-chain USDC balance for an x402 payer agent.",
  {
    name: z.string().describe("Name of a locally-stored x402 agent."),
  },
  async ({ name }) => {
    const stored = getAgent(name);
    if (!stored) return textResult(`No x402 agent named \`${name}\`.`, true);
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const balance = await client.getBalance(stored.agentId);
      const human = formatUSDC(BigInt(balance.usdcBalance || "0"));
      const lines = [
        `${name}: ${human} USDC on ${balance.network}`,
        balance.fundedAt ? `  First funded at: ${balance.fundedAt}` : "  Not yet funded.",
        `  Wallet: ${balance.walletAddress}`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return textResult(
        `get_balance_agent failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- list_agents (advanced x402) --------------------------------------------

server.tool(
  "list_agents",
  "Advanced: list x402 payer agents with on-chain wallets.",
  {
    withBalance: z.boolean().optional().describe("Fetch on-chain USDC balance per agent."),
  },
  async ({ withBalance }) => {
    const devKey = getApiKey();
    if (!devKey) {
      return textResult("No developer key found. Run create_user or npx payagent init.");
    }
    try {
      const result = await syncAgents({ includeBalance: withBalance === true });
      if (!result.agents.length) {
        return textResult("No x402 agents found. Use create_agent to provision one.");
      }
      const lines = result.agents.map((a) => {
        const balanceLine =
          a.usdcBalance !== undefined
            ? `  balance:   ${formatUSDC(BigInt(a.usdcBalance || "0"))} USDC`
            : null;
        return [
          a.name,
          `  agent id:  ${a.agentId}`,
          `  wallet:    ${a.walletAddress}`,
          `  network:   ${a.network}`,
          `  limits:    ${a.limits.maxPerTx}¢ / tx, ${a.limits.maxDaily}¢ / day, ${a.limits.maxMonthly}¢ / month`,
          ...(balanceLine ? [balanceLine] : []),
        ].join("\n");
      });
      return textResult(lines.join("\n\n"));
    } catch (err) {
      return textResult(
        `list_agents failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- rename_agent (advanced x402) -------------------------------------------

server.tool(
  "rename_agent",
  "Advanced: rename an x402 payer agent.",
  {
    name: z.string().describe("Current local name of the x402 agent."),
    newName: z.string().describe("New name."),
  },
  async ({ name, newName }) => {
    if (name === newName) {
      return textResult(`Agent \`${name}\` already has that name.`);
    }
    const stored = getAgent(name);
    if (!stored) {
      return textResult(`No x402 agent named \`${name}\`.`, true);
    }
    try {
      const devKey = requireDevKey();
      const client = new DelegationClient(arispayUrl, devKey);
      const result = await client.renameAgent(stored.agentId, newName);
      renameStoredAgent(name, result.name);
      return textResult(`✓ Renamed \`${name}\` → \`${result.name}\`.`);
    } catch (err) {
      return textResult(
        `rename_agent failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  },
);

// --- discover_paid_api (read-only discovery) --------------------------------

server.tool(
  "discover_paid_api",
  "Search the ArisPay marketplace for paid APIs by capability or plain-language intent, optionally budget-bounded (integer cents). Read-only — costs nothing and needs no API key. Returns ranked candidates with endpoint URL, price in cents, health and verification flags. Follow up with pay_api to actually call one, or inspect_paid_api to see a URL's exact payment requirements first.",
  {
    query: z.string().describe("Capability or plain-language intent, e.g. 'flight search'."),
    budgetCentsMax: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Maximum acceptable price in INTEGER CENTS (500 = $5.00). Free listings always pass."),
    category: z
      .string()
      .optional()
      .describe("Optional category filter (inference, data, media, search, social, infrastructure, trading, other)."),
    limit: z.number().int().min(1).max(20).default(5).describe("Max results (default 5, max 20)."),
  },
  async ({ query, budgetCentsMax, category, limit }) => {
    const result = await runDiscoverPaidApi({ query, budgetCentsMax, category, limit }, discover);
    return textResult(result.text, result.isError);
  },
);

// --- inspect_paid_api (read-only discovery) ---------------------------------

server.tool(
  "inspect_paid_api",
  "Fetch an x402-protected URL WITHOUT paying to see its price, asset, network, and payment requirements. Read-only, never pays — no payment header, no auth, no API key. Use before pay_api to know what a resource costs.",
  {
    url: z.string().describe("The URL to inspect. Expected to return HTTP 402 with an x402 challenge."),
  },
  async ({ url }) => {
    const result = await runInspectPaidApi({ url }, inspectChallenge);
    return textResult(result.text, result.isError);
  },
);

// --- Platform (end-user) tools ----------------------------------------------
//
// Skipped under PAYAGENT_MCP_PROFILE=core.
if (platformToolsEnabled()) {
  server.tool(
    "create_enduser",
    "Platform mode: register an end-customer under your account.",
    {
      externalId: z.string().describe("Your own stable id for this customer."),
      email: z.string().optional(),
      findOrCreate: z.boolean().optional(),
    },
    async ({ externalId, email, findOrCreate }) => {
      try {
        const devKey = requireDevKey();
        const client = new DelegationClient(arispayUrl, devKey);
        const user = await client.createEndUser({ externalId, email, findOrCreate });
        return textResult(
          `✓ End-user \`${externalId}\` ready.\n  ArisPay id: ${user.id}\n  Has card: ${user.hasPaymentMethod ? "yes" : "no"}`,
        );
      } catch (err) {
        return textResult(
          `create_enduser failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  server.tool(
    "attach_card_for_user",
    "Platform mode: mint a hosted card-entry URL for an end-user.",
    {
      userId: z.string().describe("ArisPay-internal end-user id."),
      agentName: z.string().optional().describe("Optional x402 agent name to scope the session to."),
    },
    async ({ userId, agentName }) => {
      try {
        const devKey = requireDevKey();
        const client = new DelegationClient(arispayUrl, devKey);
        const agentId = agentName ? getAgent(agentName)?.agentId : undefined;
        const session = await client.createCardSetupSession({ endUserId: userId, agentId });
        return textResult(
          [`Card-entry URL:`, `  ${session.setupUrl}`, `  Expires at: ${session.expiresAt}`].join(
            "\n",
          ),
        );
      } catch (err) {
        return textResult(
          `attach_card_for_user failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  server.tool(
    "set_user_limits",
    "Platform mode: set per-(user, agent) spend caps.",
    {
      userId: z.string(),
      agentName: z.string(),
      perTx: z.number().int().optional(),
      daily: z.number().int().optional(),
      monthly: z.number().int().optional(),
      allowedMcc: z.array(z.string()).optional(),
      blockedMcc: z.array(z.string()).optional(),
    },
    async ({ userId, agentName, perTx, daily, monthly, allowedMcc, blockedMcc }) => {
      try {
        const stored = getAgent(agentName);
        if (!stored) return textResult(`No x402 agent named \`${agentName}\`.`, true);
        const devKey = requireDevKey();
        const client = new DelegationClient(arispayUrl, devKey);
        const limit = await client.setUserLimits(userId, {
          agentId: stored.agentId,
          maxPerTransaction: perTx ?? null,
          maxDaily: daily ?? null,
          maxMonthly: monthly ?? null,
          allowedMerchantCategories: allowedMcc,
          blockedMerchantCategories: blockedMcc,
        });
        return textResult(
          `✓ Limits set. per-tx ${limit.maxPerTransaction ?? "inherit"}¢, daily ${limit.maxDaily ?? "inherit"}¢, monthly ${limit.maxMonthly ?? "inherit"}¢`,
        );
      } catch (err) {
        return textResult(
          `set_user_limits failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  server.tool(
    "get_user_status",
    "Platform mode: report an end-user's card and wallet readiness.",
    {
      userId: z.string(),
    },
    async ({ userId }) => {
      try {
        const devKey = requireDevKey();
        const client = new DelegationClient(arispayUrl, devKey);
        const user = await client.getEndUser(userId);
        const lines = [
          `${user.externalId} (${user.id})`,
          `  card:   ${user.hasPaymentMethod ? `${user.cardBrand ?? "card"} …${user.cardLast4 ?? "????"}` : "—"}`,
          `  wallet: ${user.walletAddress ?? "—"}${user.walletChain ? ` on ${user.walletChain}` : ""}`,
        ];
        return textResult(lines.join("\n"));
      } catch (err) {
        return textResult(
          `get_user_status failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );
}

// --- check_wallet (legacy diagnostic) ---------------------------------------

server.tool(
  "check_wallet",
  "Legacy diagnostic for x402 payer agents. Also derives the deposit address when PAYAGENT_PRIVATE_KEY (local self-custody key) is set. Use get_balance for wallet-centric balances.",
  {
    agent: z.string().optional().describe("Optional name of a locally-stored x402 agent."),
  },
  async ({ agent }) => {
    const stored = agent ? getAgent(agent) : listAgents()[0];
    // Local self-custody key (Lane P): derive the deposit address so a
    // key-only setup can still show the human where to send USDC.
    let localAddress: string | undefined;
    const localKey = process.env.PAYAGENT_PRIVATE_KEY;
    if (localKey && deriveLocalWalletAddress) {
      try {
        localAddress = deriveLocalWalletAddress(localKey);
      } catch {
        // Invalid key — reported below rather than crashing the diagnostic.
      }
    }
    const walletAddress = stored?.walletAddress ?? legacyWalletAddress ?? localAddress;
    const keyTail =
      stored?.apiKey.slice(-4) ?? (legacyAgentKey ? legacyAgentKey.slice(-4) : undefined);

    const lines = [`ArisPay URL: ${arispayUrl}`];
    if (stored) lines.push(`Agent:       ${stored.name} (${stored.agentId})`);
    if (keyTail) lines.push(`Agent key:   ap_…${keyTail}`);
    if (!stored && !legacyWalletAddress && localAddress) {
      lines.push("Mode:        local key (PAYAGENT_PRIVATE_KEY, self-custody — no ArisPay account)");
    }
    if (localKey && deriveLocalWalletAddress && !localAddress) {
      lines.push("Warning:     PAYAGENT_PRIVATE_KEY is set but is not a valid private key.");
    }

    if (walletAddress) {
      lines.push(`Wallet:      ${walletAddress}`);
      lines.push("Fund it:     send USDC on Base to the address above.");
      try {
        const raw = await getUSDCBalance(walletAddress, (stored?.network as "base") ?? "base");
        lines.push(`Balance:     ${formatUSDC(raw)} USDC on ${stored?.network ?? "base"}`);
      } catch (err) {
        lines.push(`Balance:     unavailable (${err instanceof Error ? err.message : String(err)})`);
      }
    } else {
      lines.push(
        "",
        "No wallet known. Either run create_user({ email }) for a managed wallet,",
        "or set PAYAGENT_PRIVATE_KEY to use a local self-custody key (no account).",
      );
    }
    return textResult(lines.join("\n"));
  },
);

// ── Start ─────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
