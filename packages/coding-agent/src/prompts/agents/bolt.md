---
description: Manage Bolt remote tool servers (Ed25519-paired MCP remote execution). Usage: /bolt <pair|list|remove|tools|call|run> ...
---

# Bolt Command

Manage Bolt remote tool servers with the built-in `bolt` tool (no CLI —
everything goes through the tool).

## 1. Actions (bolt tool)

| Action | Parameters | Notes |
|---|---|---|
| pair | `name`, `url`, `adminToken` | Ed25519 pairing flow; saves credentials under the agent dir (`bolt-keys/`); prints {clientId, serverFingerprint} |
| list | — | Per-server status: connected / needs_auth / disabled / failed (+ reason) |
| remove | `name` | Deletes the server's credentials |
| tools | `name` | Lists the server's remote tools |
| call | `name`, `tool`, `jsonArgs` | Signed remote call; remote error result → report it as an error result |
| run | `name`, `command` | Shortcut for `call <name> bash '<command>'` |

Print the tool output verbatim.

## 2. After pairing — tools come up automatically

- Pairing stores credentials under `<agentDir>/bolt-keys/<name>.json`; the
  server entry comes from the `bolt.servers` setting (or an mcp.json
  `{"type": "bolt"}` entry).
- The `pair` action reconnects the MCP manager automatically: when the
  server is already configured, the `mcp__<server>_<tool>` tools go live
  immediately. When no server entry exists yet, the tool prints the exact
  config command (`omp config set bolt.servers.<name>.url <url>` or mcp.json)
  and a `/mcp reconnect <name>` to apply it in the running session.
- `omp bolt pair <name> <url> --admin-token <token>` is the native CLI
  equivalent (no session needed); new sessions pick up configured servers
  at startup.
- Once live, EVERY agent (main and subagents) can use them without further
  commands — e.g. `/pentest` phases prefer `mcp__<server>_bash` for heavy
  scans from the remote network position.

## 3. Errors

- Unknown server / missing credentials → the tool prints the pairing hint; relay it.
- Unreachable server → explicit error; suggest checking the server.
- URL changed → the tool reports "failed (re-pair required: url changed)";
  credentials must be re-paired.
- Remote tool error → error result; relay it and (for pentests) fall back to
  local execution with a note.
