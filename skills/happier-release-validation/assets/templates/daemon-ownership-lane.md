# {{LANE_ID}} {{LANE_SLUG}}

Status: TODO
Owner: unassigned
Scope: {{LANE_SCOPE}}

## Source Of Truth Reminder

Before work and after compaction, read:
1. `../TRACKING.md`
2. `../PLAN.md`
3. `../LEDGER.md`

## Allowed Write Scope

Default read/QA scope. If this lane uncovers a defect, the orchestrator must assign narrow fix ownership before editing. Typical ownership surfaces:
- `apps/cli/src/daemon/**`
- `apps/cli/src/cli/commands/daemon*.ts`
- `apps/cli/src/ui/doctor*.ts`
- `apps/stack/scripts/daemon*.mjs`
- `scripts/release/installers/**`
- targeted tests proving the daemon ownership contract

## Forbidden Scope

- Do not edit unrelated provider/session/UI code while investigating daemon ownership.
- Do not revert, reset, restore, clean, or discard other agents' changes.
- Do not release, publish, promote, or submit mobile builds.

## Commands And Evidence

Record exact commands per OS under `../evidence/{{LANE_ID}}-{{LANE_SLUG}}/`.

Use targeted automated sentinel tests first, then live Linux/macOS/Windows scenarios. Every live service mutation must record before/after daemon status, service list, account/server URL, and relay ownership state.

{{DAEMON_OWNERSHIP_SCENARIOS}}

## Findings

| Finding | Status | Evidence | Fix |
|---|---|---|---|

## Completion Checklist

- [ ] Automated sentinel tests were run or explicitly mapped to already-green lanes
- [ ] Linux state matrix completed or marked N/A with evidence
- [ ] macOS state matrix completed or marked N/A with evidence
- [ ] Windows state matrix completed or marked N/A with evidence
- [ ] Reproduce-and-decide items DO-08 through DO-10 resolved
- [ ] Root-cause fixes implemented where required
- [ ] Reviewer L23 triggered with evidence paths
- [ ] PLAN/TRACKING/LEDGER updated
