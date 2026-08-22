# bolt

> Native Bolt integration: pair a remote machine and drive its MCP tools from the session.

## Source
- Entry: `packages/coding-agent/src/tools/bolt.ts`
- Key collaborators:
  - `packages/coding-agent/src/mcp/bolt.ts` — BoltTransport (Ed25519 pair/sign, MCP streamable-HTTP with session affinity)
  - `packages/coding-agent/src/config/settings-schema.ts` — `bolt.servers` server registry

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `'pair' \| 'list' \| 'remove' \| 'tools' \| 'call' \| 'run'` | Yes | Operation. |
| `name` | `string` | No | Server name; `list`/`remove`/`tools`/`call`/`run` resolve it from `bolt.servers`. |
| `url` | `string` | No | Bolt server URL (pair). |
| `adminToken` | `string` | No | Admin token used during pairing to mint the client identity. |

## Notes
- Pairing exchanges Ed25519 identities and persists the keypair + client registration locally; re-pairing after a server-side rotation is detected by the transport.
- The transport rides the shared streamable-HTTP MCP transport (`mcp/transports/http.ts`): the per-request Ed25519 signature is injected through its request-header hook, and session affinity, SSE response handling, server-to-client requests, timeouts, and DELETE session termination come from upstream.
- `run` falls back to the server's `run_command` tool for commands the server does not expose as dedicated tools.
- The ambient `mcp__<server>__*` tools appear after pairing — the connected server's tools are callable directly.
