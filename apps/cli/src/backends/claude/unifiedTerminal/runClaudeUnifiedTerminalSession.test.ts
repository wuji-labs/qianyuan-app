import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TERMINAL_INPUT_QUIET_PERIOD_MS } from '@/agent/runtime/terminal/injection/arbiter';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import type { SessionHookData } from '../utils/startHookServer';
import type { EnhancedMode } from '../loop';
import type { RawJSONLines } from '../types';
import { getProjectPath } from '../utils/path';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: loggerMock,
}));

function createAbortableSignal(): AbortController {
  return new AbortController();
}

class FakeProcessSignals {
  private readonly listeners = new Map<string, Set<() => void>>();

  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    const wrapped = () => {
      this.removeListener(event, wrapped);
      listener();
    };
    listeners.add(wrapped);
    this.listeners.set(event, listeners);
  }

  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'SIGINT' | 'SIGTERM'): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener();
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('runClaudeUnifiedTerminalSession', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    loggerMock.debug.mockClear();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a terminal host, binds TerminalInputInjectionV1, and injects the first queued prompt', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    let consumed = false;
    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      claudeArgs: ['--model', 'sonnet'],
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'line one\nline two',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude', '--model', 'sonnet'],
        spawnEnv: { DISABLE_AUTOUPDATER: '1' },
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    expect(adapter.createOrAttachHost).toHaveBeenCalledWith({
      sessionName: 'happier-claude-session-test',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/bin/claude', '--model', 'sonnet'],
      spawnEnv: { DISABLE_AUTOUPDATER: '1' },
      isolatedEnv: true,
    });
    expect(adapter.injectUserPrompt).toHaveBeenCalledTimes(1);
    expect(injected).toEqual(['line one\nline two']);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_resolved',
      properties: {
        kind: 'tmux',
        platform: process.platform,
        preference: 'tmux',
        reason: 'test',
      },
    });
  });

  it('creates the terminal host from initial mode before any queued UI message resolves', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
        model: 'sonnet',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async ({ first }) => ({
        spawnArgv: ['/bin/claude', '--model', first.mode.model ?? ''],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
      expect(adapter.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
        spawnArgv: ['/bin/claude', '--model', 'sonnet'],
      }));
      expect(adapter.injectUserPrompt).not.toHaveBeenCalled();

      releaseQueuedMessage({
        message: 'queued after startup',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
          model: 'sonnet',
        },
      });

      await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
      expect(adapter.injectUserPrompt).toHaveBeenCalledWith(handle, expect.objectContaining({
        text: 'queued after startup',
      }));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects the first queued prompt after empty startup before SessionStart when terminal input is ready', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);

      releaseQueuedMessage({
        message: 'queued before SessionStart',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      });

      await waitUntil(() => injected.length === 1, 2_000);
      expect(injected).toEqual(['queued before SessionStart']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('imports a prompt-correlated transcript when empty-started Claude does not emit SessionStart', async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const abortController = createAbortableSignal();
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-no-hook-transcript-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const prompt = 'Please reply with exactly: QA_LINUX_TMUX_FIXED_OK';
    const claudeSessionId = '33333333-3333-4333-8333-333333333333';
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    const importedMessages: RawJSONLines[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        await writeFile(transcriptPath, `${[
          {
            type: 'user',
            uuid: 'prompt-correlated-user-row',
            sessionId: claudeSessionId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: input.text,
            },
          },
          {
            type: 'assistant',
            uuid: 'prompt-correlated-assistant-row',
            sessionId: claudeSessionId,
            timestamp: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'QA_LINUX_TMUX_FIXED_OK' }],
              stop_reason: 'end_turn',
            },
          },
        ].map((message) => JSON.stringify(message)).join('\n')}\n`);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let releaseQueuedMessage!: (value: {
      message: string;
      mode: EnhancedMode;
    }) => void;
    const nextMessage = vi.fn(() => new Promise<{
      message: string;
      mode: EnhancedMode;
    }>((resolve) => {
      releaseQueuedMessage = resolve;
    }));

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
      onMessage: (message) => {
        importedMessages.push(message);
        if (message.type === 'assistant') {
          abortController.abort();
        }
      },
    });

    try {
      await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
      releaseQueuedMessage({
        message: prompt,
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      });

      await waitUntil(
        () => importedMessages.some((message) => message.type === 'assistant' && message.uuid === 'prompt-correlated-assistant-row'),
        5_000,
      );
      expect(importedMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          uuid: 'prompt-correlated-user-row',
        }),
        expect.objectContaining({
          type: 'assistant',
          uuid: 'prompt-correlated-assistant-row',
        }),
      ]));
    } finally {
      abortController.abort();
      await sessionPromise;
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('passes the resolved default coding prompt into the terminal spawn builder', async () => {
    const abortController = createAbortableSignal();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 1 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const options = {
      path: '/workspace/project',
      systemPromptText: 'Resolved default coding prompt',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async (params) => {
        expect(params.systemPromptText).toBe('Resolved default coding prompt');
        return {
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        };
      },
      createSessionName: () => 'happier-claude-session-test',
    } satisfies Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      systemPromptText: string;
    };

    await runClaudeUnifiedTerminalSession(options);
  });

  it('persists terminal-host attachment info by Happy session id once the host is created', async () => {
    const abortController = createAbortableSignal();
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const options = {
      path: '/workspace/project',
      sessionId: null,
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo,
    } as Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      happySessionId: string;
      persistTerminalHostAttachmentInfo: typeof persistTerminalHostAttachmentInfo;
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-session-test:unified-window',
        },
      },
    });
  });

  it('removes matching terminal-host attachment info after terminal host disposal', async () => {
    const abortController = createAbortableSignal();
    const persistTerminalHostAttachmentInfo = vi.fn(async () => {});
    const removeTerminalHostAttachmentInfo = vi.fn(async () => {});
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'zellij',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo,
      removeTerminalHostAttachmentInfo,
    });

    const expectedTerminal = {
      mode: 'zellij',
      zellij: {
        sessionName: 'happier-claude-session-test',
        paneId: 'terminal_7',
      },
    };
    expect(persistTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: expectedTerminal,
    });
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(removeTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal: expectedTerminal,
    });
  });

  it('notifies when the terminal host is ready with attachable metadata', async () => {
    const abortController = createAbortableSignal();
    const onTerminalHostReady = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: 1, bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const options = {
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo: vi.fn(async () => {}),
      onTerminalHostReady,
    } as Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onTerminalHostReady: typeof onTerminalHostReady;
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(onTerminalHostReady).toHaveBeenCalledWith({
      handle,
      terminal: {
        mode: 'tmux',
        tmux: {
          target: 'happier-claude-session-test:unified-window',
        },
      },
    });
  });

  it('starts the unified controller before notifying foreground attach readiness', async () => {
    const abortController = createAbortableSignal();
    const events: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      persistTerminalHostAttachmentInfo: vi.fn(async () => {}),
      createController: () => ({
        run: async () => {
          events.push('controller-run');
        },
        dispose: async () => {},
      }),
      onTerminalHostReady: () => {
        events.push('host-ready');
        abortController.abort();
      },
    });

    expect(events).toEqual(['controller-run', 'host-ready']);
  });

  it('disposes the terminal host and hook subscription when setup fails after host creation', async () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let hookUnsubscribed = false;
    const setTurnInterrupt = vi.fn();

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {
        hookUnsubscribed = true;
      },
      setTurnInterrupt,
      createController: () => {
        throw new Error('controller setup failed');
      },
    })).rejects.toThrow('controller setup failed');

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(hookUnsubscribed).toBe(true);
    expect(setTurnInterrupt).toHaveBeenLastCalledWith(null);
  });

  it('binds process signal cleanup immediately after terminal host creation', async () => {
    const processSignals = new FakeProcessSignals();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let disposedDuringControllerSetup = false;

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController: async () => {
        processSignals.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 10));
        disposedDuringControllerSetup = vi.mocked(adapter.dispose).mock.calls.length > 0;
        throw new Error('controller setup failed');
      },
    })).rejects.toThrow('controller setup failed');

    expect(disposedDuringControllerSetup).toBe(true);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('cleans up provisional and completed terminal hosts when a process signal arrives during host creation', async () => {
    const processSignals = new FakeProcessSignals();
    const hostCreated = createDeferred<TerminalHostHandle>();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => hostCreated.promise),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const createController = vi.fn();

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController,
    });

    await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
    processSignals.emit('SIGTERM');
    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    hostCreated.resolve(handle);
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenNthCalledWith(1, {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
      },
    });
    expect(adapter.dispose).toHaveBeenNthCalledWith(2, handle);
    expect(createController).not.toHaveBeenCalled();
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
  });

  it('targets the requested tmux window during provisional process-signal cleanup', async () => {
    const processSignals = new FakeProcessSignals();
    const hostCreated = createDeferred<TerminalHostHandle>();
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => hostCreated.promise),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      createController: vi.fn(),
    });

    await waitUntil(() => vi.mocked(adapter.createOrAttachHost).mock.calls.length === 1);
    processSignals.emit('SIGTERM');
    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    hostCreated.resolve({
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    });
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenNthCalledWith(1, {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: 'happier-claude-session-test',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
      },
    });
  });

  it('does not continue into controller setup when a process signal arrives while persisting terminal metadata', async () => {
    const processSignals = new FakeProcessSignals();
    const persistStarted = createDeferred<void>();
    const persistFinished = createDeferred<void>();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const createController = vi.fn(() => {
      throw new Error('controller should not be created after SIGTERM');
    });

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      happySessionId: 'happy-session-id',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
      persistTerminalHostAttachmentInfo: async () => {
        persistStarted.resolve();
        await persistFinished.promise;
      },
      createController,
    });

    await persistStarted.promise;
    processSignals.emit('SIGTERM');
    persistFinished.resolve();
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
    expect(createController).not.toHaveBeenCalled();
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
  });

  it('disposes the terminal host on process SIGTERM even when the caller signal was not aborted', async () => {
    const abortController = createAbortableSignal();
    const processSignals = new FakeProcessSignals();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => ({ status: 'injected', at: Date.now(), bytesWritten: input.text.length }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'queued prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
    });

    await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
    processSignals.emit('SIGTERM');

    await waitUntil(() => vi.mocked(adapter.dispose).mock.calls.length === 1);
    await sessionPromise;

    expect(abortController.signal.aborted).toBe(false);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('logs terminal disposal failures observed during process signal cleanup', async () => {
    const abortController = createAbortableSignal();
    const processSignals = new FakeProcessSignals();
    const disposalError = new Error('terminal cleanup failed');
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => ({ status: 'injected', at: Date.now(), bytesWritten: input.text.length }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {
        throw disposalError;
      }),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'queued prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      processSignals,
    });

    await waitUntil(() => vi.mocked(adapter.injectUserPrompt).mock.calls.length === 1);
    processSignals.emit('SIGINT');

    await waitUntil(() => loggerMock.debug.mock.calls.some((call) =>
      String(call[0]).includes('process signal cleanup')
      && call[1] === disposalError,
    ));
    await sessionPromise;

    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('shares and disposes one pre-host Claude hook subscription across lifecycle bridges', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-cleanup-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_cleanup.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    let subscriptionCount = 0;
    let unsubscribeCount = 0;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_cleanup',
      transcriptPath,
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => {
        subscriptionCount += 1;
        return () => {
          unsubscribeCount += 1;
        };
      },
      onMessage: vi.fn(),
    });

    await waitUntil(() => subscriptionCount === 1);
    abortController.abort();

    await sessionPromise;
    expect(subscriptionCount).toBe(1);
    expect(unsubscribeCount).toBe(1);
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('waits for terminal startup readiness before injecting the first queued prompt', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let terminalReady = false;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: terminalReady,
        currentInput: terminalReady ? '' : 'Claude is restoring the previous session',
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      sessionId: 'claude-session-id',
      transcriptPath: '/tmp/claude-session.jsonl',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'resume follow-up',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(injected).toEqual([]);
      terminalReady = true;
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['resume follow-up']);
      expect(adapter.captureInputState).toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('waits for Claude SessionStart before first injection when lifecycle hooks are available', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'wait for session start',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'tmux',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 950));
      expect(injected).toEqual([]);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');

      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });

      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['wait for session start']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects an allowed CLI startup prompt before SessionStart when terminal input is ready', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'cli startup prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: () => () => {},
    });

    try {
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['cli startup prompt']);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('injects an allowed first prompt before transcript bridge startup completes', async () => {
    const abortController = createAbortableSignal();
    const committedKeys = createDeferred<ReadonlySet<string>>();
    const injected: string[] = [];
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'first prompt while transcript starts',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      allowFirstInputBeforeSessionStart: true,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      onMessage: vi.fn(),
      loadCommittedClaudeJsonlMessageKeys: () => committedKeys.promise,
    });

    try {
      await waitUntil(() => injected.length === 1, 2_500);
      expect(injected).toEqual(['first prompt while transcript starts']);
    } finally {
      committedKeys.resolve(new Set());
      abortController.abort();
      await sessionPromise;
    }
  });

  it('does not miss SessionStart emitted while the terminal host is being created', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-early-hook-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_early_hook.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant_seen_before_controller_run',
      sessionId: 'sess_early_hook',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'written before bridge startup' }],
      },
    })}\n`);

    const abortController = createAbortableSignal();
    const subscribedHooks = new Set<(data: SessionHookData) => void>();
    const onMessage = vi.fn();
    let consumed = false;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => {
        for (const callback of subscribedHooks) {
          callback({
            hook_event_name: 'SessionStart',
            session_id: 'sess_early_hook',
            transcript_path: transcriptPath,
          });
        }
        return handle;
      }),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: null,
      transcriptPath: null,
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'first prompt',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHooks.add(callback);
        return () => {
          subscribedHooks.delete(callback);
        };
      },
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    const failFast = setTimeout(() => {
      abortController.abort();
    }, 750);

    try {
      await waitUntil(() => onMessage.mock.calls.length === 1, 1_000);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_seen_before_controller_run',
      }));
    } finally {
      clearTimeout(failFast);
      abortController.abort();
      await sessionPromise;
    }
  });

  it('starts hook and transcript bridges while terminal startup readiness is still pending', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-pending-readiness-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_pending_readiness.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: 'assistant_seen_during_pending_readiness',
      sessionId: 'sess_pending_readiness',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hydrated while readiness is pending' }],
      },
    })}\n`);

    const abortController = createAbortableSignal();
    const subscribedHooks = new Set<(data: SessionHookData) => void>();
    const onMessage = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: '1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'deferred', reason: 'pane_initializing' } as const)),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: false, currentInput: 'user is typing', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: null,
      transcriptPath: null,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHooks.add(callback);
        return () => {
          subscribedHooks.delete(callback);
        };
      },
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => subscribedHooks.size > 0 && (adapter.captureInputState as ReturnType<typeof vi.fn>).mock.calls.length > 0, 1_000);
      for (const callback of subscribedHooks) {
        callback({
          hook_event_name: 'SessionStart',
          session_id: 'sess_pending_readiness',
          transcript_path: transcriptPath,
        });
      }

      await waitUntil(() => onMessage.mock.calls.length === 1, 1_000);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_seen_during_pending_readiness',
      }));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('fails closed when the selected terminal host is unavailable', async () => {
    const telemetry = { emit: vi.fn() };

    await expect(
      runClaudeUnifiedTerminalSession({
        path: '/workspace/project',
        nextMessage: async () => ({
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        }),
        resolveHostAdapter: async () => ({
          status: 'disabled',
          reason: 'windows_arm64_unsupported',
          message: 'No supported terminal host is available.',
        }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        telemetry,
      }),
    ).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_unavailable',
    });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_resolved',
      properties: {
        kind: 'disabled',
        platform: process.platform,
        preference: 'zellij',
        reason: 'windows_arm64_unsupported',
      },
    });
    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.windows_guard_triggered',
      properties: {
        guard: 'windows_arm64_unsupported',
        hostKind: 'zellij',
        platform: 'win32',
      },
    });
  });

  it('emits host-dead telemetry when a resolved terminal host dies before startup bridges run', async () => {
    const telemetry = { emit: vi.fn() };
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const liveness = {
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
      observedAt: 123,
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => liveness),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(
      runClaudeUnifiedTerminalSession({
        path: '/workspace/project',
        nextMessage: async () => ({
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        }),
        resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        telemetry,
        initialHostLivenessTimeoutMs: 1,
        initialHostLivenessPollMs: 1,
      }),
    ).rejects.toMatchObject({
      code: 'claude_unified_terminal_host_dead',
      liveness,
    });

    expect(telemetry.emit).toHaveBeenCalledWith({
      name: 'unified.session.host_dead',
      properties: {
        hostKind: 'zellij',
        sessionName: 'happier-claude-session-test',
        paneId: 'terminal_1',
        paneAlive: false,
        paneDead: true,
        paneCurrentCommand: '/managed/node',
        paneExitStatus: 127,
        observedAt: 123,
      },
    });
    expect(adapter.dispose).toHaveBeenCalledWith(handle);
  });

  it('removes an unread launch spec when terminal host creation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-unified-launch-spec-fail-'));
    tempDirs.push(dir);
    const specPath = join(dir, 'launch.json');
    await writeFile(specPath, JSON.stringify({ command: '/bin/claude', args: [], cwd: dir, env: {} }), { mode: 0o600 });
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        throw new Error('tmux failed before launching runner');
      }),
      injectUserPrompt: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      nextMessage: async () => ({
        message: 'hello',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/managed/node', '/happier/scripts/terminal_launch_spec_runner.cjs', specPath],
        spawnEnv: {},
        launchSpecPath: specPath,
      }),
      createSessionName: () => 'happier-claude-session-test',
    })).rejects.toThrow('tmux failed before launching runner');

    expect(existsSync(specPath)).toBe(false);
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('does not subscribe to Claude hooks before launch spec construction succeeds', async () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: 1, bytesWritten: 1 }) as const),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let subscriptions = 0;

    await expect(runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => {
        throw new Error('launch spec failed');
      },
      subscribeClaudeSessionHooks: () => {
        subscriptions += 1;
        return () => {};
      },
    })).rejects.toThrow('launch spec failed');

    expect(subscriptions).toBe(0);
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('treats prompt-input SessionEnd followed by clean terminal exit as graceful shutdown', async () => {
    const abortController = createAbortableSignal();
    const telemetry = { emit: vi.fn() };
    let paneAlive = true;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      evaluateLiveness: vi.fn(async () => (paneAlive
        ? { paneAlive: true, observedAt: Date.now() }
        : {
            paneAlive: false,
            paneDead: true,
            paneCurrentCommand: '/managed/node',
            paneExitStatus: 0,
            observedAt: Date.now(),
          })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      telemetry,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 5_000);
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      hook({
        hook_event_name: 'SessionEnd',
        session_id: 'claude-session-id',
        reason: 'prompt_input_exit',
      });
      paneAlive = false;

      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 1_200);
        }),
      ]);

      expect(result).toEqual({ kind: 'resolved' });
      expect(telemetry.emit).not.toHaveBeenCalledWith(expect.objectContaining({
        name: 'unified.session.host_dead',
      }));
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('fails instead of waiting forever when the terminal host stays dead after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let paneAlive = true;
    let deadLivenessCalls = 0;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        if (!paneAlive) deadLivenessCalls += 1;
        return { paneAlive, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
        resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude'],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-session-test',
        telemetry,
      });

    try {
      await waitUntil(() => injected.length === 1);
      paneAlive = false;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 3_000);
        }),
      ]);

      expect(result).toMatchObject({
        kind: 'error',
        error: {
          code: 'claude_unified_terminal_host_dead',
        },
      });
      expect(deadLivenessCalls).toBeGreaterThanOrEqual(2);
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.session.host_dead',
        properties: {
          hostKind: 'zellij',
          sessionName: 'happier-claude-session-test',
          paneId: 'terminal_1',
          paneAlive: false,
          observedAt: expect.any(Number),
        },
      });
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('fails instead of waiting forever when terminal liveness becomes unreachable after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let livenessCalls = 0;
    let throwOnLiveness = false;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        livenessCalls += 1;
        if (throwOnLiveness) {
          throw new Error('zellij list-panes failed: There is no active session!');
        }
        return { paneAlive: true, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => injected.length === 1);
      const callsBeforeFailure = livenessCalls;
      throwOnLiveness = true;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 3_000);
        }),
      ]);

      expect(livenessCalls).toBeGreaterThan(callsBeforeFailure);
      expect(result).toMatchObject({
        kind: 'error',
        error: {
          code: 'claude_unified_terminal_host_dead',
        },
      });
      expect(telemetry.emit).toHaveBeenCalledWith({
        name: 'unified.session.host_dead',
        properties: expect.objectContaining({
          hostKind: 'zellij',
          sessionName: 'happier-claude-session-test',
          paneId: 'terminal_1',
        }),
      });
      expect(adapter.dispose).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('survives a single transient terminal liveness probe failure after prompt injection', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const telemetry = { emit: vi.fn() };
    let throwRemaining = 0;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => {
        if (throwRemaining > 0) {
          throwRemaining -= 1;
          throw new Error('zellij list-panes failed: transient timeout');
        }
        return { paneAlive: true, observedAt: Date.now() };
      }),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      telemetry,
    });

    try {
      await waitUntil(() => injected.length === 1);
      throwRemaining = 1;
      const result = await Promise.race([
        sessionPromise
          .then(() => ({ kind: 'resolved' as const }))
          .catch((error: unknown) => ({ kind: 'error' as const, error })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'timeout' }), 1_500);
        }),
      ]);

      expect(result).toEqual({ kind: 'timeout' });
      expect(telemetry.emit).not.toHaveBeenCalledWith(expect.objectContaining({
        name: 'unified.session.host_dead',
      }));
    } finally {
      abortController.abort();
      await sessionPromise.catch(() => undefined);
    }
  });

  it('surfaces ambiguous provider acceptance timeouts without aborting the terminal host', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onTerminalInjectionFailure = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happier-claude-session-test',
      paneId: 'terminal_1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    let consumed = false;
    let settlement: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | null = null;
    const options = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return null;
        consumed = true;
        return {
          message: 'hello',
          mode: {
            permissionMode: 'default',
            claudeUnifiedTerminalHost: 'zellij',
          },
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved' as const, adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      providerAcceptanceTimeoutMs: 20,
      onTerminalInjectionFailure,
    } satisfies Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      providerAcceptanceTimeoutMs: number;
      onTerminalInjectionFailure: typeof onTerminalInjectionFailure;
    };
    const sessionPromise = runClaudeUnifiedTerminalSession(options)
      .then(() => {
        settlement = { kind: 'resolved' };
      })
      .catch((error: unknown) => {
        settlement = { kind: 'rejected', error };
      });

    try {
      await waitUntil(() => injected.length === 1);
      await waitUntil(() => onTerminalInjectionFailure.mock.calls.length > 0 || settlement !== null, 6_000);

      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_ambiguous',
        reason: 'timeout',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        recoverable: true,
      }));
      expect(settlement).toBeNull();
      expect(adapter.dispose).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('uses Claude session hooks to redrain queued prompts after a terminal turn completes', async () => {
    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const events: string[] = [];
    let resolveReady: (() => void) | undefined;
    const onThinkingChange = vi.fn();
    const onReady = vi.fn(() => new Promise<void>((resolve) => {
      events.push('ready-start');
      resolveReady = () => {
        events.push('ready-finished');
        resolve();
      };
    }));
    const onMessage = vi.fn((message: RawJSONLines) => {
      const uuid = typeof (message as Record<string, unknown>).uuid === 'string'
        ? (message as Record<string, unknown>).uuid
        : 'unknown';
      events.push(`message:${uuid}`);
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        events.push(`inject:${input.text}`);
        injected.push(input.text);
        if (input.text === 'second') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const firstMessage: Readonly<{ message: string; mode: EnhancedMode }> = {
      message: 'first',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    };
    const secondMessage: Readonly<{ message: string; mode: EnhancedMode }> = {
      message: 'second',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    };
    let firstMessageConsumed = false;
    let secondMessageConsumed = false;
    let resolveSecondMessage: (() => void) | undefined;
    const secondMessageReady = new Promise<void>((resolve) => {
      resolveSecondMessage = resolve;
    });

    const options: Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onThinkingChange: typeof onThinkingChange;
      onReady: typeof onReady;
    } = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (!firstMessageConsumed) {
          firstMessageConsumed = true;
          return firstMessage;
        }
        if (!secondMessageConsumed) {
          await secondMessageReady;
          secondMessageConsumed = true;
          return secondMessage;
        }
        return null;
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      lifecycleCompletionQuiescenceMs: 0,
    };

    const sessionPromise = runClaudeUnifiedTerminalSession(options);

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);
      expect(injected).toEqual(['first']);

      hook({ hook_event_name: 'UserPromptSubmit' });
      expect(onThinkingChange).toHaveBeenLastCalledWith(true);
      hook({ hook_event_name: 'Stop' });

      await waitUntil(() => onReady.mock.calls.length === 1, 5_000);
      resolveSecondMessage?.();
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_INPUT_QUIET_PERIOD_MS + 50));
      expect(injected).toEqual(['first']);
      resolveReady?.();
      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['first', 'second']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(events.indexOf('ready-finished')).toBeLessThan(events.indexOf('inject:second'));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('notifies only successfully injected prompts as accepted by the terminal runtime', async () => {
    const abortController = createAbortableSignal();
    const onTerminalPromptInjected = vi.fn();
    const acceptedMode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => {
        abortController.abort();
        return { status: 'injected', at: Date.now(), bytesWritten: 5 } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const options: Parameters<typeof runClaudeUnifiedTerminalSession<EnhancedMode>>[0] & {
      onTerminalPromptInjected: typeof onTerminalPromptInjected;
    } = {
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => ({
        message: 'accepted',
        mode: acceptedMode,
      }),
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      onTerminalPromptInjected,
    };

    await runClaudeUnifiedTerminalSession(options);

    expect(onTerminalPromptInjected).toHaveBeenCalledTimes(1);
    expect(onTerminalPromptInjected).toHaveBeenCalledWith({
      message: 'accepted',
      mode: acceptedMode,
      acceptedAs: 'new_turn',
      turnStateAtInjection: 'idle',
    });
  });

  it('forwards terminal-originated UserPromptSubmit hooks as provider prompt starts', async () => {
    const abortController = createAbortableSignal();
    const onProviderPromptStarted = vi.fn();
    const injected: string[] = [];
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const messages: Array<{ message: string; mode: EnhancedMode }> = [
      {
        message: 'first',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      },
    ];
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onProviderPromptStarted,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-id',
        transcript_path: '/tmp/claude-session.jsonl',
      });
      await waitUntil(() => injected.length === 1, 5_000);

      hook({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session-id' });

      expect(onProviderPromptStarted).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('registers terminal host interruption as the remote turn interrupt handler', async () => {
    const abortController = createAbortableSignal();
    let interruptHandler: (() => Promise<void>) | null | undefined;
    const setTurnInterrupt = vi.fn((handler: (() => Promise<void>) | null) => {
      interruptHandler = handler;
    });
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async () => ({ status: 'injected', at: Date.now(), bytesWritten: 0 }) as const),
      interruptTurn: vi.fn(async () => {}),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: Date.now() })),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      signal: abortController.signal,
      nextMessage: async () => null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      setTurnInterrupt,
      createController: () => ({
        run: async () => {},
        dispose: async () => {},
      }),
    });

    try {
      await waitUntil(() => typeof interruptHandler === 'function');
      await interruptHandler?.();
      expect(adapter.interruptTurn).toHaveBeenCalledWith(handle);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
    expect(setTurnInterrupt).toHaveBeenLastCalledWith(null);
  });

  it('uses transcript turn signals to mark completion and drain the next queued prompt', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-transcript-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_transcript.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onThinkingChange = vi.fn();
    const events: string[] = [];
    const onReady = vi.fn(() => {
      events.push('ready');
    });
    const onMessage = vi.fn((message: RawJSONLines) => {
      const uuid = typeof (message as Record<string, unknown>).uuid === 'string'
        ? (message as Record<string, unknown>).uuid
        : 'unknown';
      events.push(`message:${uuid}`);
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        if (input.text === 'second') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const messages = [
      { message: 'first', mode },
      { message: 'second', mode },
    ];

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_transcript',
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_transcript',
        transcript_path: transcriptPath,
      });
      await waitUntil(() => injected.length === 1);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'user_1',
        message: { content: 'first' },
      })}\n`);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant_1',
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        },
      })}\n`);

      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['first', 'second']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
        uuid: 'assistant_1',
      }));
      expect(events).toEqual(expect.arrayContaining(['message:assistant_1', 'ready']));
      expect(events.indexOf('message:assistant_1')).toBeLessThan(events.indexOf('ready'));
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });

  it('uses compact boundary transcript signals to complete standalone compact turns and drain queued prompts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-run-compact-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'sess_compact.jsonl');
    await writeFile(transcriptPath, '');

    const abortController = createAbortableSignal();
    const injected: string[] = [];
    const onThinkingChange = vi.fn();
    const onReady = vi.fn();
    const onMessage = vi.fn();
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-session-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected.push(input.text);
        if (input.text === 'follow-up after compact') {
          abortController.abort();
        }
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const mode: EnhancedMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    };
    const messages = [
      { message: '/compact', mode },
      { message: 'follow-up after compact', mode },
    ];

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: tempDir,
      sessionId: 'sess_compact',
      transcriptPath,
      signal: abortController.signal,
      nextMessage: async () => messages.shift() ?? null,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude'],
        spawnEnv: {},
      }),
      createSessionName: () => 'happier-claude-session-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      onThinkingChange,
      onReady,
      onMessage,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function');
      const hook = subscribedHook;
      expect(hook).toBeTypeOf('function');
      if (typeof hook !== 'function') throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'SessionStart',
        session_id: 'sess_compact',
        transcript_path: transcriptPath,
      });
      await waitUntil(() => injected.length === 1);
      expect(injected).toEqual(['/compact']);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'compact_command_marker',
        message: {
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      })}\n`);
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'system',
        uuid: 'compact_boundary_1',
        subtype: 'compact_boundary',
        session_id: 'sess_compacted',
      })}\n`);

      await waitUntil(() => injected.length === 2, 5_000);
      expect(injected).toEqual(['/compact', 'follow-up after compact']);
      expect(onThinkingChange).toHaveBeenLastCalledWith(false);
      expect(onReady).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await sessionPromise;
    }
  });
});
