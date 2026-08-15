# methodology

> 13-phase web pentest methodology state machine: init, status, next, start, complete, coverage.

## Source
- Entry: `packages/coding-agent/src/tools/methodology.ts`
- Key collaborators:
  - `packages/coding-agent/src/pentest/methodology.ts` — the 13 CyberStrike phases, per-phase checklists, and prerequisite enforcement

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `'init' \| 'status' \| 'next' \| 'start' \| 'complete' \| 'coverage'` | Yes | State-machine operation. |
| `out` | `string` | Yes | Session directory holding the state file. |
| `target` | `string` | No | Target identifier recorded at `init`. |
| `phase` | `string` | No | Phase name for `start`/`complete` (e.g. `recon`, `auth-bypass`). |

## Notes
- Phases have prerequisites: `complete` refuses to close a phase until its prerequisite phases are closed, so the run cannot skip stages.
- `coverage` reports how many checklist items per phase are done vs. total — the coverage figure that feeds the final report.
