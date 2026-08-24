/**
 * discover_paid_api + inspect_paid_api — read-only discovery tool handlers.
 *
 * Kept out of index.ts so they can be unit-tested without starting the
 * stdio server. The `payagent` SDK functions are injected by the caller
 * (index.ts passes the real `discover` / `inspectChallenge`); this module
 * imports only TYPES from `payagent` so tests need no built SDK.
 *
 * Both tools are read-only and free: no API key, no payment, no signing,
 * no caching of payment authorizations. A `facilitator` field found in a
 * challenge body is reported as SERVER-declared — the server chose it and
 * the inspecting agent never calls or replaces it.
 *
 * Money rule: all amounts are integer cents in data; `$X.YY` / `€X.YY`
 * appears only as display formatting next to the canonical cents value.
 */
import type {
  DiscoverCandidate,
  DiscoverInput,
  DiscoverResult,
  InspectChallengeOptions,
  InspectChallengeResult,
} from "payagent";

export interface ToolText {
  text: string;
  isError: boolean;
}

/** Display-edge only. Data stays integer cents. */
function formatMoneyCents(cents: number, currency?: string): string {
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  const symbol = (currency ?? "USD").toUpperCase() === "EUR" ? "€" : "$";
  return `${symbol}${whole}.${frac}`;
}

function candidatePrice(c: DiscoverCandidate): string {
  const p = c.pricing;
  if (!p || p.model === "free") return "free";
  if (typeof p.amount === "number" && Number.isInteger(p.amount)) {
    const per = p.per ? ` / ${p.per}` : "";
    return `${p.amount}¢ (${formatMoneyCents(p.amount, p.currency)})${per}`;
  }
  return p.model;
}

export interface DiscoverPaidApiParams {
  query: string;
  budgetCentsMax?: number;
  category?: string;
  limit?: number;
}

export async function runDiscoverPaidApi(
  { query, budgetCentsMax, category, limit }: DiscoverPaidApiParams,
  discoverImpl: (input: DiscoverInput) => Promise<DiscoverResult>,
): Promise<ToolText> {
  try {
    const input: DiscoverInput = { intent: query };
    if (budgetCentsMax !== undefined) {
      if (!Number.isInteger(budgetCentsMax) || budgetCentsMax < 0) {
        return {
          text: `discover_paid_api: budgetCentsMax must be a non-negative integer number of cents (got ${budgetCentsMax}).`,
          isError: true,
        };
      }
      input.budgetCentsMax = budgetCentsMax;
    }
    if (category) input.category = category as DiscoverInput["category"];
    // Default 5, cap 20 — keep tool results small in the host's context.
    input.limit = Math.min(Math.max(1, Math.trunc(limit ?? 5)), 20);

    const { candidates } = await discoverImpl(input);
    if (!candidates.length) {
      return {
        text: `No paid APIs matched "${query}". Try a broader query or a higher budget (integer cents).`,
        isError: false,
      };
    }
    const lines = candidates.map((c, i) =>
      [
        `${i + 1}. ${c.name}`,
        ...(c.endpoint.url ? [`   url:      ${c.endpoint.url}`] : []),
        `   price:    ${candidatePrice(c)}`,
        `   healthy:  ${c.healthy === false ? "no" : "yes"}   verified: ${c.verified ? "yes" : "no"}${c.source ? `   source: ${c.source}` : ""}`,
      ].join("\n"),
    );
    lines.push("", "Read-only — nothing was paid. Call one with pay_api({ url }).");
    return { text: lines.join("\n"), isError: false };
  } catch (err) {
    return {
      text: `discover_paid_api failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export async function runInspectPaidApi(
  { url }: { url: string },
  inspectImpl: (url: string, opts?: InspectChallengeOptions) => Promise<InspectChallengeResult>,
): Promise<ToolText> {
  try {
    const result = await inspectImpl(url);
    if (!result.gated) {
      return {
        text: `${url} does not appear to be x402-gated: it returned HTTP ${result.status}, not 402. Nothing to pay here — try fetching it normally.`,
        isError: true,
      };
    }
    const lines = [`x402 challenge for ${url}:`];
    for (const a of result.accepts) {
      lines.push(
        "",
        `  scheme:   ${a.scheme}`,
        `  network:  ${a.network}`,
        `  asset:    ${a.asset}${a.assetName ? ` (${a.assetName})` : ""}`,
        a.amountCents !== undefined
          ? `  amount:   ${a.amountBaseUnits} base units = ${a.amountCents}¢ (${formatMoneyCents(a.amountCents, a.currency)})`
          : `  amount:   ${a.amountBaseUnits} base units`,
        `  payTo:    ${a.payTo}`,
      );
      if (a.description) lines.push(`  about:    ${a.description}`);
      if (a.mimeType) lines.push(`  type:     ${a.mimeType}`);
    }
    if (result.serverDeclaredFacilitator) {
      lines.push(
        "",
        `  Server-declared facilitator: ${result.serverDeclaredFacilitator}`,
        "  (The server settles through this facilitator — its choice, not the payer's.)",
      );
    }
    lines.push("", "Read-only — no payment was sent. Pay with pay_api({ url }).");
    return { text: lines.join("\n"), isError: false };
  } catch (err) {
    return {
      text: `inspect_paid_api failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
