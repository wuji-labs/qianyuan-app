import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  SPAWN_SESSION_ERROR_CODES,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  type ConnectedServiceUxDiagnosticCodeV1,
} from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from './connectedServiceUxDiagnostics';
import {
  buildConnectedServiceDiagnosticSpawnValidationErrorResult,
  buildConnectedServiceMaterializationSpawnErrorResult,
} from './buildConnectedServiceDiagnosticSpawnErrorResult';

describe('buildConnectedServiceDiagnosticSpawnValidationErrorResult', () => {
  it('attaches a protocol-owned ux diagnostic to connected-service spawn validation errors', () => {
    const result = buildConnectedServiceDiagnosticSpawnValidationErrorResult({
      errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
      uxDiagnostic: buildConnectedServiceUxDiagnostic({
        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
        },
      }),
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_materialization_identity_missing',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic.code).toBe('connected_service_materialization_identity_missing');
  });

  it('defaults Claude native-auth diagnostics to reconnect-focused actions', () => {
    const diagnostic = buildConnectedServiceUxDiagnostic({
      code: 'claude_subscription_missing_claude_code_scope' as ConnectedServiceUxDiagnosticCodeV1,
      failurePhase: 'materialization',
      source: 'usage_limit_recovery',
      serviceId: 'claude-subscription',
      providerId: 'claude',
      agentId: 'claude',
      profileId: 'claude-profile',
      retryable: false,
      diagnostics: {
        materializationReason: 'missing_scope',
      },
    });

    expect(diagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      suggestedActions: [
        'reconnect_profile',
        'open_connected_accounts',
      ],
    });
  });

  it('preserves first-class Claude materialization diagnostic codes on spawn failure', () => {
    const result = buildConnectedServiceMaterializationSpawnErrorResult({
      agentId: 'claude',
      diagnostics: [{
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'missing_required_scope',
        entryName: 'user:sessions:claude_code',
      }],
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'claude_subscription_missing_claude_code_scope',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'claude',
      providerId: 'claude',
      serviceId: 'claude-subscription',
      retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
      diagnostics: {
        reason: 'missing_required_scope',
        materializationCode: 'claude_subscription_missing_claude_code_scope',
        entryName: 'user:sessions:claude_code',
      },
    });
  });
});
