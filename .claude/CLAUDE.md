# Claude Code Project Notes

Read the root `AGENTS.md` constitution for repository rules. The root `CLAUDE.md` imports it for Claude Code.

## Background subagents and permissions

Background subagents cannot prompt for missing tool permissions. If a tool call is denied because it is not allowed in `.claude/settings.json`, fail fast and report the exact tool, command, and missing permission. Do not retry permission-denied calls in a loop.

Run commands in the foreground when interactive approval may be required.
