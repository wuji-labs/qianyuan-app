import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import type { Credentials } from '@/persistence';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { materializeClaudeConnectedServiceRuntimeAuthSelection } from './materializeClaudeConnectedServiceRuntimeAuthSelection';

describe('materializeClaudeConnectedServiceRuntimeAuthSelection', () => {
  it('materializes selected group Claude subscription OAuth as native Claude Code auth', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-project-'));
    const projectDir = join(projectRoot, 'repo');
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(homeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: { accessToken: 'ambient-root-token-must-not-copy' },
        projects: {
          [projectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            allowedTools: ['Bash(*)'],
          },
        },
      })}\n`,
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const previousBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV1 = {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: projectDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
          CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
        },
      },
    };

    const result = await materializeClaudeConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      } satisfies Credentials,
      api: {} as ApiClient,
      activeServerDir,
      input: {
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
        profileId: 'backup',
        groupId: 'work',
        activeProfileId: 'backup',
        fallbackProfileId: 'fallback',
        generation: 3,
        record,
      },
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
    });

    expect(result).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 3,
      targetMaterializedEnv: {
        CLAUDE_CONFIG_DIR: join(
          activeServerDir,
          'daemon',
          'connected-services',
          'homes',
          'claude-subscription',
          '__groups',
          'work',
          'claude',
          'claude-config',
        ),
      },
    });
    const materializedEnv = (result as { targetMaterializedEnv?: Record<string, string> }).targetMaterializedEnv;
    expect(materializedEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(materializedEnv?.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();

    const credential = JSON.parse(await readFile(join(materializedEnv!.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    expect(credential.claudeAiOauth.refreshToken).toBe('selected-refresh-placeholder');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    const targetRootConfig = JSON.parse(await readFile(join(materializedEnv!.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8'));
    expect(targetRootConfig.oauthAccount).toBeUndefined();
    expect(targetRootConfig.projects).toEqual({
      [projectDir]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    await expect(readFile(join(materializedEnv!.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('preserves the previous stable native credential file when runtime rematerialization write fails', async () => {
    const fixedUuid = 'runtime-write-failure';
    vi.resetModules();
    vi.doMock('node:crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:crypto')>();
      return {
        ...actual,
        randomUUID: () => fixedUuid,
      };
    });
    const runtimeAuthSelectionModule: typeof import('./materializeClaudeConnectedServiceRuntimeAuthSelection') =
      await import('./materializeClaudeConnectedServiceRuntimeAuthSelection');
    const {
      materializeClaudeConnectedServiceRuntimeAuthSelection: materializeWithFixedUuid,
    } = runtimeAuthSelectionModule;

    try {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-server-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-home-'));
      const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-runtime-selection-source-'));
      const targetClaudeConfigDir = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'claude-subscription',
        '__groups',
        'work',
        'claude',
        'claude-config',
      );
      await mkdir(targetClaudeConfigDir, { recursive: true });
      await writeFile(
        join(targetClaudeConfigDir, '.credentials.json'),
        `${JSON.stringify({
          claudeAiOauth: {
            accessToken: 'stable-access-placeholder',
            refreshToken: 'stable-refresh-placeholder',
            expiresAt: 1_000,
            scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
          },
        })}\n`,
      );
      await mkdir(join(targetClaudeConfigDir, `.credentials.${fixedUuid}.tmp`), { recursive: true });
      const record = buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: 'backup',
        kind: 'oauth',
        expiresAt: 2_000,
        oauth: {
          accessToken: 'replacement-access-placeholder',
          refreshToken: 'replacement-refresh-placeholder',
          idToken: null,
          scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
          tokenType: 'Bearer',
          providerAccountId: 'provider-account',
          providerEmail: null,
        },
      });
      const previousBindings: ConnectedServiceBindingsV1 = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'primary',
          },
        },
      };
      const normalizedBindings: ConnectedServiceBindingsV1 = {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'work',
            profileId: 'backup',
          },
        },
      };
      const tracked: TrackedSession = {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: sourceClaudeConfigDir,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          connectedServices: previousBindings,
          environmentVariables: {
            CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          },
        },
      };

      const result = await materializeWithFixedUuid({
        credentials: {
          token: 'token',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        } satisfies Credentials,
        api: {} as ApiClient,
        activeServerDir,
        input: {
          tracked,
          sessionId: 'sess_1',
          agentId: 'claude',
          serviceId: 'claude-subscription',
          previous: {
            source: 'connected',
            selection: 'group',
            serviceId: 'claude-subscription',
            profileId: 'primary',
            groupId: 'work',
          },
          next: {
            source: 'connected',
            selection: 'group',
            serviceId: 'claude-subscription',
            profileId: 'backup',
            groupId: 'work',
          },
          previousBindings,
          normalizedBindings,
          groupMetadata: {
            groupId: 'work',
            activeProfileId: 'backup',
            fallbackProfileId: 'fallback',
            generation: 3,
          },
        },
        baseSelection: {
          serviceId: 'claude-subscription',
          binding: normalizedBindings.bindingsByServiceId['claude-subscription'],
          profileId: 'backup',
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
          record,
        },
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
      });

      expect(result).toEqual(expect.objectContaining({
        materializationDiagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: 'claude_subscription_native_auth_materialization_failed',
            reason: 'credential_file_write_failed',
            severity: 'blocking',
          }),
        ]),
      }));
      const preservedCredential = JSON.parse(await readFile(join(targetClaudeConfigDir, '.credentials.json'), 'utf8'));
      expect(preservedCredential.claudeAiOauth.accessToken).toBe('stable-access-placeholder');
      expect(preservedCredential.claudeAiOauth.refreshToken).toBe('stable-refresh-placeholder');
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});
