/**
 * payagent-mcp — server construction + tool handlers.
 *
 * The surface (names, descriptions, annotations, profiles) is defined in
 * `tool-meta.ts`; this module wires the handlers. `index.ts` is the thin
 * stdio entrypoint. Tests build the server via `createServer()` and talk
 * to it over an in-memory transport.
 *
 * Two custody modes, one rail (x402/USDC):
 *   - Self-custody: PAYAGENT_PRIVATE_KEY set → `pay` signs locally.
 *     No account, no other tool required.
 *   - Delegated custody: `setup` → fund the shown wallet → `pay` spends
 *     under the server-enforced mandate.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BootstrapError,
  type DelegatedPaymentInfo,
  DelegationClient,
  type LocalPaymentInfo,
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
// balance simply cannot derive the local-key deposit address.
import * as payagentExports from "payagent";
import { z } from "zod";
import { runDiscoverPaidApi, runInspectPaidApi } from "./discover-tools.js";
import { looksLikeInsufficientFunds } from "./pay-api-helpers.js";
import {
  type PaymentReceipt,
  decodeSettlementHeader,
  getReceipt,
  listReceipts,
  saveReceipt,
} from "./receipts.js";
import { type Profile, TOOL_META } from "./tool-meta.js";

const deriveLocalWalletAddress = (
  payagentExports as { deriveLocalWalletAddress?: (privateKey: string) => string }
).deriveLocalWalletAddress;

/**
 * Single version source: the package's own package.json. Works from both
 * src/ (dev) and dist/ (published bundle) — each sits one level below the
 * package root. server.json must be kept in lockstep at release (enforced
 * by surface.test.ts).
 */
export const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError } : {}),
  };
}

function requireDevKey(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error("No ArisPay developer key found. Run setup({ email }) or set ARISPAY_API_KEY.");
  }
  return key;
}

