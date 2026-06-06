import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TrackedSession } from '@/daemon/types';

type ContinuationContextModule = Readonly<{
  resolveConnectedServiceContinuationProviderContextAvailability: (input: {
    tracked: Pick<TrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'>;
  }) => Promise<boolean>;
  replayPendingConnectedServiceContinuationsForTrackedSessions: (input: {
    trackedSessions: Iterable<Pick<TrackedSession, 'happySessionId' | 'happySessionMetadataFromLocalWebhook' | 'spawnOptions' | 'vendorResumeId'>>;
    resolvePendingContinuation: (input: {
      sessionId: string;
      exactProviderContextAvailable: boolean;
    }) => Promise<void> | void;
  }) => Promise<{ attemptedSessionIds: string[] }>;
}>;

async function loadContinuationContextModule(): Promise<ContinuationContextModule> {
  const modulePath = './connectedServiceContinuationProviderContext';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  expect(typeof (mod as Partial<ContinuationContextModule> | null)?.resolveConnectedServiceContinuationProviderContextAvailability)
    .toBe('function');
  expect(typeof (mod as Partial<ContinuationContextModule> | null)?.replayPendingConnectedServiceContinuationsForTrackedSessions)
    .toBe('function');
  return mod as ContinuationContextModule;
}

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'session-1',
    pid: 123,
    spawnOptions: {
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'materialization-1',
        createdAtMs: 1_000,
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile-1',
          },
        },
      },
    },
    ...overrides,
  };
}

