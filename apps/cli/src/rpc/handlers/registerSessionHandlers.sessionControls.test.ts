import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsageLimitRecoveryOperationResultV1Schema } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const featureDecisionMocks = vi.hoisted(() => ({
  resolveCliFeatureDecisionForServer: vi.fn(async () => ({
    decision: { state: 'enabled' },
  })),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: featureDecisionMocks.resolveCliFeatureDecisionForServer,
}));

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('registerSessionHandlers session controls', () => {
  beforeEach(() => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockReset();
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'enabled' },
    });
  });

  it('fails usage-limit recovery RPCs closed when the feature is disabled for the target server', async () => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'disabled' },
    });
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true }));
    const updateSessionMetadata = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      updateSessionMetadata,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const { handlers, registrar } = createRegistrar();
    const refreshGoal = vi.fn(async () => {});
    const setGoal = vi.fn(async () => {});
    const clearGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };
    const metadata: Metadata & { sessionWorkStateV1: typeof workState } = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: workState,
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
        objective: '  Ship native goal  ',
        status: 'paused',
        tokenBudget: 1200,
      }),
    ).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes catalog RPCs to runtime catalog controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });
    expect(listVendorPlugins).toHaveBeenCalledWith({ cwd: '/override' });
    expect(listSkills).toHaveBeenCalledWith({ cwd: '/override' });
  });

  it('routes inline review RPCs to runtime review controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const startInlineReview = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        startInlineReview,
      },
    });

    const request = {
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(startInlineReview).toHaveBeenCalledWith(request);
  });

  it('routes connected-service auth invalidation RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        invalidateConnectedServiceAuthTransports,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });

  it('routes usage-limit recovery RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async (request: unknown) => {
      if (
        request
        && typeof request === 'object'
        && (request as { operation?: unknown }).operation === 'switch_account_now'
      ) {
        return { ok: true, result: { status: 'switch_attempted', result: { status: 'observed_generation' } } };
      }
      return { ok: true, status: 'waiting' };
    });

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
    }))).toEqual({
      ok: true,
      status: 'switch_observed',
      sessionId: 'sess_1',
    });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
    });
  });

  it('rejects blank usage-limit issue fingerprints before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('rejects non-boolean rememberPreference values before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      rememberPreference: 'yes',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('persists usage-limit recovery intent when no runtime recovery hook is installed', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
    };
    const updateSessionMetadata = vi.fn(async (handler: (metadata: Metadata) => Metadata) => {
      metadata = handler(metadata);
    });

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadata,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect(metadata).toMatchObject({
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'cancelled',
    });
    expect(updateSessionMetadata).toHaveBeenCalledTimes(2);
  });

  it('lets runtime message controls intercept provider-specific messages before enqueueing', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(handleUserMessage).toHaveBeenCalledWith(request);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('preserves trusted uploaded image metadata for runtime message controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-user-message-'));
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    try {
      const uploadedPath = '.happier/uploads/messages/m1/screen.png';
      const uploadedContent = Buffer.from('fake image bytes');
      const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
      await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
      await writeFile(join(root, uploadedPath), uploadedContent);

      registerSessionHandlers(registrar, root, {
        enqueueSessionUserMessage,
        sessionRuntimeControls: {
          handleUserMessage,
        },
      });

      const request = {
        text: 'inspect upload',
        localId: 'local-upload-image',
        meta: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [
                {
                  name: 'screen.png',
                  path: uploadedPath,
                  mimeType: 'image/png',
                  sizeBytes: uploadedContent.byteLength,
                  sha256,
                },
              ],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: uploadedPath,
                sha256,
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      };

      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({ ok: true });

      expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
      expect(enqueueSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops forged upload-shaped local image metadata before runtime message controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage: vi.fn(async () => {}),
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'inspect forged upload',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [
              {
                path: '.happier/uploads/messages/m1/private.png',
                mimeType: 'image/png',
                sha256: '0'.repeat(64),
              },
            ],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              localPath: '.happier/uploads/messages/m1/private.png',
              sha256: '0'.repeat(64),
              provenance: { kind: 'sessionAttachmentUpload' },
            },
          ],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierStructuredInputV1: expect.not.objectContaining({
          attachments: expect.any(Array),
        }),
      }),
    }));
  });

  it('enqueues provider-specific slash commands when no runtime hook handles them', async () => {
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    });
  });

  it('uses the current goal objective for status-only goal updates', async () => {
    const { handlers, registrar } = createRegistrar();
    const setGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      } as Metadata & { sessionWorkStateV1: typeof workState }),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual({ workState });

    expect(setGoal).toHaveBeenCalledWith('Ship goal controls', { status: 'paused' });
  });

  it('delegates status-only goal updates to the runtime when metadata has no current objective', async () => {
    const { handlers, registrar } = createRegistrar();
    const runtimeResult = {
      ok: false,
      errorCode: 'goal_not_found',
      error: 'goal_not_found',
    };
    const setGoal = vi.fn(async () => runtimeResult);

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      } as Metadata),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual(runtimeResult);

    expect(setGoal).toHaveBeenCalledWith(undefined, { status: 'paused' });
  });

  it('returns displayable work-state items when metadata preserves future items', async () => {
    const { handlers, registrar } = createRegistrar();
    const metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'future:1',
            kind: 'milestone',
            origin: 'future',
            status: 'waiting',
            title: 'Future item',
            updatedAt: 1,
          },
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    } as Metadata;

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET)?.({})).resolves.toEqual({
      workState: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('passes through stable unsupported results from runtime goal controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const unsupportedSet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.set',
    };
    const unsupportedGet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.get',
    };
    const unsupportedClear = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.clear',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        refreshGoal: vi.fn(async () => unsupportedGet),
        setGoal: vi.fn(async () => unsupportedSet),
        clearGoal: vi.fn(async () => unsupportedClear),
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual(unsupportedGet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: 'Unsupported native goal',
    })).resolves.toEqual(unsupportedSet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual(unsupportedClear);
  });

  it('returns unsupported when connected-service auth invalidation controls are unavailable', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
    });
  });
});
