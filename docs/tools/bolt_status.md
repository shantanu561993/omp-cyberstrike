# bolt_status

> Read-only per-server Bolt connection status.

## Source
- Entry: `packages/coding-agent/src/tools/bolt-status.ts`
- Key collaborators:
  - `packages/coding-agent/src/config/settings-schema.ts` — `bolt.servers` server registry
  - `packages/coding-agent/src/mcp/bolt.ts` — BoltTransport connection state

## Inputs

No parameters. Reports each configured Bolt server's pair state, URL, and reachability.
