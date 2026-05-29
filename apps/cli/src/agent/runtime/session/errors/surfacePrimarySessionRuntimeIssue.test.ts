import { describe, expect, it, vi } from 'vitest';

import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import * as runtimeIssueSurface from './surfacePrimarySessionRuntimeIssue';

function createLifecycleStub(overrides: Partial<SessionTurnLifecycle>): SessionTurnLifecycle {
  return {
    beginTurn: vi.fn(),
    attachProviderTurnId: vi.fn(),
    appendTranscriptAnchors: vi.fn(),
    completeTurn: vi.fn(),
    failTurn: vi.fn(),
    cancelTurn: vi.fn(),
    endSession: vi.fn(),
    markRollbackEligible: vi.fn(),
    markRolledBack: vi.fn(),
    ...overrides,
  };
}

describe('surfacePrimarySessionRuntimeIssue', () => {
  it('surfaces provider failures as failed primary turn runtime issues', async () => {
    const sendAgentMessage = vi.fn();
    const failTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'codex',
      providerTurnId: 'turn_1',
      sessionSeq: 7,
      occurredAt: 123,
      cause: 'status_error',
      error: new Error('401 raw token should not be stored'),
      session: { sendAgentMessage, sessionTurnLifecycle: createLifecycleStub({ failTurn }) },
    });

    expect(issue).toMatchObject({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'auth_error',
      source: 'auth_error',
      occurredAt: 123,
      sessionSeq: 7,
      provider: 'codex',
      providerTurnId: 'turn_1',
      sanitizedPreview: 'Authentication failed',
    });
    expect(JSON.stringify(issue)).not.toContain('raw token');
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(failTurn).toHaveBeenCalledWith({
      provider: 'codex',
      providerTurnId: 'turn_1',
      issue,
    });
  });

  it('preserves sanitized model-not-found session error details', async () => {
    const failTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'opencode',
      providerTurnId: 'turn_model',
      occurredAt: 456,
      cause: 'session_error',
      error: {
        name: 'UnknownError',
        message: 'OpenCode session failed',
        data: { message: 'Model not found: anthropic/claude-sonnet-4-6.' },
      },
      session: { sessionTurnLifecycle: createLifecycleStub({ failTurn }) },
    });

    expect(issue).toMatchObject({
      code: 'provider_session_error',
      source: 'provider_session_error',
      provider: 'opencode',
      providerTurnId: 'turn_model',
      sanitizedPreview: 'Model not found: anthropic/claude-sonnet-4-6',
    });
    expect(failTurn).toHaveBeenCalledWith(expect.objectContaining({ issue }));
  });

  it('surfaces cancellation as cancelled primary turn state without a runtime issue', async () => {
    const sendAgentMessage = vi.fn();
    const cancelTurn = vi.fn();

    const issue = await runtimeIssueSurface.surfacePrimarySessionRuntimeIssue({
      provider: 'claude',
      cause: 'cancelled',
      session: { sendAgentMessage, sessionTurnLifecycle: createLifecycleStub({ cancelTurn }) },
    });

    expect(issue).toBeNull();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(cancelTurn).toHaveBeenCalledWith({
      provider: 'claude',
    });
  });

  it('records in-progress and completed session turn states through lifecycle helpers', async () => {
    const beginTurn = vi.fn();
    const completeTurn = vi.fn();

    expect(runtimeIssueSurface).not.toHaveProperty('recordPrimaryTurnInProgress');
    expect(runtimeIssueSurface).not.toHaveProperty('recordPrimaryTurnCompleted');

    await runtimeIssueSurface.recordSessionTurnInProgress({
      provider: 'codex',
      session: { sessionTurnLifecycle: createLifecycleStub({ beginTurn }) },
    });
    await runtimeIssueSurface.recordSessionTurnCompleted({
      provider: 'codex',
      providerTurnId: 'turn_1',
      session: { sessionTurnLifecycle: createLifecycleStub({ completeTurn }) },
    });

    expect(beginTurn).toHaveBeenCalledWith({
      provider: 'codex',
    });
    expect(completeTurn).toHaveBeenCalledWith({
      provider: 'codex',
      providerTurnId: 'turn_1',
    });
  });
});
