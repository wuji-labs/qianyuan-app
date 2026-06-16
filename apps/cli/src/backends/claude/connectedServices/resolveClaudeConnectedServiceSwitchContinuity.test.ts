import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectedServiceSwitchContinuityParams } from '@/backends/types';

import { resolveClaudeConnectedServiceSwitchContinuity } from './resolveClaudeConnectedServiceSwitchContinuity';

const CLAUDE_ROLLBACK_ENV = 'HAPPIER_CONNECTED_SERVICES_LEGACY_CLAUDE_RESTART_SAME_HOME';

const claudeEnvKeys = [
  CLAUDE_ROLLBACK_ENV,
  'CLAUDE_CONFIG_DIR',
  'HAPPIER_CLAUDE_CONFIG_DIR',
  'HOME',
  'USERPROFILE',
] as const;

const originalClaudeEnv = new Map<string, string | undefined>(
  claudeEnvKeys.map((key) => [key, process.env[key]]),
);

function restoreClaudeEnv(): void {
  for (const [key, value] of originalClaudeEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createParams(
  overrides: Partial<ConnectedServiceSwitchContinuityParams> = {},
): ConnectedServiceSwitchContinuityParams {
  return {
    sessionId: 'session-1',
    agentId: 'claude',
    serviceId: 'claude-subscription',
    previousBinding: {
      source: 'connected',
      selection: 'profile',
      serviceId: 'claude-subscription',
      profileId: 'old',
      groupId: null,
    },
    nextBinding: {
      source: 'connected',
      selection: 'profile',
      serviceId: 'claude-subscription',
      profileId: 'new',
      groupId: null,
    },
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'old' },
      },
    },
    toBindings: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'new' },
      },
    },
    ...overrides,
  };
}

