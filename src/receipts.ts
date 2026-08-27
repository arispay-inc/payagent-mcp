/**
 * payagent-mcp — local receipt store + idempotency guard for `pay`.
 *
 * Every completed payment writes one receipt, keyed by the caller-supplied
 * idempotencyKey. A repeat `pay` call with a key that already paid returns
 * the stored receipt instead of paying again — this is the guard against
 * the most common agent failure mode (an LLM retrying a tool call it
 * already made). The guard is local to this machine's config dir; it is
 * not a server-side idempotency contract.
 *
 * Storage: `${PAYAGENT_CONFIG_DIR || ~/.payagent}/mcp-receipts.json`,
 * file mode 0600, bounded to the newest MAX_RECEIPTS entries. Receipts
 * never contain credentials or private keys.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PaymentReceipt {
  idempotencyKey: string;
  url: string;
  method: string;
  /** ISO 8601. */
  timestamp: string;
  /** `delegated` (ArisPay-signed, mandate-enforced) or `local` (self-custody key). */
  mode: "delegated" | "local";
  /** True when a payment was actually signed and sent. */
  paid: boolean;
  /** HTTP status of the final response, or null if the request errored after payment. */
  httpStatus: number | null;
  /** Integer cents (delegated mode — the server-accounted amount). */
  amountCents?: number;
  /** Asset base units as a decimal string (local mode — e.g. "10000" = $0.01 USDC). */
  amountBaseUnits?: string;
  asset?: string;
  /** CAIP-2 or short network label, as known at signing time. */
  network?: string;
  payTo?: string;
  walletAddress?: string;
  /** Stored agent name (delegated mode). */
  agent?: string;
  /**
   * Decoded X-PAYMENT-RESPONSE from the seller, when present: the
   * settlement transaction reference.
   */
  settlement?: { transaction?: string; network?: string; payer?: string } | null;
  /** Remaining mandate headroom after this payment (delegated mode, integer cents). */
  spend?: { remainingDaily: number; remainingMonthly: number };
  /**
   * True when the server's idempotency cache replayed the previously
   * signed payment for this key — no new spend happened server-side.
   */
  serverReplayed?: boolean;
  /** First 2000 chars of the paid response body (for cached-receipt replays). */
  bodyExcerpt?: string;
  /** Set when the request failed after the payment was signed. */
  error?: string;
}

const MAX_RECEIPTS = 200;

function receiptsPath(): string {
  const dir = process.env.PAYAGENT_CONFIG_DIR ?? join(homedir(), ".payagent");
  return join(dir, "mcp-receipts.json");
}

function loadAll(): PaymentReceipt[] {
  try {
    const path = receiptsPath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { receipts?: PaymentReceipt[] };
    return Array.isArray(parsed.receipts) ? parsed.receipts : [];
  } catch {
    // A corrupt store must never block payments; it only weakens the
    // duplicate guard, which the caller's idempotencyKey semantics allow.
    return [];
  }
}

function persist(receipts: PaymentReceipt[]): void {
  const path = receiptsPath();
  const dir = process.env.PAYAGENT_CONFIG_DIR ?? join(homedir(), ".payagent");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ receipts: receipts.slice(-MAX_RECEIPTS) }, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Best-effort: a read-only disk must not fail the payment that
    // already happened.
  }
}

/** Look up a receipt by idempotency key. Newest wins on (impossible) duplicates. */
export function getReceipt(idempotencyKey: string): PaymentReceipt | undefined {
  const all = loadAll();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].idempotencyKey === idempotencyKey) return all[i];
  }
  return undefined;
}

/** Append a receipt (bounded to the newest MAX_RECEIPTS). */
export function saveReceipt(receipt: PaymentReceipt): void {
  const all = loadAll();
  all.push(receipt);
  persist(all);
}

/** Newest-first listing of locally recorded receipts. */
export function listReceipts(limit: number): PaymentReceipt[] {
  return loadAll().slice(-Math.max(1, limit)).reverse();
}

/**
 * Decode the seller's X-PAYMENT-RESPONSE header (base64 JSON per x402)
 * into a settlement reference. Returns null when absent or undecodable.
 */
export function decodeSettlementHeader(
  header: string | null,
): { transaction?: string; network?: string; payer?: string } | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const pick = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string) : undefined);
    const out = { transaction: pick("transaction"), network: pick("network"), payer: pick("payer") };
    return out.transaction || out.network || out.payer ? out : null;
  } catch {
    return null;
  }
}
