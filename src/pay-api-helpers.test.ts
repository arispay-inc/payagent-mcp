/**
 * Tests for the `pay_api` insufficient-funds heuristic.
 *
 * False positives here turn legit errors (allowed-domain blocks,
 * suspended agents, network failures) into misleading "fund your
 * wallet" hints to Claude. So the matcher is deliberately tight:
 * needs both a 402 status AND a funds-shaped keyword.
 */
import { describe, expect, it } from "vitest";
import { looksLikeInsufficientFunds } from "./pay-api-helpers.js";

describe("looksLikeInsufficientFunds", () => {
  it("matches the canonical PaymentRejectedError shape from payFetchDelegated", () => {
    expect(
      looksLikeInsufficientFunds(
        'Server returned 402 after payment was signed and sent. Seller response: {"error":"insufficient_funds"}',
      ),
    ).toBe(true);
  });

  it("matches insufficient_balance / exceeds_balance / invalid_transfer variants", () => {
    expect(looksLikeInsufficientFunds("402 — insufficient_balance")).toBe(true);
    expect(looksLikeInsufficientFunds("HTTP 402: exceeds_balance")).toBe(true);
    expect(looksLikeInsufficientFunds("Server returned 402 ... invalid_transfer")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      looksLikeInsufficientFunds("Server returned 402: INSUFFICIENT FUNDS reported by facilitator"),
    ).toBe(true);
  });

  it("does NOT match a 402 without a balance keyword (could be allowed-domain reject)", () => {
    expect(
      looksLikeInsufficientFunds("Server returned 402: domain not in agent allowedDomains"),
    ).toBe(false);
  });

  it("does NOT match a balance keyword without a 402 (could be suspended agent, etc)", () => {
    expect(looksLikeInsufficientFunds("Agent suspended: insufficient KYC")).toBe(false);
    expect(looksLikeInsufficientFunds("500 internal error: insufficient memory")).toBe(false);
  });

  it("does NOT match generic network errors", () => {
    expect(looksLikeInsufficientFunds("fetch failed: ECONNREFUSED")).toBe(false);
    expect(looksLikeInsufficientFunds("AbortError: timeout")).toBe(false);
  });

  it("does NOT match an unauthenticated 401", () => {
    expect(
      looksLikeInsufficientFunds(
        "ArisPay GET /v1/agents/foo/x402-balance failed (401): Invalid or revoked API key",
      ),
    ).toBe(false);
  });
});