export function createServer(profile: Profile = "core"): McpServer {
  const arispayUrl = getArispayUrl(process.env.ARISPAY_URL);
  const legacyAgentKey = process.env.ARISPAY_AGENT_KEY;
  const legacyWalletAddress = process.env.PAYAGENT_WALLET;

  const server = new McpServer({ name: "payagent", version: PKG_VERSION });

  // --- setup (core) ---------------------------------------------------------

  server.registerTool(
    "setup",
    {
      description: TOOL_META.setup.description,
      annotations: TOOL_META.setup.annotations,
      inputSchema: {
        email: z
          .string()
          .describe("Email to register the account under. It is also the recovery key — use a real address."),
        name: z.string().optional().describe("Human name. Falls back to the email local-part."),
      },
    },
    async ({ email, name }) => {
      try {
        const result = await bootstrapAgent({
          email,
          name,
          arispayUrl: process.env.ARISPAY_URL,
          clientId: "payagent-mcp-bootstrap",
        });
        const lines = [
          `✓ Account ${result.reused ? "recovered" : "created"}: ${result.email}  (org \`${result.orgName}\`)`,
          `✓ Payer wallet \`${result.agentName}\` on ${result.network}:`,
          "",
          `  ${result.walletAddress}`,
          "",
          `  Mandate: ${result.limits.perTx}¢ / tx, ${result.limits.daily}¢ / day, ${result.limits.monthly}¢ / month (integer cents, server-enforced)`,
          "",
          "Next: fund the wallet by sending USDC on the network above (balance shows the address and confirms the deposit), then pay({ url, idempotencyKey }).",
        ];
        return textResult(lines.join("\n"));
      } catch (err) {
        if (err instanceof BootstrapError) {
          return textResult(`setup failed (${err.code}): ${err.message}`, true);
        }
        return textResult(`setup failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  // --- discover (core) ------------------------------------------------------

  server.registerTool(
    "discover",
    {
      description: TOOL_META.discover.description,
      annotations: TOOL_META.discover.annotations,
      inputSchema: {
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
          .describe(
            "Optional category filter (inference, data, media, search, social, infrastructure, trading, other).",
          ),
        limit: z.number().int().min(1).max(20).default(5).describe("Max results (default 5, max 20)."),
      },
    },
    async ({ query, budgetCentsMax, category, limit }) => {
      const result = await runDiscoverPaidApi({ query, budgetCentsMax, category, limit }, discover);
      return textResult(result.text, result.isError);
    },
  );

  // --- inspect (core) -------------------------------------------------------

  server.registerTool(
    "inspect",
    {
      description: TOOL_META.inspect.description,
      annotations: TOOL_META.inspect.annotations,
      inputSchema: {
        url: z.string().describe("The URL to inspect. Expected to return HTTP 402 with an x402 challenge."),
      },
    },
    async ({ url }) => {
      const result = await runInspectPaidApi({ url }, inspectChallenge);
      return textResult(result.text, result.isError);
    },
  );

  // --- pay (core) -----------------------------------------------------------

  server.registerTool(
    "pay",
    {
      description: TOOL_META.pay.description,
      annotations: TOOL_META.pay.annotations,
      inputSchema: {
        url: z.string().describe("The full URL of the API endpoint to call."),
        idempotencyKey: z
          .string()
          .min(8)
          .describe(
            "Caller-chosen unique key for this payment intent (min 8 chars, e.g. a UUID). Re-calling with a key that already paid returns the cached receipt WITHOUT paying again. Use a fresh key for each new payment intent.",
          ),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
        agent: z.string().optional().describe("Optional name of a stored x402 payer agent (delegated mode)."),
      },
    },
    async ({ url, idempotencyKey, method, headers, body, agent }) => {
      // Idempotency guard: a key that already produced a payment replays
      // its receipt instead of paying again.
      const prior = getReceipt(idempotencyKey);
      if (prior) {
        return textResult(
          [
            "DUPLICATE idempotencyKey — payment NOT repeated. Cached receipt:",
            "",
            JSON.stringify({ receipt: prior }, null, 2),
            "",
            "Use a fresh idempotencyKey only if you intend to pay again.",
          ].join("\n"),
          prior.error ? true : false,
        );
      }

      const startedAt = new Date().toISOString();
      const localKey = process.env.PAYAGENT_PRIVATE_KEY;

      // Self-custody: local key signs in-process — no ArisPay account, no
      // server-enforced mandate (the wallet balance is the cap).
      if (localKey) {
        let paymentInfo: LocalPaymentInfo | undefined;
        try {
          const fetch402 = payFetchLocal({
            privateKey: localKey,
            onPayment: (info) => {
              paymentInfo = info;
            },
          });
          const response = await fetch402(url, { method, headers, body });
          const responseBody = await response.text();
          const receipt: PaymentReceipt = {
            idempotencyKey,
            url,
            method,
            timestamp: startedAt,
            mode: "local",
            paid: Boolean(paymentInfo),
            httpStatus: response.status,
            ...(paymentInfo
              ? {
                  amountBaseUnits: paymentInfo.amount,
                  asset: paymentInfo.asset,
                  network: paymentInfo.network,
                  payTo: paymentInfo.payTo,
                  walletAddress: paymentInfo.walletAddress,
                }
              : {}),
            settlement: decodeSettlementHeader(response.headers.get("x-payment-response")),
            bodyExcerpt: responseBody.slice(0, 2000),
          };
          if (receipt.paid) saveReceipt(receipt);
          return textResult(
            [
              paymentInfo
                ? `HTTP ${response.status} (paid locally — self-custody, no server-enforced mandate)`
                : `HTTP ${response.status} (no payment was required)`,
              "",
              JSON.stringify({ receipt }, null, 2),
              "",
              responseBody,
            ].join("\n"),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (paymentInfo) {
            // Payment signed but the retry failed — record it so the same
            // idempotencyKey cannot double-pay on a blind retry.
            saveReceipt({
              idempotencyKey,
              url,
              method,
              timestamp: startedAt,
              mode: "local",
              paid: true,
              httpStatus: null,
              amountBaseUnits: paymentInfo.amount,
              asset: paymentInfo.asset,
              network: paymentInfo.network,
              payTo: paymentInfo.payTo,
              walletAddress: paymentInfo.walletAddress,
              error: message,
            });
          }
          if (looksLikeInsufficientFunds(message)) {
            return textResult(
              [
                `Error: ${message}`,
                "",
                "The local wallet is out of USDC. Fund it (balance shows the address), or unset PAYAGENT_PRIVATE_KEY to use delegated custody.",
              ].join("\n"),
              true,
            );
          }
          return textResult(`Error: ${message}`, true);
        }
      }

      // Delegated custody: the stored agent's mandate is validated
      // server-side before ArisPay signs via Coinbase CDP.
      const stored = agent ? getAgent(agent) : listAgents()[0];
      if (!stored?.apiKey) {
        return textResult(
          [
            "No payment identity available.",
            "Run setup({ email }) for a managed wallet with a server-enforced mandate,",
            "or set PAYAGENT_PRIVATE_KEY to pay with a local key (self-custody, no account).",
          ].join("\n"),
          true,
        );
      }
      let paymentInfo: DelegatedPaymentInfo | undefined;
      try {
        const fetch402 = payFetchDelegated({
          arispayUrl,
          apiKey: stored.apiKey,
          onPayment: (info) => {
            paymentInfo = info;
          },
        });
        const response = await fetch402(url, { method, headers, body });
        const responseBody = await response.text();
        const receipt: PaymentReceipt = {
          idempotencyKey,
          url,
          method,
          timestamp: startedAt,
          mode: "delegated",
          paid: Boolean(paymentInfo),
          httpStatus: response.status,
          agent: stored.name,
          ...(paymentInfo
            ? {
                amountCents: paymentInfo.amountCents,
                network: paymentInfo.chain,
                walletAddress: paymentInfo.walletAddress,
                spend: {
                  remainingDaily: paymentInfo.remainingDaily,
                  remainingMonthly: paymentInfo.remainingMonthly,
                },
              }
            : {}),
          settlement: decodeSettlementHeader(response.headers.get("x-payment-response")),
          bodyExcerpt: responseBody.slice(0, 2000),
        };
        if (receipt.paid) saveReceipt(receipt);
        const statusLine = paymentInfo
          ? `HTTP ${response.status} (paid ${paymentInfo.amountCents}¢ via \`${stored.name}\` — mandate left: ${paymentInfo.remainingDaily}¢ today, ${paymentInfo.remainingMonthly}¢ this month)`
          : `HTTP ${response.status} (no payment was required)`;
        return textResult(
          [statusLine, "", JSON.stringify({ receipt }, null, 2), "", responseBody].join("\n"),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (paymentInfo) {
          saveReceipt({
            idempotencyKey,
            url,
            method,
            timestamp: startedAt,
            mode: "delegated",
            paid: true,
            httpStatus: null,
            agent: stored.name,
            amountCents: paymentInfo.amountCents,
            network: paymentInfo.chain,
            walletAddress: paymentInfo.walletAddress,
            error: message,
          });
        }
        if (looksLikeInsufficientFunds(message)) {
          return textResult(
            [
              `Error: ${message}`,
              "",
              "The agent wallet is out of USDC. Get the deposit address with balance, fund it, then retry with a fresh idempotencyKey.",
            ].join("\n"),
            true,
          );
        }
        return textResult(`Error: ${message}`, true);
      }
    },
  );

  // --- balance (core) -------------------------------------------------------

  server.registerTool(
    "balance",
    {
      description: TOOL_META.balance.description,
      annotations: TOOL_META.balance.annotations,
      inputSchema: {
        agent: z.string().optional().describe("Optional name of a locally-stored x402 agent."),
      },
    },
    async ({ agent }) => {
      const stored = agent ? getAgent(agent) : listAgents()[0];
      // Self-custody key: derive the deposit address so a key-only setup
      // can still show the human where to send USDC.
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
      if (stored) {
        lines.push(`Agent:       ${stored.name} (${stored.agentId})`);
        lines.push(
          `Mandate:     ${stored.limits.perTx}¢ / tx, ${stored.limits.daily}¢ / day, ${stored.limits.monthly}¢ / month (server-enforced)`,
        );
      }
      if (keyTail) lines.push(`Agent key:   ap_…${keyTail}`);
      if (!stored && !legacyWalletAddress && localAddress) {
        lines.push("Mode:        local key (PAYAGENT_PRIVATE_KEY, self-custody — no ArisPay account)");
      }
      if (localKey && deriveLocalWalletAddress && !localAddress) {
        lines.push("Warning:     PAYAGENT_PRIVATE_KEY is set but is not a valid private key.");
      }

      if (walletAddress) {
        lines.push(`Wallet:      ${walletAddress}`);
        lines.push("Fund it:     send USDC on the network below to the address above.");
        try {
          const raw = await getUSDCBalance(walletAddress, (stored?.network as "base") ?? "base");
          lines.push(`Balance:     ${formatUSDC(raw)} USDC on ${stored?.network ?? "base"}`);
        } catch (err) {
          lines.push(`Balance:     unavailable (${err instanceof Error ? err.message : String(err)})`);
        }
      } else {
        lines.push(
          "",
          "No wallet known. Either run setup({ email }) for a managed wallet,",
          "or set PAYAGENT_PRIVATE_KEY to use a local self-custody key (no account).",
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  // --- history (core) -------------------------------------------------------

  server.registerTool(
    "history",
    {
      description: TOOL_META.history.description,
      annotations: TOOL_META.history.annotations,
      inputSchema: {
        agent: z
          .string()
          .optional()
          .describe("Optional stored agent name — limits the feed to that wallet (delegated mode)."),
        limit: z.number().int().min(1).max(50).default(10).describe("Max entries (default 10, max 50)."),
      },
    },
    async ({ agent, limit }) => {
      const devKey = getApiKey();
      // Delegated mode: the server-side activity feed is authoritative.
      if (devKey) {
        try {
          const client = new DelegationClient(arispayUrl, devKey);
          const stored = agent ? getAgent(agent) : undefined;
          if (agent && !stored) return textResult(`No x402 agent named \`${agent}\`.`, true);
          const feed = stored
            ? await client.listAgentPayments(stored.agentId, { limit })
            : await client.listOrgPayments({ limit });
          if (!feed.payments.length) return textResult("No payments recorded yet.");
          const lines = feed.payments.map((p) => {
            const tx = p.x402FacilitatorTx ?? p.txHash;
            return [
              `${p.createdAt}  ${p.status.toUpperCase()}  ${p.amount}¢ ${p.currency}  [${p.rail}]`,
              `  ${p.merchantName ?? p.merchantUrl ?? p.memo ?? ""}`.trimEnd(),
              ...(p.agent ? [`  agent: ${p.agent.name}`] : []),
              ...(tx ? [`  tx: ${tx}`] : []),
              ...(p.errorCode ? [`  error: ${p.errorCode}`] : []),
            ].join("\n");
          });
          return textResult(lines.join("\n\n"));
        } catch (err) {
          return textResult(
            `history failed: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      }
      // Self-custody mode: locally recorded receipts are all there is.
      const receipts = listReceipts(limit);
      if (!receipts.length) {
        return textResult(
          "No payments recorded on this machine. (Self-custody history is local-only; delegated mode keeps a server-side feed.)",
        );
      }
      return textResult(JSON.stringify({ receipts }, null, 2));
    },
  );

  if (profile !== "admin") return server;

  // ── Admin profile (PAYAGENT_MCP_PROFILE=admin) ────────────────────

  server.registerTool(
    "create_agent",
    {
      description: TOOL_META.create_agent.description,
      annotations: TOOL_META.create_agent.annotations,
      inputSchema: {
        name: z.string().describe("Local identifier for this x402 agent."),
        perTx: z.number().int().positive().describe("Per-transaction spend cap in cents."),
        daily: z.number().int().positive().describe("Daily spend cap in cents."),
        monthly: z.number().int().positive().describe("Monthly spend cap in cents."),
        allowedDomains: z.array(z.string()).optional(),
        network: z
          .enum(["base", "base-sepolia", "ethereum", "polygon", "bsc", "solana", "solana-devnet"])
          .default("base"),
        agentType: z.string().optional(),
      },
    },
    async ({ name, perTx, daily, monthly, allowedDomains, network, agentType }) => {
      try {
        requireDevKey();
        const created = await launchAgent({
          name,
          limits: { perTx, daily, monthly },
          allowedDomains,
          network,
          agentType,
        });
        const lines = [
          `✓ x402 agent \`${name}\` created.`,
          `  Agent ID:  ${created.agentId}`,
          `  Wallet:    ${created.walletAddress}`,
          `  Network:   ${created.network}`,
          `  Limits:    ${perTx}¢ / tx, ${daily}¢ / day, ${monthly}¢ / month`,
          "",
          `  Fund the wallet with USDC on ${created.network}, then call balance({ agent: "${name}" }).`,
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

  server.registerTool(
    "fund_agent",
    {
      description: TOOL_META.fund_agent.description,
      annotations: TOOL_META.fund_agent.annotations,
      inputSchema: {
        name: z.string().describe("Name of a locally-stored x402 agent."),
      },
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
        "Call balance when the deposit lands.",
      ];
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "list_agents",
    {
      description: TOOL_META.list_agents.description,
      annotations: TOOL_META.list_agents.annotations,
      inputSchema: {
        withBalance: z.boolean().optional().describe("Fetch on-chain USDC balance per agent."),
      },
    },
    async ({ withBalance }) => {
      const devKey = getApiKey();
      if (!devKey) {
        return textResult("No developer key found. Run setup({ email }) or npx payagent init.");
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

  server.registerTool(
    "rename_agent",
    {
      description: TOOL_META.rename_agent.description,
      annotations: TOOL_META.rename_agent.annotations,
      inputSchema: {
        name: z.string().describe("Current local name of the x402 agent."),
        newName: z.string().describe("New name."),
      },
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

  return server;
}
