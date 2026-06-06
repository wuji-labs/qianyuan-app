import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { watchDevServerAndRestart } from './server.mjs';

async function withTempServerDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-dev-server-watch-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return await fn(dir);
}

function createWatcherOptions(serverDir, overrides = {}) {
  return {
    enabled: true,
    stackMode: true,
    serverComponentName: 'happier-server-light',
    serverDir,
    serverPort: 34567,
    internalServerUrl: 'http://127.0.0.1:34567',
    serverScript: 'dev:light',
    serverEnv: {},
    runtimeStatePath: join(serverDir, 'stack.runtime.json'),
    stackName: 'watch-test',
    envPath: join(serverDir, 'env'),
    children: [],
    serverProcRef: { current: { pid: process.pid, exitCode: null } },
    isShuttingDown: () => false,
    ...overrides,
  };
}

test('watchDevServerAndRestart watches server-light because dev:light does not self-reload', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    const watcher = watchDevServerAndRestart(createWatcherOptions(serverDir));

    try {
      assert.ok(watcher, 'expected a server-light watcher when stack watch mode is enabled');
      assert.equal(typeof watcher.close, 'function');
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart serializes pending server-light restarts', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    let firstReadyCompleted = false;
    let concurrentRestartStarted = false;
    const killedPids = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: true };
        },
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          if (spawnCalls > 1 && !firstReadyCompleted) {
            concurrentRestartStarted = true;
          }
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
          if (readyCalls === 1) {
            await capturedOnChange({ eventType: 'change', filename: 'second-change.ts' });
            assert.equal(spawnCalls, 1, 'pending change must not spawn before the active restart is ready');
            firstReadyCompleted = true;
          }
        },
        logger: { log() {}, error() {} },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.equal(concurrentRestartStarted, false);
      assert.equal(spawnCalls, 2);
      assert.equal(readyCalls, 2);
      assert.deepEqual(killedPids, [101, 201]);
      assert.deepEqual(
        children.map((child) => child.pid),
        [201, 202]
      );
      assert.equal(serverProcRef.current.pid, 202);
    } finally {
      watcher?.close?.();
    }
  });
});

test('watchDevServerAndRestart refuses to spawn when existing server is not stack-owned and port is occupied', async (t) => {
  await withTempServerDir(t, async (serverDir) => {
    let capturedOnChange = null;
    let spawnCalls = 0;
    let readyCalls = 0;
    const killedPids = [];
    const errors = [];
    const children = [];
    const serverProcRef = { current: { pid: 101, exitCode: null } };

    const watcher = watchDevServerAndRestart(
      createWatcherOptions(serverDir, { children, serverProcRef }),
      {
        watchDebouncedImpl: ({ onChange }) => {
          capturedOnChange = onChange;
          return { close() {} };
        },
        killProcessGroupOwnedByStackImpl: async (pid) => {
          killedPids.push(pid);
          return { killed: false, reason: 'not_owned' };
        },
        isTcpPortFreeImpl: async () => false,
        pmSpawnScriptImpl: async () => {
          spawnCalls += 1;
          return { pid: 200 + spawnCalls, exitCode: null };
        },
        recordStackRuntimeUpdateImpl: async () => {},
        waitForServerReadyImpl: async () => {
          readyCalls += 1;
        },
        logger: {
          log() {},
          error(message) {
            errors.push(String(message));
          },
        },
      }
    );

    try {
      assert.ok(watcher);
      assert.equal(typeof capturedOnChange, 'function');

      await capturedOnChange({ eventType: 'change', filename: 'first-change.ts' });

      assert.deepEqual(killedPids, [101]);
      assert.equal(spawnCalls, 0);
      assert.equal(readyCalls, 0);
      assert.deepEqual(children, []);
      assert.equal(serverProcRef.current.pid, 101);
      assert.ok(errors.some((message) => message.includes('server restart failed')));
    } finally {
      watcher?.close?.();
    }
  });
});
