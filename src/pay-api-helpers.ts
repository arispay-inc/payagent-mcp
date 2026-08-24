/**
 * Helpers for the `pay_api` MCP tool.
 *
 * Extracted into their own module so the heuristic that triggers
 * automatic Onramp-URL surfacing is unit-testable. The trigger has to
 * be conservative — false positives turn legitimate errors (allowed-
 * domain blocks, suspended agents) into misleading "fund your wallet"
 * suggestions.
 */

/**
 * Does this error message look like the agent's USDC ran out?
 *
 * The signal we trust is `PaymentRejectedError(402, "Server returned 402
 * after payment was signed and sent. Seller response: ...")` from
 * `payFetchDelegated`, where the seller's body contains a funds- or
 * balance-shaped token. We do not pre-flight balance on every call —
 * that would add a round-trip to the warm path. Post-hoc detection
 * only, and only when both the 402 status AND a balance keyword
 * appear in the same message.
 */
export function looksLikeInsufficientFunds(message: string): boolean {
  if (!/402/.test(message)) return false;
  return /insufficient|insufficient_funds|insufficient_balance|exceeds_balance|invalid_transfer/i.test(
    message,
  );
}
