import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';

import {
  ConnectedServiceSpawnResumeUnreachableError,
  resolveConnectedServiceAuthForSpawn,
} from './resolveConnectedServiceAuthForSpawn';

/**
 * K1 increment-3 — the §2 hard post-materialization reachability RE-VERIFY gate.
 *
 * These tests exercise the spawn path AFTER `materializeConnectedServicesForSpawn` produces the real
 * materialized env/root, BEFORE the vendor launches. They prove the TARGET the vendor will actually
 * read — not "hope the import lands":
 *   - RED: shared-state continuity requested + a resume id whose session file is genuinely absent from
 *     every target/native root => the spawn FAILS CLOSED with the structured continuity reason
 *     (`provider_session_state_unavailable_for_resume`, failurePhase `continuity`) instead of
 *     returning an env the vendor would crash on ("Pi process exited").
 *   - GREEN: native session file exists, the import lands in the materialized target => the gate
 *     proves reachability and the spawn proceeds (env returned).
 *   - D8 cross-machine fallback: a stale persisted absolute `piSessionFile` that fails to stat must
 *     NOT hard-fail when the id+cwd native search can still resolve the session.
 *   - Guard: a fresh (no-resume) spawn, and an isolated (no continuity) spawn, are NOT gated.
 */

function makePiOauthCodexRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 3_600_000,
    oauth: {
      accessToken: 'access',
      refreshToken: 'refresh',
      idToken: 'id',
      scope: null,
      tokenType: null,
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
}

function makeLegacyCredentials(): Credentials {
  const credentials: Credentials = {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }
  return credentials;
}

function makePiCodexApi(now: number, credentials: Credentials): ApiClient {
  if (credentials.encryption.type !== 'legacy') {
    throw new Error('test fixture expected legacy encryption');
  }
  const secret = credentials.encryption.secret;
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret },
    payload: makePiOauthCodexRecord(now),
    randomBytes: (length) => randomBytes(length),
  });
  return {
    getConnectedServiceCredentialSealed: async (params: { serviceId: string; profileId: string }) => {
      if (params.serviceId !== 'openai-codex' || params.profileId !== 'work') return null;
      return {
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
      };
    },
  } as unknown as ApiClient;
}

const PI_CONNECTED_BINDINGS = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'connected', profileId: 'work' },
  },
} as const;

function sharedStateAccountSettings() {
  return {
    connectedServicesProviderStateSharingSettingsV1: {
      v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' },
      byAgentId: {
        pi: { stateMode: 'shared' },
      },
    },
  };
}

describe('resolveConnectedServiceAuthForSpawn post-materialization resume reachability gate', () => {
  it('fails closed with the structured continuity reason when the resumed session is unreachable in the materialized target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-miss-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-miss-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      // No native session file anywhere: the import will land nothing, so the materialized target
      // genuinely lacks the resumable session file. The early (source-aware) check would have been
      // satisfied if the file existed; here it does not, so the spawn-time re-verify must fail closed
      // BEFORE returning an env the vendor would crash resuming.
      process.env.HOME = fakeHome;

      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-miss',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-missing',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'pi',
        vendorResumeId: 'pi-session-missing',
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('passes the gate and returns the materialized env when the native session file exists and the import lands', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-hit-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-hit-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // Native PI session file present under the source agent dir for this cwd. The shared-state
      // materializer will import/link it into the materialized target, so the spawn-time re-verify
      // proves reachability and the spawn proceeds.
      const nativeSessionsDir = join(nativeAgentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeSessionsDir, { recursive: true });
      await writeFile(
        join(nativeSessionsDir, '2026-05-27T00-00-00-000Z_pi-session-hit.jsonl'),
        '{"type":"session"}\n',
      );

      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-hit',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-hit',
        resumeReachabilityRequired: true,
      });

      expect(connectedServiceAuth).not.toBeNull();
      expect(connectedServiceAuth!.env.PI_CODING_AGENT_DIR).toMatch(/pi-agent-dir$/);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('degrades a stale absolute persisted piSessionFile to the id+cwd native search instead of hard-failing (D8)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-d8-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-d8-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      const nativeSessionsDir = join(nativeAgentDir, 'sessions', formatPiSessionDirectoryForCwd(cwd));
      await mkdir(nativeSessionsDir, { recursive: true });
      await writeFile(
        join(nativeSessionsDir, '2026-05-27T00-00-00-000Z_pi-session-d8.jsonl'),
        '{"type":"session"}\n',
      );

      // A persisted absolute hint recorded on another machine that no longer exists locally must not
      // hard-fail: it degrades to the id+cwd native search, which resolves the session.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-d8',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-d8',
        resumeReachabilityRequired: true,
        candidatePersistedSessionFile: '/nonexistent/other-machine/path/pi-session-d8.jsonl',
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not gate a fresh (no resume reference) spawn', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-fresh-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-fresh-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // No native session file, but no resume reference either -> not a continuity spawn, must not gate.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-fresh',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: null,
        resumeReachabilityRequired: true,
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('fails closed when reachability is REQUIRED for a resume but cwd is missing (plumbing bug must not silently disable the hard gate)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-nocwd-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // A resume IS requested (vendorResumeId present) and shared-state continuity REQUIRES the
      // reachability gate, but the gate's `cwd` plumbing input is missing. Previously this returned
      // WITHOUT running the gate — silently disabling the hard gate for a continuity resume. It must
      // instead fail closed with the structured continuity reason BEFORE the vendor launches.
      await expect(resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: null,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-nocwd',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: sharedStateAccountSettings(),
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-nocwd',
        resumeReachabilityRequired: true,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceSpawnResumeUnreachableError',
        errorCode: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        agentId: 'pi',
        vendorResumeId: 'pi-session-nocwd',
        reason: 'resume_reachability_inputs_missing',
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not gate when shared-state continuity was not requested', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-native-'));
    const fakeHome = await mkdtemp(join(tmpdir(), 'happier-reverify-isolated-home-'));
    const originalHome = process.env.HOME;
    const now = 1_000_000;
    const cwd = '/tmp/reverify-isolated-project';

    const credentials = makeLegacyCredentials();
    const api = makePiCodexApi(now, credentials);
    try {
      process.env.HOME = fakeHome;
      // Resume requested but continuity (shared state) NOT requested -> isolated spawn must not be gated
      // by the shared-state reachability proof.
      const connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
        agentId: 'pi',
        sessionDirectory: cwd,
        connectedServicesBindingsRaw: PI_CONNECTED_BINDINGS,
        materializationKey: 'session-isolated',
        activeServerDir,
        baseDir,
        credentials,
        api,
        nowMs: () => now,
        accountSettings: null,
        processEnv: { PI_CODING_AGENT_DIR: nativeAgentDir } as NodeJS.ProcessEnv,
        vendorResumeId: 'pi-session-isolated',
        resumeReachabilityRequired: false,
      });

      expect(connectedServiceAuth).not.toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(baseDir, { recursive: true, force: true });
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(nativeAgentDir, { recursive: true, force: true });
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

void ConnectedServiceSpawnResumeUnreachableError;