describe('connected service continuation provider context', () => {
  it('requires connected-service materialization identity and exact provider context reachability before replaying continuation', async () => {
    const {
      resolveConnectedServiceContinuationProviderContextAvailability,
    } = await loadContinuationContextModule();
    const claudeRoot = await mkdtemp(join(tmpdir(), 'happier-claude-continuation-context-'));

    try {
      const claudeSessionId = 'claude-session-1';
      const claudeConfigDir = join(claudeRoot, 'claude-config');
      const claudeSessionFile = join(
        claudeConfigDir,
        'projects',
        '-tmp-project',
        `${claudeSessionId}.jsonl`,
      );
      await mkdir(join(claudeConfigDir, 'projects', '-tmp-project'), { recursive: true });
      await writeFile(claudeSessionFile, '{}\n');

      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession(),
      })).resolves.toBe(false);
      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({ vendorResumeId: claudeSessionId }),
      })).resolves.toBe(false);
      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          vendorResumeId: claudeSessionId,
          spawnOptions: (() => {
            const baseSpawnOptions = trackedSession().spawnOptions;
            if (!baseSpawnOptions) {
              throw new Error('Expected default tracked-session spawn options');
            }
            return {
              ...baseSpawnOptions,
              environmentVariables: {
                CLAUDE_CONFIG_DIR: claudeConfigDir,
              },
            };
          })(),
        }),
      })).resolves.toBe(true);
      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'materialization-1',
              createdAtMs: 1_000,
            },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                openai: {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'profile-1',
                },
              },
            },
          },
          vendorResumeId: 'opencode-session-1',
        }),
      })).resolves.toBe(false);
      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'materialization-1',
              createdAtMs: 1_000,
            },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                  profileId: 'profile-1',
                },
              },
            },
          },
          vendorResumeId: 'codex-session-1',
        }),
      })).resolves.toBe(false);
    } finally {
      await rm(claudeRoot, { recursive: true, force: true });
    }
  });

  it('requires PI reachability proof before marking provider context available', async () => {
    const {
      resolveConnectedServiceContinuationProviderContextAvailability,
    } = await loadContinuationContextModule();

    const root = await mkdtemp(join(tmpdir(), 'happier-pi-continuation-context-'));
    try {
      const sessionFile = join(
        root,
        'pi-agent-dir',
        'sessions',
        '--tmp-project--',
        '2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          vendorResumeId: 'pi-session-1',
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'materialization-1',
              createdAtMs: 1_000,
            },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                openai: {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'profile-1',
                },
              },
            },
            environmentVariables: {
              PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
            },
          },
          happySessionMetadataFromLocalWebhook: {
            path: '/tmp/project',
            host: 'host',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
            piSessionFile: sessionFile,
          },
        }),
      })).resolves.toBe(true);

      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          vendorResumeId: 'pi-session-missing',
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'materialization-1',
              createdAtMs: 1_000,
            },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                openai: {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'profile-1',
                },
              },
            },
            environmentVariables: {
              PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
            },
          },
        }),
      })).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reconstructs PI materialized context and uses the tracked resume file when env has no target root', async () => {
    const {
      resolveConnectedServiceContinuationProviderContextAvailability,
    } = await loadContinuationContextModule();

    const root = await mkdtemp(join(tmpdir(), 'happier-pi-native-continuation-context-'));
    try {
      const sessionFile = join(
        root,
        'pi-agent-dir',
        'sessions',
        '--tmp-project--',
        '2026-06-01T10-00-00-000Z_pi-native-session-1.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
            resume: sessionFile,
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'materialization-1',
              createdAtMs: 1_000,
            },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                openai: {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'profile-1',
                },
              },
            },
          },
        }),
      })).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses durable metadata identity and provider resume context when tracked spawn options are incomplete', async () => {
    const {
      resolveConnectedServiceContinuationProviderContextAvailability,
    } = await loadContinuationContextModule();

    const root = await mkdtemp(join(tmpdir(), 'happier-pi-metadata-continuation-context-'));
    try {
      const sessionFile = join(
        root,
        'pi-agent-dir',
        'sessions',
        '--tmp-project--',
        '2026-06-01T11-00-00-000Z_pi-metadata-session-1.jsonl',
      );
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionFile, '{}\n');

      await expect(resolveConnectedServiceContinuationProviderContextAvailability({
        tracked: trackedSession({
          spawnOptions: {
            directory: '/tmp/project',
            backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                openai: {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'profile-1',
                },
              },
            },
          },
          happySessionMetadataFromLocalWebhook: {
            path: '/tmp/project',
            host: 'host',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
            connectedServiceMaterializationIdentityV1: {
              v: 1,
              id: 'metadata-materialization-1',
              createdAtMs: 1_000,
            },
            agentRuntimeDescriptorV1: {
              v: 1,
              providerId: 'pi',
              provider: {
                resumeStrategy: 'sessionFileAbsolutePreferred',
                vendorSessionId: 'pi-metadata-session-1',
                sessionFile,
              },
            },
            piSessionFile: sessionFile,
          },
        }),
      })).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not bypass exact provider-context checks when connected-service bindings exist only in metadata', async () => {
    const {
      resolveConnectedServiceContinuationProviderContextAvailability,
    } = await loadContinuationContextModule();

    await expect(resolveConnectedServiceContinuationProviderContextAvailability({
      tracked: trackedSession({
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        },
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/project',
          host: 'host',
          homeDir: '/home/user',
          happyHomeDir: '/home/user/.happy',
          happyLibDir: '/home/user/.happy/lib',
          happyToolsDir: '/home/user/.happy/tools',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              openai: {
                source: 'connected',
                selection: 'profile',
                profileId: 'profile-1',
              },
            },
          },
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'metadata-materialization-1',
            createdAtMs: 1_000,
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'pi',
            provider: {
              resumeStrategy: 'sessionFileAbsolutePreferred',
              vendorSessionId: 'pi-metadata-session-1',
              sessionFile: '/tmp/missing/pi-session.jsonl',
            },
          },
          piSessionFile: '/tmp/missing/pi-session.jsonl',
        },
      }),
    })).resolves.toBe(false);
  });

  it('replays pending continuation attempts for reattached sessions at daemon startup with exact context status', async () => {
    const {
      replayPendingConnectedServiceContinuationsForTrackedSessions,
    } = await loadContinuationContextModule();
    const resolvePendingContinuation = vi.fn(async () => {});
    const claudeRoot = await mkdtemp(join(tmpdir(), 'happier-claude-continuation-replay-'));
    try {
      const claudeSessionId = 'claude-session-1';
      const claudeConfigDir = join(claudeRoot, 'claude-config');
      await mkdir(join(claudeConfigDir, 'projects', '-tmp-project'), { recursive: true });
      await writeFile(
        join(claudeConfigDir, 'projects', '-tmp-project', `${claudeSessionId}.jsonl`),
        '{}\n',
      );

      await expect(replayPendingConnectedServiceContinuationsForTrackedSessions({
        trackedSessions: [
          trackedSession({ happySessionId: 'session-without-provider-context' }),
          trackedSession({
            happySessionId: 'session-with-provider-context',
            vendorResumeId: claudeSessionId,
            spawnOptions: (() => {
              const baseSpawnOptions = trackedSession().spawnOptions;
              if (!baseSpawnOptions) {
                throw new Error('Expected default tracked-session spawn options');
              }
              return {
                ...baseSpawnOptions,
                environmentVariables: {
                  CLAUDE_CONFIG_DIR: claudeConfigDir,
                },
              };
            })(),
          }),
          trackedSession({ happySessionId: '   ', vendorResumeId: 'ignored' }),
        ],
        resolvePendingContinuation,
      })).resolves.toEqual({
        attemptedSessionIds: ['session-without-provider-context', 'session-with-provider-context'],
      });

      expect(resolvePendingContinuation).toHaveBeenCalledWith({
        sessionId: 'session-without-provider-context',
        exactProviderContextAvailable: false,
      });
      expect(resolvePendingContinuation).toHaveBeenCalledWith({
        sessionId: 'session-with-provider-context',
        exactProviderContextAvailable: true,
      });
      expect(resolvePendingContinuation).toHaveBeenCalledTimes(2);
    } finally {
      await rm(claudeRoot, { recursive: true, force: true });
    }
  });
});
