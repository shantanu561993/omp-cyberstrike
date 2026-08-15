# http_log

> Indexed all-traffic audit log for the web pentest: append, query, and read.

## Source
- Entry: `packages/coding-agent/src/tools/http-log.ts`
- Key collaborators:
  - `packages/coding-agent/src/pentest/http-log.ts` — shared append/query/read store with deduplicated body vault and hard caps

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `'append' \| 'query' \| 'read'` | Yes | Store one interaction, query the index, or read a stored entry. |
| `out` | `string` | No | Log directory (defaults to the session's pentest output directory). |
| `phase` | `string` | No | Methodology phase tag for the entry (e.g. `sweep`, `exploit`). |
| `source` | `'crawler' \| 'manual' \| 'scanner' \| 'bot'` | No | Origin of the interaction; filters queries. |

## Notes
- The body vault is content-addressed so repeated uploads share storage; hard caps bound index size and body size.
- Every crawl, scanner sweep, and manual request during a pentest should be mirrored here — the log is the evidence trail for the final report.
