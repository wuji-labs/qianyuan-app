import type { SessionHookData } from './startHookServer';

/**
 * Claude Code emits hook events for sidechain (subagent) activity with an
 * `agent_id` attribution field; main-conversation hooks carry no agent id.
 *
 * Sidechain-attributed hooks must never drive the primary turn lifecycle:
 * a subagent StopFailure is not a primary-turn failure and a subagent Stop is
 * not a primary-turn completion. (Live incident 2026-06-12, session
 * cmq8171vw02q5tm6lzgdq32kc: five subagent auth StopFailures marked the
 * canonical turn failed while the main agent kept working, so the session was
 * presented as idle for the rest of the turn.)
 */
export function readSessionHookSidechainAgentId(data: SessionHookData): string | null {
  const raw = data.agent_id ?? data.agentId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isSidechainSessionHook(data: SessionHookData): boolean {
  return readSessionHookSidechainAgentId(data) !== null;
}
