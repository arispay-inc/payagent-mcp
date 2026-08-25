/**
 * payagent-mcp — stdio entrypoint.
 *
 * One coherent USDC/x402 payment product. Six core tools (default
 * profile): setup, discover, inspect, pay, balance, history. Four
 * wallet-administration tools load additionally under
 * PAYAGENT_MCP_PROFILE=admin: create_agent, fund_agent, list_agents,
 * rename_agent.
 *
 * The surface (names, descriptions, safety annotations, profiles) is
 * defined in `tool-meta.ts`; handlers live in `server.ts`; both are
 * enforced by `surface.test.ts`.
 *
 * Auth: none for discover/inspect; PAYAGENT_PRIVATE_KEY for
 * self-custody; a developer bearer key (config store or
 * ARISPAY_API_KEY) for delegated mode.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { resolveProfile } from "./tool-meta.js";

async function main() {
  const server = createServer(resolveProfile(process.env.PAYAGENT_MCP_PROFILE));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
