/**
 * Tool-profile selection (docs/agent-discoverability.md, open question 2).
 *
 * Every registered tool's schema is resident in the MCP host's context on
 * every task. The common persona — "an agent that pays URLs" — never needs
 * the four platform (end-user) tools, so `PAYAGENT_MCP_PROFILE=core` skips
 * registering them and the host loads 15 schemas instead of 19:
 *
 *   core profile: create_user, create_wallet, list_wallets, fund_wallet,
 *                 get_balance, pay_merchant, pay_api, create_agent,
 *                 fund_agent, get_balance_agent, list_agents, rename_agent,
 *                 discover_paid_api, inspect_paid_api, check_wallet
 *   all (default): the above + create_enduser, attach_card_for_user,
 *                 set_user_limits, get_user_status
 *
 * Default stays "all" for backward compatibility with existing host configs.
 */
export function platformToolsEnabled(raw = process.env.PAYAGENT_MCP_PROFILE): boolean {
  return (raw ?? "all").trim().toLowerCase() !== "core";
}
