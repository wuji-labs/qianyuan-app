import { describe, expect, it } from 'vitest';

import {
    SPAWN_SESSION_ERROR_CODES,
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
    isConnectedServiceResumeUnreachableSpawnErrorDetail,
} from '@happier-dev/protocol';

import { normalizeSpawnSessionResult } from './_shared';

describe('normalizeSpawnSessionResult errorDetail carry-through (D2)', () => {
    it('carries a structured connected-service resume-unreachable detail from the daemon payload', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
                continuityErrorCode: 'provider_session_state_unavailable_for_resume',
                failurePhase: 'continuity',
                agentId: 'pi',
                vendorResumeId: 'pi-session-missing',
                cwd: '/tmp/project',
                reason: 'no_resumable_session_file',
                targetMaterializedRoot: '/tmp/materialized/pi-agent-dir',
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        // Existing fields are preserved unchanged.
        expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
        // The structured detail survives normalization so the UI can recognize it programmatically.
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
        if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
            throw new Error('expected resume-unreachable detail');
        }
        expect(result.errorDetail.agentId).toBe('pi');
        expect(result.errorDetail.reason).toBe('no_resumable_session_file');
        expect(result.errorDetail.targetMaterializedRoot).toBe('/tmp/materialized/pi-agent-dir');
    });

    it('omits errorDetail when the daemon payload carries an unrecognized detail shape', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'some other validation failure',
            errorDetail: { kind: 'totally_unknown_detail', whatever: 1 },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
        // Unknown detail shapes must not leak through as a recognized structured detail.
        expect(result.errorDetail).toBeUndefined();
    });

    it('omits errorDetail when a recognized detail kind has malformed required fields', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
                continuityErrorCode: 'provider_session_state_unavailable_for_resume',
                failurePhase: 'continuity',
                agentId: 'codex',
                vendorResumeId: 'rollout-1',
                cwd: '/work/repo',
                reason: 'native_session_file_missing',
                targetMaterializedRoot: 42,
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(result.errorDetail).toBeUndefined();
    });

    it('keeps a legacy error payload without errorDetail unchanged', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'Claude CLI override is invalid',
        });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'Claude CLI override is invalid',
        });
    });

    it('carries the structured detail through legacy success/error envelopes (success:false)', () => {
        const result = normalizeSpawnSessionResult({
            success: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            error: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
                continuityErrorCode: 'provider_session_state_unavailable_for_resume',
                failurePhase: 'continuity',
                agentId: 'codex',
                vendorResumeId: 'rollout-1',
                cwd: '/work/repo',
                reason: 'native_session_file_missing',
                targetMaterializedRoot: null,
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
    });
});
