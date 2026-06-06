import { AGENTS_CORE } from '@happier-dev/agents';

import type {
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';
import {
  hasExactConnectedServiceRestartContinuityContext,
  isConnectedToConnectedServiceSwitch,
  isExactSameConnectedServiceSelection,
  isSameConnectedServiceAuthGroup,
  providerSessionStateUnavailableForResume,
} from '@/backends/connectedServices/switchContinuityContext';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';
import { resolveConnectedServiceRestartContinuityAction } from '@/daemon/connectedServices/sessionAuthSwitch/continuity/resolveConnectedServiceSwitchAction';
import { logger } from '@/ui/logger';

import { claudeConnectedServiceStateSharingDescriptor } from './claudeConnectedServiceStateSharingDescriptor';
import {
  CLAUDE_CONNECTED_SERVICES_LEGACY_RESTART_SAME_HOME_ENV,
} from './verifyResumeReachableClaude';

const CLAUDE_RESTART_REMATERIALIZE_REQUIRED_REASON = 'claude_restart_rematerialize_required';
const CLAUDE_SHARED_STATE_REQUIRED_REASON = 'claude_shared_state_required';
const CLAUDE_SESSION_STATE_SHARING_REQUIRED_REASON = 'claude_session_state_sharing_required';

function supportsService(serviceId: string): boolean {
  return (AGENTS_CORE.claude.connectedServices.supportedServiceIds as readonly string[]).includes(serviceId);
}

function isLegacyClaudeConnectedServicesRollbackEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[CLAUDE_CONNECTED_SERVICES_LEGACY_RESTART_SAME_HOME_ENV] === '1';
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function resolveClaudeConnectedServiceSwitchContinuity(
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }

  if (isLegacyClaudeConnectedServicesRollbackEnabled(process.env)) {
    logger.info(
      '[CONNECTED SERVICES] Using legacy Claude optimistic continuity. Set %s=0 to restore strict fail-closed behavior.',
      CLAUDE_CONNECTED_SERVICES_LEGACY_RESTART_SAME_HOME_ENV,
    );
    return { mode: 'restart_same_home' };
  }

  if (isSameConnectedServiceAuthGroup(params) || isExactSameConnectedServiceSelection(params)) {
    if (!hasExactConnectedServiceRestartContinuityContext(params)) {
      return providerSessionStateUnavailableForResume();
    }

    const targetMaterializedRoot = asNonEmptyString(params.targetMaterializedRoot);
    const vendorResumeId = asNonEmptyString(params.vendorResumeId);
    const cwd = asNonEmptyString(params.cwd);
    const materializationIdentity = params.connectedServiceMaterializationIdentityV1 ?? null;
    const targetMaterializedEnv = params.targetMaterializedEnv ?? null;
    if (
      !targetMaterializedRoot
      || !vendorResumeId
      || !cwd
      || !materializationIdentity
      || !targetMaterializedEnv
    ) {
      return providerSessionStateUnavailableForResume();
    }

    const reachability = await canResumeFromMaterializedState({
      agentId: 'claude',
      serviceId: params.serviceId,
      targetMaterializedRoot,
      targetMaterializedEnv,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      materializationIdentity,
      vendorResumeId,
      cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
    });
    return reachability.ok
      ? { mode: 'restart_same_home' }
      : providerSessionStateUnavailableForResume({
          diagnostics: reachability.continuityDiagnostics,
        });
  }

  if (isConnectedToConnectedServiceSwitch(params)) {
    return resolveConnectedServiceRestartContinuityAction({
      stateSharingDescriptor: claudeConnectedServiceStateSharingDescriptor,
      restartReason: CLAUDE_RESTART_REMATERIALIZE_REQUIRED_REASON,
      sharedStateRequiredReason: CLAUDE_SHARED_STATE_REQUIRED_REASON,
    });
  }
  return resolveConnectedServiceRestartContinuityAction({
    stateSharingDescriptor: claudeConnectedServiceStateSharingDescriptor,
    restartReason: CLAUDE_RESTART_REMATERIALIZE_REQUIRED_REASON,
    sharedStateRequiredReason: CLAUDE_SESSION_STATE_SHARING_REQUIRED_REASON,
  });
}
