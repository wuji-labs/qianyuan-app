import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS } from '@happier-dev/cli-common/firstPartyRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('sessionRegistry', () => {
  const releaseEnvScope = createEnvKeyScope(STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS);
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalReleaseRing = process.env.HAPPIER_RELEASE_RING;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-session-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    releaseEnvScope.patch({
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
      HAPPIER_RELEASE_RING: undefined,
      HAPPIER_RELEASE_CHANNEL: undefined,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    releaseEnvScope.restore();
    if (originalReleaseRing === undefined) {
      delete process.env.HAPPIER_RELEASE_RING;
    } else {
      process.env.HAPPIER_RELEASE_RING = originalReleaseRing;
    }
  });

  it('should write a marker and preserve createdAt across updates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-1',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers1 = await listSessionMarkers();
    expect(markers1).toHaveLength(1);
    expect(markers1[0].pid).toBe(12345);
    expect(markers1[0].happySessionId).toBe('sess-1');
    expect(markers1[0].happyHomeDir).toBe(configuration.happyHomeDir);
    expect(typeof markers1[0].createdAt).toBe('number');
    expect(typeof markers1[0].updatedAt).toBe('number');

    const createdAt1 = markers1[0].createdAt;
    const updatedAt1 = markers1[0].updatedAt;

    vi.setSystemTime(updatedAt1 + 1_000);

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-2',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers2 = await listSessionMarkers();
    expect(markers2).toHaveLength(1);
    expect(markers2[0].createdAt).toBe(createdAt1);
    expect(markers2[0].updatedAt).toBeGreaterThan(updatedAt1);
    expect(markers2[0].happySessionId).toBe('sess-2');
  });

  it('should ignore markers with wrong happyHomeDir and tolerate invalid JSON', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });
    // Write a marker with different happyHomeDir
    writeFileSync(
      join(dir, 'pid-111.json'),
      JSON.stringify({ pid: 111, happySessionId: 'x', happyHomeDir: '/other', createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8'
    );
    // Write invalid JSON
    writeFileSync(join(dir, 'pid-222.json'), '{', 'utf-8');

    const markers = await listSessionMarkers();
    expect(markers).toEqual([]);
  });

  it('removeSessionMarker should not throw if the marker does not exist', async () => {
    const { removeSessionMarker } = await import('./sessionRegistry');
    await expect(removeSessionMarker(99999)).resolves.toBeUndefined();
  });

  it('refreshSessionMarkerRespawn rewrites the respawn descriptor from updated spawn options and preserves marker identity fields', async () => {
    const { listSessionMarkers, refreshSessionMarkerRespawn, writeSessionMarker } = await import('./sessionRegistry');
    const { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } = await import('./processSupervision/sessionRunnerRespawnDescriptor');

    const previousBindings = {
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' } },
    };
    const processCommandHash = 'b'.repeat(64);
    const previousRespawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/work',
      connectedServices: previousBindings,
    });
    expect(previousRespawn).not.toBeNull();
    await writeSessionMarker({
      pid: 7777,
      happySessionId: 'sess-switch',
      startedBy: 'daemon',
      cwd: '/tmp/work',
      processCommandHash,
      metadata: { path: '/tmp/work' },
      respawn: previousRespawn!,
    });

    // Hot-applied auth switch updates tracked spawn options in memory; the
    // durable marker must follow or the next daemon restores stale bindings
    // and treats real switch requests as 'unchanged'.
    const updatedBindings = {
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new-profile' } },
    };
    await refreshSessionMarkerRespawn({
      pid: 7777,
      spawnOptions: {
        directory: '/tmp/work',
        connectedServices: updatedBindings,
        connectedServicesUpdatedAt: 1234,
      },
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(marker.happySessionId).toBe('sess-switch');
    expect(marker.processCommandHash).toBe(processCommandHash);
    expect(marker.metadata).toEqual({ path: '/tmp/work' });
    expect((marker.respawn as { connectedServices?: unknown } | undefined)?.connectedServices).toEqual(updatedBindings);
  });

  it('refreshSessionMarkerRespawn is a no-op when no marker exists for the pid', async () => {
    const { listSessionMarkers, refreshSessionMarkerRespawn } = await import('./sessionRegistry');

    await refreshSessionMarkerRespawn({
      pid: 8888,
      spawnOptions: { directory: '/tmp/none' },
    });

    await expect(listSessionMarkers()).resolves.toHaveLength(0);
  });

  it('marks and clears connected-service restart intent on an existing marker', async () => {
    const {
      clearSessionMarkerConnectedServiceRestartIntent,
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 9991,
      happySessionId: 'sess-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/work',
    });

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 9991,
      requestedAtMs: 12_345,
    })).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 9991,
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 12_345,
        },
      }),
    ]);

    await clearSessionMarkerConnectedServiceRestartIntent(9991);

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).not.toHaveProperty('connectedServiceRestartIntent');
  });

  it('does not create a connected-service restart intent marker when no session marker exists', async () => {
    const { listSessionMarkers, markSessionMarkerConnectedServiceRestartIntent } = await import('./sessionRegistry');

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 9992,
      requestedAtMs: 12_345,
    })).resolves.toBe(false);

    await expect(listSessionMarkers()).resolves.toHaveLength(0);
  });

  it('promotes connected-service restart intent from a wrapper marker to an existing runner marker', async () => {
    const registry = await import('./sessionRegistry');
    const {
      listSessionMarkers,
      promoteSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = registry;

    await writeSessionMarker({
      pid: 9993,
      happySessionId: 'sess-promote-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/wrapper',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 44_000,
      },
    });
    await writeSessionMarker({
      pid: 9994,
      happySessionId: 'sess-promote-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/runner',
      processCommandHash: 'c'.repeat(64),
      metadata: { owner: 'runner' },
    });

    await expect(promoteSessionMarkerConnectedServiceRestartIntent({
      fromPid: 9993,
      toPid: 9994,
    })).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pid: 9994,
        cwd: '/tmp/runner',
        processCommandHash: 'c'.repeat(64),
        metadata: { owner: 'runner' },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 44_000,
        },
      }),
    ]));
  });

  it('writes valid JSON payload shape to disk', async () => {
    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('./sessionRegistry');

    // 64 hex chars (sha256)
    const processCommandHash = 'a'.repeat(64);

    await writeSessionMarker({
      pid: 54321,
      happySessionId: 'sess-xyz',
      startedBy: 'daemon',
      cwd: '/tmp',
      processCommandHash,
      processCommand: 'node dist/index.mjs --started-by daemon',
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54321.json');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(54321);
    expect(parsed.happySessionId).toBe('sess-xyz');
    expect(parsed.happyHomeDir).toBe(configuration.happyHomeDir);
    expect(parsed.startedBy).toBe('daemon');
    expect(parsed.processCommandHash).toBe(processCommandHash);
    expect(parsed.processCommand).toBe('node dist/index.mjs --started-by daemon');
    expect(typeof parsed.createdAt).toBe('number');
    expect(typeof parsed.updatedAt).toBe('number');
  });

  it('allows concurrent marker refreshes for the same pid', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await expect(
      Promise.all([
        writeSessionMarker({
          pid: 12346,
          happySessionId: 'sess-concurrent-a',
          startedBy: 'daemon',
          cwd: '/tmp',
        }),
        writeSessionMarker({
          pid: 12346,
          happySessionId: 'sess-concurrent-b',
          startedBy: 'daemon',
          cwd: '/tmp',
        }),
      ]),
    ).resolves.toHaveLength(2);

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(
      expect.objectContaining({
        pid: 12346,
        startedBy: 'daemon',
      }),
    );
  });

  it('supports opencode flavor markers', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 777,
      happySessionId: 'sess-opencode',
      startedBy: 'terminal',
      flavor: 'opencode',
      cwd: '/tmp',
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(777);
    expect(markers[0].flavor).toBe('opencode');
  });

  it('writes markers into a channel-scoped tmp dir for the dev public ring', async () => {
    process.env.HAPPIER_RELEASE_RING = 'dev';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 9001,
      happySessionId: 'sess-dev',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markerPath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.dev', 'pid-9001.json');
    expect(existsSync(markerPath)).toBe(true);
  });

  it('reads legacy unscoped markers for the preview ring during marker migration', async () => {
    process.env.HAPPIER_RELEASE_RING = 'preview';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const legacyDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(legacyDir, { recursive: true });

    writeFileSync(
      join(legacyDir, 'pid-4242.json'),
      JSON.stringify(
        {
          pid: 4242,
          happySessionId: 'sess-legacy-preview',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          startedBy: 'daemon',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const markers = await listSessionMarkers();
    expect(markers).toEqual([
      expect.objectContaining({
        pid: 4242,
        happySessionId: 'sess-legacy-preview',
      }),
    ]);
  });

  it('removes both scoped and legacy marker files for preview ring cleanup', async () => {
    process.env.HAPPIER_RELEASE_RING = 'preview';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { removeSessionMarker } = await import('./sessionRegistry');

    const legacyDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    const scopedDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.preview');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(scopedDir, { recursive: true });

    writeFileSync(
      join(legacyDir, 'pid-5151.json'),
      JSON.stringify({ pid: 5151, happySessionId: 'sess-legacy', happyHomeDir: configuration.happyHomeDir, createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(scopedDir, 'pid-5151.json'),
      JSON.stringify({ pid: 5151, happySessionId: 'sess-scoped', happyHomeDir: configuration.happyHomeDir, createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8',
    );

    await removeSessionMarker(5151);

    expect(existsSync(join(legacyDir, 'pid-5151.json'))).toBe(false);
    expect(existsSync(join(scopedDir, 'pid-5151.json'))).toBe(false);
  });

  it('tolerates older respawn markers with experimentalCodexResume', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, 'pid-333.json'),
      JSON.stringify(
        {
          pid: 333,
          happySessionId: 'sess-333',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          respawn: {
            version: 1,
            directory: '/tmp',
            experimentalCodexResume: true,
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(333);
    expect(markers[0].respawn).toMatchObject({
      version: 1,
      directory: '/tmp',
      codexBackendMode: 'acp',
    });
    expect(markers[0].respawn).not.toHaveProperty('experimentalCodexResume');
  });

});
