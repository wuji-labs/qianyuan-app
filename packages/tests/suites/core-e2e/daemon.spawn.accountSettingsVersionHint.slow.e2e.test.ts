import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: daemon spawn account settings version hints', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('fails daemon spawn before prompt construction when the requested account settings version is unavailable', async () => {
    const testDir = run.testDir(`daemon-spawn-account-settings-version-hint-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    const spawnRes = await daemonControlPostJson<{ success: boolean; error?: string; errorCode?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken: daemon.state.controlToken,
      body: {
        directory: workspaceDir,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'plain' },
        accountSettingsVersionHint: 1_000_000,
        environmentVariables: daemonEnv,
      },
      timeoutMs: 90_000,
    });

    expect(spawnRes.status).toBe(500);
    expect(spawnRes.data.success).toBe(false);
    expect(spawnRes.data.errorCode).toBe('ACCOUNT_SETTINGS_STALE');
  }, 240_000);
});