describe('resolveClaudeConnectedServiceSwitchContinuity', () => {
  afterEach(() => {
    restoreClaudeEnv();
  });

  it('fails closed when exact restart context cannot be proven reachable', async () => {
    await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
      previousBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: null,
      },
      nextBinding: {
        source: 'connected',
        selection: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: null,
      },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'materialization-1',
        createdAtMs: 1,
      },
      vendorResumeId: 'vendor-session-1',
    }))).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('returns restart_same_home when the target materialized Claude config has the resume id', async () => {
    const ambientClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-ambient-claude-continuity-'));
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-target-claude-continuity-'));
    try {
      await mkdir(join(ambientClaudeConfigDir, 'projects', 'project-1'), { recursive: true });
      await writeFile(join(ambientClaudeConfigDir, 'projects', 'project-1', 'ambient-session.jsonl'), '{}\n');
      await mkdir(join(targetClaudeConfigDir, 'projects', 'project-1'), { recursive: true });
      await writeFile(join(targetClaudeConfigDir, 'projects', 'project-1', 'vendor-session-1.jsonl'), '{}\n');
      process.env.CLAUDE_CONFIG_DIR = ambientClaudeConfigDir;

      await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
        previousBinding: {
          source: 'connected',
          selection: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'work',
          groupId: null,
        },
        nextBinding: {
          source: 'connected',
          selection: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'work',
          groupId: null,
        },
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'materialization-1',
          createdAtMs: 1,
        },
        vendorResumeId: 'vendor-session-1',
        targetMaterializedRoot: targetClaudeConfigDir,
        targetMaterializedEnv: {
          CLAUDE_CONFIG_DIR: targetClaudeConfigDir,
        },
        cwd: process.cwd(),
      }))).resolves.toEqual({ mode: 'restart_same_home' });
    } finally {
      await rm(ambientClaudeConfigDir, { recursive: true, force: true });
      await rm(targetClaudeConfigDir, { recursive: true, force: true });
    }
  });

  it('requires shared state when switching between different Claude connected-service profiles', async () => {
    await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'materialization-1',
        createdAtMs: 1,
      },
      vendorResumeId: 'vendor-session-1',
    }))).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_shared_state_required',
    });
  });

  it('uses restart_same_home for Claude subscription group member switches targeting the shared group config dir', async () => {
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-group-config-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-root-'));
    try {
      await mkdir(join(runtimeClaudeConfigDir, 'projects', 'project-1'), { recursive: true });
      await writeFile(join(runtimeClaudeConfigDir, 'projects', 'project-1', 'vendor-session-1.jsonl'), '{}\n');
      await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
        previousBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'claude',
        },
        nextBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'claude',
        },
        runtimeAuthSelection: {
          serviceId: 'claude-subscription',
          targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
          targetMaterializedRoot: runtimeClaudeConfigDir,
          claudeRuntimeAuthSharedGroupSurface: {
            mode: 'shared_group_auth_surface',
            runtimeClaudeConfigDir,
            runtimeMaterializedRoot: runtimeClaudeConfigDir,
            sourceClaudeConfigDir,
          },
        },
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
        targetMaterializedRoot: runtimeClaudeConfigDir,
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'materialization-1',
          createdAtMs: 1,
        },
        vendorResumeId: 'vendor-session-1',
        cwd: process.cwd(),
      }))).resolves.toEqual({ mode: 'restart_same_home' });
    } finally {
      await rm(runtimeClaudeConfigDir, { recursive: true, force: true });
      await rm(sourceClaudeConfigDir, { recursive: true, force: true });
    }
  });

  it('fails closed when Claude subscription group same-home restart cannot prove resume reachability', async () => {
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-group-config-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-root-'));
    try {
      await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
        previousBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'claude',
        },
        nextBinding: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'claude',
        },
        runtimeAuthSelection: {
          serviceId: 'claude-subscription',
          targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
          targetMaterializedRoot: runtimeClaudeConfigDir,
          claudeRuntimeAuthSharedGroupSurface: {
            mode: 'shared_group_auth_surface',
            runtimeClaudeConfigDir,
            runtimeMaterializedRoot: runtimeClaudeConfigDir,
            sourceClaudeConfigDir,
          },
        },
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
        targetMaterializedRoot: runtimeClaudeConfigDir,
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'materialization-1',
          createdAtMs: 1,
        },
        vendorResumeId: 'vendor-session-1',
        cwd: process.cwd(),
      }))).resolves.toMatchObject({
        mode: 'unsupported',
        reason: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          reachabilityMissReason: 'claude_native_store_unreachable',
          vendorResumeId: 'vendor-session-1',
        },
      });
    } finally {
      await rm(runtimeClaudeConfigDir, { recursive: true, force: true });
      await rm(sourceClaudeConfigDir, { recursive: true, force: true });
    }
  });

  it('requires shared state when switching Claude group members without a same-home restart shared group target', async () => {
    await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
      previousBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'claude-subscription',
        profileId: 'batiplus',
        groupId: 'claude',
      },
      nextBinding: {
        source: 'connected',
        selection: 'group',
        serviceId: 'claude-subscription',
        profileId: 'leeroy_batiplus',
        groupId: 'claude',
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'claude', profileId: 'batiplus' },
        },
      },
      toBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'group', groupId: 'claude', profileId: 'leeroy_batiplus' },
        },
      },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'materialization-1',
        createdAtMs: 1,
      },
      vendorResumeId: 'vendor-session-1',
    }))).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_shared_state_required',
    });
  });

  it('requires shared state when moving between native and connected Claude auth', async () => {
    await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'claude-subscription',
        profileId: null,
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'native' },
        },
      },
    }))).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'claude_session_state_sharing_required',
    });
  });

  it('restores legacy optimistic restart behavior when rollback env is enabled', async () => {
    process.env[CLAUDE_ROLLBACK_ENV] = '1';
    await expect(resolveClaudeConnectedServiceSwitchContinuity(createParams({
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'claude-subscription',
        profileId: null,
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'native' },
        },
      },
    }))).resolves.toEqual({ mode: 'restart_same_home' });
  });
});
