import { describe, expect, it } from 'vitest';

import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'usage_limit',
  serviceId: 'openai-codex',
  profileId: 'leeroy',
  groupId: 'happier',
  resetsAtMs: null,
  retryAfterMs: 60_000,
  limitCategory: 'quota',
  quotaScope: 'account',
  providerLimitId: 'weekly',
  planType: 'plus',
  rateLimits: null,
  source: 'structured_provider_error',
};

describe('buildConnectedServiceRuntimeAuthSwitchAttemptLogContext', () => {
  it('flattens reactive observed-generation switch attempts into structured telemetry', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'observed_generation',
          activeProfileId: 'codex1',
          generation: 57,
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 175,
    })).toMatchObject({
      trigger: 'runtime_auth_failure',
      decision: 'reactive_runtime_auth_switch',
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'happier',
      reportedProfileId: 'leeroy',
      targetProfileId: 'codex1',
      resultStatus: 'observed_generation',
      generation: 57,
      routedThroughFsm: true,
      latencyMs: 75,
      limitCategory: 'quota',
      quotaScope: 'account',
      providerLimitId: 'weekly',
    });
  });

  it('surfaces sanitized post-switch verification evidence in structured telemetry', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'codex1',
          generation: 58,
          verificationByServiceId: {
            'openai-codex': {
              status: 'weakly_verified',
              reason: 'provider_account_email_verified_without_account_id',
            },
          },
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    })).toMatchObject({
      resultStatus: 'switched',
      targetProfileId: 'codex1',
      generation: 58,
      verificationStatus: 'weakly_verified',
      verificationReason: 'provider_account_email_verified_without_account_id',
    });
  });

  it('surfaces apply-time failures with apply phase and error code', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'codex1',
          generation: 58,
          errorCode: 'hot_apply_failed',
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    })).toMatchObject({
      resultStatus: 'generation_apply_failed',
      targetProfileId: 'codex1',
      generation: 58,
      failurePhase: 'apply',
      errorCode: 'hot_apply_failed',
    });
  });

  it('redacts local continuity diagnostics before runtime-auth telemetry reaches daemon logs', () => {
    const context = buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'codex1',
          generation: 58,
          errorCode: 'provider_session_state_unavailable_for_resume',
          diagnostics: {
            failurePhase: 'continuity',
            continuity: {
              materializationIdentityId: 'csm_pi_shared',
              targetMaterializedRoot: '/tmp/materialized/csm_pi_shared/pi',
              vendorResumeId: 'pi-session-1',
              candidatePersistedSessionFile: '/tmp/native/pi-session-1.jsonl',
              requestedStateMode: 'shared',
              effectiveStateMode: 'shared',
              reachabilityMissReason: 'pi_session_file_not_found',
            },
          },
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    });

    expect(context).toMatchObject({
      resultStatus: 'generation_apply_failed',
      failurePhase: 'continuity',
      errorCode: 'provider_session_state_unavailable_for_resume',
      materializationIdentityId: 'csm_pi_shared',
      targetMaterializedRoot: '[LOCAL_PATH_REDACTED]',
      vendorResumeId: '[PROVIDER_RESUME_ID_REDACTED]',
      candidatePersistedSessionFile: '[LOCAL_PATH_REDACTED]',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      reachabilityMissReason: 'pi_session_file_not_found',
    });
    expect(JSON.stringify(context)).not.toContain('/tmp/materialized');
    expect(JSON.stringify(context)).not.toContain('/tmp/native');
    expect(JSON.stringify(context)).not.toContain('pi-session-1');
  });

  it.each([
    ['provider_session_state_unavailable_for_resume', 'continuity'],
    ['connected_service_materialization_identity_missing', 'continuity'],
    ['resume_reachability_inputs_missing', 'continuity'],
    ['metadata_update_failed', 'metadata_persist'],
    ['hot_apply_failed', 'apply'],
  ])('maps generation apply error %s to failure phase %s', (errorCode, failurePhase) => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'generation_apply_failed',
          activeProfileId: 'codex1',
          generation: 58,
          errorCode,
        },
      },
      routedThroughFsm: true,
      startedAtMs: 100,
      finishedAtMs: 125,
    })).toMatchObject({
      resultStatus: 'generation_apply_failed',
      failurePhase,
      errorCode,
    });
  });

  it('surfaces handler exceptions as structured recovery-handler failures', () => {
    expect(buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
      sessionId: 'sess_1',
      classification,
      handlerFailure: {
        errorCode: 'unexpected_error',
        errorName: 'Error',
        errorMessage: 'Failed to get connected service auth group: timeout of 5000ms exceeded',
      },
      routedThroughFsm: false,
      startedAtMs: 100,
      finishedAtMs: 110,
    })).toMatchObject({
      resultStatus: 'recovery_handler_failed',
      failurePhase: 'handler',
      errorCode: 'unexpected_error',
      errorName: 'Error',
      errorMessage: 'Failed to get connected service auth group: timeout of 5000ms exceeded',
      routedThroughFsm: false,
      latencyMs: 10,
    });
  });
});
