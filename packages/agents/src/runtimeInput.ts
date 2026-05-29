import { AGENTS_CORE } from './manifest.js';
import type { AgentCore, AgentId, AgentRuntimeInputConfig } from './types.js';

const UNSUPPORTED_AGENT_RUNTIME_INPUT: AgentRuntimeInputConfig = Object.freeze({
  inFlightSteerSupported: false,
});

export function getAgentRuntimeInputCapability(agentId: AgentId): AgentRuntimeInputConfig {
  const agent = AGENTS_CORE[agentId] as AgentCore;
  return agent.runtimeInput ?? UNSUPPORTED_AGENT_RUNTIME_INPUT;
}

export function supportsAgentInFlightSteer(agentId: AgentId): boolean {
  return getAgentRuntimeInputCapability(agentId).inFlightSteerSupported === true;
}
