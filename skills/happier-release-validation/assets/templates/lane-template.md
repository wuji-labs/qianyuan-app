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

TODO: orchestrator must narrow before assigning a fix-capable agent.

## Forbidden Scope

- Do not edit unrelated files.
- Do not revert, reset, restore, clean, or discard other agents' changes.
- Do not release, publish, promote, or submit mobile builds.

## Commands

TODO: fill lane-specific commands before execution.

## Evidence

- Evidence directory: `../evidence/{{LANE_ID}}-{{LANE_SLUG}}/`
- Full logs: TODO
- Summary: TODO

## Findings

| Finding | Status | Evidence | Fix |
|---|---|---|---|

## Completion Checklist

- [ ] Scope understood
- [ ] Environment recorded
- [ ] Commands run or scenario performed
- [ ] Failures classified by root cause
- [ ] Test fixes, if any, checked against shared testkit/mock/factory ownership
- [ ] Fixes implemented if in scope
- [ ] Targeted reruns green
- [ ] Broader rerun or reviewer trigger recorded
- [ ] PLAN/TRACKING/LEDGER updated
