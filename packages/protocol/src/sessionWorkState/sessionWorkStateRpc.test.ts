import { describe, expect, it } from 'vitest';

import {
    SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema,
    SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema,
    DaemonSessionSkillCatalogListRequestV1Schema,
    DaemonSessionVendorPluginCatalogListRequestV1Schema,
    DaemonSessionGoalClearRequestV1Schema,
    DaemonSessionGoalSetRequestV1Schema,
    SessionUsageLimitCheckNowRequestV1Schema,
    SessionUsageLimitOperationResponseV1Schema,
            SessionUsageLimitWaitResumeCancelRequestV1Schema,
    SessionUsageLimitWaitResumeEnableRequestV1Schema,
    SessionGoalSetRequestV1Schema,
    SessionSkillCatalogListResponseV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    SessionWorkStateGetResponseV1Schema,
} from './sessionWorkStateRpc.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../rpc.js';

describe('session work-state RPC contracts', () => {
    it('defines session-scoped RPC method ids', () => {
        expect(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET).toBe('session.workState.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_GET).toBe('session.goal.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_SET).toBe('session.goal.set');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR).toBe('session.goal.clear');
        expect(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE).toBe('session.review.startInline');
        expect(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS).toBe(
            'session.connectedServiceAuth.invalidateTransports',
        );
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_GET).toBe('daemon.sessionGoal.get');
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_SET).toBe('daemon.sessionGoal.set');
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR).toBe('daemon.sessionGoal.clear');
        expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST).toBe(
            'daemon.sessionVendorPluginCatalog.list',
        );
        expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_SKILL_CATALOG_LIST).toBe(
            'daemon.sessionSkillCatalog.list',
        );
        expect(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST).toBe('session.vendorPluginCatalog.list');
        expect(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST).toBe('session.skillCatalog.list');
    });

    it('parses work-state and vendor plugin catalog response shapes', () => {
        expect(SessionWorkStateGetResponseV1Schema.parse({ workState: null })).toEqual({ workState: null });
        expect(SessionGoalSetRequestV1Schema.parse({ objective: 'Ship goals', status: 'active', tokenBudget: null })).toEqual({
            objective: 'Ship goals',
            status: 'active',
            tokenBudget: null,
        });
        expect(SessionGoalSetRequestV1Schema.parse({ objective: 'Line one\nLine two' })).toEqual({
            objective: 'Line one\nLine two',
        });
        expect(SessionGoalSetRequestV1Schema.parse({ status: 'paused' })).toEqual({
            status: 'paused',
        });
        expect(SessionGoalSetRequestV1Schema.parse({ tokenBudget: 50_000 })).toEqual({
            tokenBudget: 50_000,
        });
        expect(SessionGoalSetRequestV1Schema.parse({ tokenBudget: null })).toEqual({
            tokenBudget: null,
        });
        expect(() => SessionGoalSetRequestV1Schema.parse({})).toThrow();
        expect(DaemonSessionGoalSetRequestV1Schema.parse({ sessionId: 's1', status: 'paused' })).toEqual({
            sessionId: 's1',
            status: 'paused',
        });
        expect(() => DaemonSessionGoalSetRequestV1Schema.parse({ status: 'paused' })).toThrow();
        expect(DaemonSessionGoalClearRequestV1Schema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
        expect(DaemonSessionVendorPluginCatalogListRequestV1Schema.parse({ sessionId: 's1', cwd: '/repo' })).toEqual({
            sessionId: 's1',
            cwd: '/repo',
        });
        expect(DaemonSessionSkillCatalogListRequestV1Schema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
        expect(() => DaemonSessionVendorPluginCatalogListRequestV1Schema.parse({ cwd: '/repo' })).toThrow();
        expect(SessionVendorPluginCatalogListResponseV1Schema.parse({
            vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail', enabled: true }],
        }).vendorPlugins[0]?.vendorPluginRef).toBe('plugin://gmail@openai-curated');
        expect(SessionVendorPluginCatalogListResponseV1Schema.parse({
            catalog: {
                v: 1,
                updatedAt: 1_717_000_000_000,
                items: [
                    {
                        v: 1,
                        vendorPluginRef: 'plugin://review@openai-curated',
                        displayName: 'Review',
                        enabled: true,
                    },
                ],
            },
        }).vendorPlugins[0]).toMatchObject({
            vendorPluginRef: 'plugin://review@openai-curated',
            name: 'Review',
            displayName: 'Review',
            enabled: true,
        });
        expect(SessionSkillCatalogListResponseV1Schema.parse({
            catalog: {
                v: 1,
                updatedAt: 1_717_000_000_000,
                items: [
                    {
                        v: 1,
                        id: 'vendor:codex:debugger',
                        origin: 'vendor',
                        backendId: 'codex',
                        name: 'debugger',
                        path: '/skills/debugger/SKILL.md',
                    },
                    {
                        v: 1,
                        id: 'happier:review',
                        origin: 'happier',
                        name: 'review',
                    },
                ],
            },
        }).skills.map((skill) => skill.origin)).toEqual(['vendor', 'happier']);
        expect(SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema.parse({})).toEqual({});
        expect(SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.parse({
            ok: true,
        })).toEqual({
            ok: true,
        });
    });

    it('defines shared request and response schemas for usage-limit recovery session RPCs', () => {
        expect(SessionUsageLimitWaitResumeEnableRequestV1Schema.parse({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            remember: true,
        })).toEqual({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            remember: true,
        });
        expect(SessionUsageLimitWaitResumeEnableRequestV1Schema.parse({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            rememberPreference: true,
            resumePromptMode: 'off',
        })).toEqual({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            rememberPreference: true,
            resumePromptMode: 'off',
        });
        expect(SessionUsageLimitWaitResumeCancelRequestV1Schema.parse({
            sessionId: 's1',
            issueFingerprint: null,
        })).toEqual({
            sessionId: 's1',
            issueFingerprint: null,
        });
        expect(SessionUsageLimitCheckNowRequestV1Schema.parse({
            sessionId: 's1',
            provider: ' codex ',
        })).toEqual({
            sessionId: 's1',
            provider: 'codex',
        });
        expect(SessionUsageLimitCheckNowRequestV1Schema.parse({
            sessionId: 's1',
            provider: ' codex ',
            operation: 'switch_account_now',
            resumePromptMode: 'off',
        })).toEqual({
            sessionId: 's1',
            provider: 'codex',
            operation: 'switch_account_now',
            resumePromptMode: 'off',
        });
        expect(() => SessionUsageLimitCheckNowRequestV1Schema.parse({
            sessionId: 's1',
            resumePromptMode: 'sometimes',
        })).toThrow();
        expect(() => SessionUsageLimitCheckNowRequestV1Schema.parse({
            sessionId: 's1',
            operation: 'not-a-real-operation',
        })).toThrow();
        expect(SessionUsageLimitOperationResponseV1Schema.parse({
            ok: true,
            recovery: { status: 'waiting' },
        })).toEqual({
            ok: true,
            recovery: { status: 'waiting' },
        });
        expect(SessionUsageLimitOperationResponseV1Schema.parse({
            ok: false,
            error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
            errorCode: 'unsupported_session_runtime_method',
        })).toEqual({
            ok: false,
            error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
            errorCode: 'unsupported_session_runtime_method',
        });
        expect(() => SessionUsageLimitWaitResumeEnableRequestV1Schema.parse({
            sessionId: 's1',
            issueFingerprint: null,
        })).toThrow();
        expect(() => SessionUsageLimitWaitResumeEnableRequestV1Schema.parse({
            sessionId: 's1',
            rememberPreference: 'yes',
        })).toThrow();
    });
});
