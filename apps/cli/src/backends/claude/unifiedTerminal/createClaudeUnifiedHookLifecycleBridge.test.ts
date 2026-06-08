import { describe, expect, it, vi } from 'vitest';

import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';

describe('createClaudeUnifiedHookLifecycleBridge', () => {
  it('reconciles a provider-accepted prompt on UserPromptSubmit', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const confirmPromptAcceptedByProvider = vi.fn().mockResolvedValue(true);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(confirmPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('notifies provider prompt start before acceptance reconciliation on UserPromptSubmit', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const calls: string[] = [];
    const onProviderPromptStarted = vi.fn(() => {
      calls.push('provider_prompt_started');
    });
    const confirmPromptAcceptedByProvider = vi.fn(async () => {
      calls.push('accepted');
      return true;
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider,
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });

      expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(confirmPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
      });
      expect(calls).toEqual(['provider_prompt_started', 'accepted']);
    } finally {
      bridge.dispose();
    }
  });

  it('waits for async provider prompt start before completing a terminal-originated turn', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let resolveProviderStarted: (() => void) | undefined;
    const onProviderPromptStarted = vi.fn(() => new Promise<void>((resolve) => {
      resolveProviderStarted = resolve;
    }));
    const onReady = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onProviderPromptStarted,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
      });

      hook({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        background_tasks: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onReady).not.toHaveBeenCalled();
      resolveProviderStarted?.();
      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('blocks input injection while Claude is waiting on a permission request and redrains after completion', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: true });

      hook({ hook_event_name: 'PostToolUse', session_id: 'claude-session-id', tool_use_id: 'toolu_1' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'permission', blocked: false });
      await vi.waitFor(() => {
        expect(drainWhenSafe).toHaveBeenCalled();
      });
    } finally {
      bridge.dispose();
    }
  });

  it('forwards Claude compaction hooks to the input arbiter lifecycle', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'PreCompact', session_id: 'claude-session-id' });
      hook({ hook_event_name: 'PostCompact', session_id: 'claude-session-id' });

      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'started' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'completed' });
    } finally {
      bridge.dispose();
    }
  });

  it('forwards Claude compact boundary transcript rows as compaction completion', async () => {
    const observeLifecycle = vi.fn();
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: () => null,
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
    });

    try {
      bridge.observeTranscript({
        type: 'system',
        uuid: 'compact-boundary-1',
        subtype: 'compact_boundary',
        session_id: 'claude-session-id',
      } as any);

      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'compaction', phase: 'completed' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      expect(observeLifecycle).toHaveBeenCalledWith({ type: 'output' });
      expect(drainWhenSafe).toHaveBeenCalledTimes(1);
    } finally {
      bridge.dispose();
    }
  });

  it('waits for async ready completion before redraining after a completed turn', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let resolveReady: (() => void) | undefined;
    const observeLifecycle = vi.fn();
    const onReady = vi.fn(() => new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));
    const drainWhenSafe = vi.fn().mockResolvedValue(undefined);
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(true),
        drainWhenSafe,
      },
      completionQuiescenceMs: 0,
      onReady,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      await vi.waitFor(() => {
        expect(onReady).not.toHaveBeenCalled();
      });

      hook({
        hook_event_name: 'Stop',
        session_id: 'claude-session-id',
        background_tasks: [],
      });

      await vi.waitFor(() => {
        expect(onReady).toHaveBeenCalledTimes(1);
      });
      expect(observeLifecycle).not.toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      expect(drainWhenSafe).not.toHaveBeenCalled();
      resolveReady?.();
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
      await vi.waitFor(() => {
        expect(drainWhenSafe).toHaveBeenCalledTimes(1);
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces hook-only StopFailure rate-limit details', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        error: 'rate_limit',
        error_type: 'legacy_should_not_win',
      } as any);

      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          v: 1,
          providerLimitId: 'rate_limit',
          recoverability: 'wait',
        }));
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces hook-only StopFailure overloaded details from the last assistant message', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle: vi.fn(),
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'StopFailure',
        session_id: 'claude-session-id',
        error: 'server_error',
        last_assistant_message: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      } as any);

      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          v: 1,
          limitCategory: 'capacity',
          providerLimitId: 'server_overloaded',
          recoverability: 'wait',
        }));
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces transcript-only Claude auth API errors and marks the turn failed', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onRuntimeAuthFailureEvent,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'assistant-auth-failure',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      } as any);

      await vi.waitFor(() => {
        expect(onRuntimeAuthFailureEvent).toHaveBeenCalledWith(expect.objectContaining({
          error: 'authentication_failed',
        }));
      });
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
    } finally {
      bridge.dispose();
    }
  });

  it('surfaces transcript-only provider API errors as terminal prompt failures', async () => {
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const observeLifecycle = vi.fn();
    const onPromptTurnTerminal = vi.fn();
    const onUsageLimitDetails = vi.fn();
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter: {
        observeLifecycle,
        confirmPromptAcceptedByProvider: vi.fn().mockResolvedValue(false),
        drainWhenSafe: vi.fn().mockResolvedValue(undefined),
      },
      completionQuiescenceMs: 0,
      onPromptTurnTerminal,
      onUsageLimitDetails,
    });

    try {
      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });
      bridge.observeTranscript({
        type: 'assistant',
        uuid: 'assistant-provider-error',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
        },
      } as any);

      await vi.waitFor(() => {
        expect(onPromptTurnTerminal).toHaveBeenCalledWith({
          reason: 'failed',
          source: 'claude_transcript_api_error',
          detail: 'api_error',
        });
      });
      await vi.waitFor(() => {
        expect(onUsageLimitDetails).toHaveBeenCalledWith(expect.objectContaining({
          limitCategory: 'capacity',
          providerLimitId: 'server_overloaded',
        }));
      });
      await vi.waitFor(() => {
        expect(observeLifecycle).toHaveBeenCalledWith({ type: 'turn_state', state: 'idle' });
      });
    } finally {
      bridge.dispose();
    }
  });
});
