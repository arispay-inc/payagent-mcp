/**
 * Funding-handoff resolution for `fund_wallet` (M2M Session 1a).
 *
 * There is NO production funding/KYC handoff host: the public consumer
 * domain (buyforme.arispay.app) is retired and serves a static notice, and
 * the preview host is allowlist-gated. So there is no default here — a
 * handoff URL exists only when the operator sets BUYFORME_URL to a host
 * they control. Without it, the europ rail returns a structured
 * FUNDING_HANDOFF_UNAVAILABLE error (S2: code, retryable, detail) that
 * also surfaces the machine-native Lane P alternative (self-custody
 * wallet + local EIP-3009 signing via PAYAGENT_PRIVATE_KEY / payFetchLocal).
 *
 * Never reintroduce a retired-domain default and never invent URLs.
 */

/** Strip a trailing slash; empty/unset → null (no default, by design). */
export function resolveFundingHandoffBase(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.BUYFORME_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

export interface FundingHandoffResult {
  text: string;
  isError: boolean;
}

/** S2-structured unavailability payload, embedded as the tool result text. */
function unavailablePayload(walletName: string) {
  return {
    error: {
      code: "FUNDING_HANDOFF_UNAVAILABLE",
      message:
        "EURØP funding needs a browser handoff for KYC, and no production handoff host exists. " +
        "This rail is unavailable until an operator-controlled host is configured (BUYFORME_URL).",
      retryable: false,
      detail: {
        rail: "europ",
        wallet: walletName,
        reason: "no_production_handoff_host",
      },
    },
    alternatives: [
      {
        id: "card",
        description:
          "Fund the master wallet by card instead: call fund_wallet with rail='card' " +
          "(mints a hosted card-setup URL; delegated custody, human-funded).",
        tool: "fund_wallet",
        args: { rail: "card" },
      },
      {
        id: "lane-p-self-custody",
        description:
          "Machine-native alternative (no ArisPay funding account): fund your own EVM wallet " +
          "with USDC on Base and pay x402 endpoints directly with local EIP-3009 signing. " +
          "Set PAYAGENT_PRIVATE_KEY and call pay_api, or use payFetchLocal from the payagent SDK. " +
          "Note: platform spend limits, allowed-domain rules, and the payment feed do not apply " +
          "in this mode — your key, your controls.",
        tool: "pay_api",
        env: { PAYAGENT_PRIVATE_KEY: "<your-evm-private-key>" },
        sdk: "payFetchLocal (payagent)",
      },
    ],
  };
}

/**
 * Build the europ-rail result. With a configured base, returns the browser
 * handoff instructions; without one, returns the structured error above.
 */
export function buildEuropFundingResult(
  base: string | null,
  walletName: string,
  walletId: string,
): FundingHandoffResult {
  if (!base) {
    return {
      text: JSON.stringify(unavailablePayload(walletName), null, 2),
      isError: true,
    };
  }
  const handoffUrl = `${base}/onboarding/fund-europ?agentId=${encodeURIComponent(walletId)}`;
  const lines = [
    `Fund the master wallet for \`${walletName}\` with EURØP via Schuman:`,
    "",
    `  ${handoffUrl}`,
    "",
    "Open that link in a browser to:",
    "  1. Verify your identity with Schuman Financial (one-time KYC).",
    "  2. Receive a dedicated SEPA vIBAN.",
    "  3. Send EUR by bank transfer; Schuman mints EURØP once it clears.",
    "",
    "After the deposit clears, the master funding account is credited and this sub-wallet can spend.",
  ];
  return { text: lines.join("\n"), isError: false };
}
