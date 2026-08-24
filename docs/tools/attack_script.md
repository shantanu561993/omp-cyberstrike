# attack_script

> Runs one of the 16 embedded CyberStrike web pentest scanners against a target.

## Source
- Entry: `packages/coding-agent/src/tools/attack-script.ts`
- Key collaborators:
  - `packages/coding-agent/src/pentest/scanners/` — the 16 vendored scanner scripts (Cloud Storage Enum, CORS Checker, File Upload Tester, GitHub Dorker, GraphQL Tester, IDOR Tester, JWT Tamper, OAuth Tester, Race Tester, Rate Limit Bypass, Response Diff, SSRF Listener, SSTI Tester, Subdomain Takeover, WAF Bypass, Wayback Endpoints)
  - `packages/coding-agent/src/pentest/assets.ts` — staged asset resolution
  - `packages/coding-agent/src/eval/py/runtime.ts` — Python runtime resolution
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamping

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `script` | `'cloud_storage_enum' \| 'cors_checker' \| 'file_upload_tester' \| 'github_dorker' \| 'graphql_tester' \| 'idor_tester' \| 'jwt_tamper' \| 'oauth_tester' \| 'race_tester' \| 'rate_limit_bypass' \| 'response_diff' \| 'ssrf_listener' \| 'ssti_tester' \| 'subdomain_takeover' \| 'waf_bypass' \| 'wayback_endpoints'` | Yes | Scanner to execute. |
| `args` | `string[]` | No | Scanner CLI arguments. Run the script with `["--help"]` first when unsure of the syntax. |
| `timeout` | `number` | No | Timeout in seconds (clamped to `tools.maxTimeout`). Long-running scanners such as `ssrf_listener` may need a high value. |

## Notes
- `exec` approval tier: every invocation is surfaced for user approval.
- Output streams to the result; sweep runs should be saved to `<out>/sweep/<scanner>.log`.
