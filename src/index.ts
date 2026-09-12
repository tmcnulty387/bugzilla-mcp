#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BugzillaClient, DEFAULT_BASE_URL } from "./bugzilla.js";
import { registerTools } from "./tools.js";

const SERVER_NAME = "bugzilla-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const client = new BugzillaClient({
    baseUrl: process.env.BUGZILLA_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.BUGZILLA_API_KEY,
    timeoutMs: process.env.BUGZILLA_TIMEOUT_MS ? Number(process.env.BUGZILLA_TIMEOUT_MS) : undefined,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        `This server queries the Bugzilla instance at ${client.baseUrl} (Firefox / Mozilla bug tracker).`,
        "Typical flow: search_bugs to find candidates -> get_bug for details -> get_bug_comments / get_bug_history / get_related_bugs to dig in.",
        "Use list_products and get_product to discover valid product and component names; get_field_values for legal status/priority/severity/keyword values.",
        `Bug URLs look like ${client.bugUrl("<id>")}.`,
        client.hasApiKey
          ? "An API key is configured, so private bugs the user can see and user lookups are available."
          : "No API key is configured: only public bugs are visible and user lookups are unavailable.",
      ].join("\n"),
    },
  );

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} ${SERVER_VERSION} connected (${client.baseUrl}, api key: ${client.hasApiKey ? "yes" : "no"})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
