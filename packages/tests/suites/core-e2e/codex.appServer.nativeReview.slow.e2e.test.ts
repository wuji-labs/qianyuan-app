import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  ExecutionRunActionResponseSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunStartResponseSchema,
  type ExecutionRunGetResponse,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { callLegacyEncryptedSessionRpc as callSessionRpc } from '../../src/testkit/sessionRpc';
import { waitFor } from '../../src/testkit/timing';
import {
  readFakeCodexAppServerRequestLog,
  startCodexAppServerRemoteHarness,
  type StartedCodexAppServerRemoteHarness,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { fetchAllSidechainMessages } from '../../src/testkit/sessions';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';

const run = createRunDirs({ runLabel: 'core' });
const nativeReviewTextMarker = 'Native Codex review completed.';

function readCodexMessageText(record: unknown): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const content = (record as { content?: unknown }).content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const data = (content as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

describe('core e2e: Codex app-server native review', () => {
  let harness: StartedCodexAppServerRemoteHarness | null = null;

  afterEach(async () => {
    await harness?.stop().catch(() => {});
    harness = null;
  });

  it('routes Codex review runs through native review/start', async () => {
    const testDir = run.testDir(`codex-app-server-native-review-${randomUUID()}`);
    harness = await startCodexAppServerRemoteHarness({
      testDir,
      runId: run.runId,
      testName: 'codex-app-server-native-review',
      cliEnvOverrides: {
        HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '0',
      },
    });

    const { auth, requestLogPath, secret, serverBaseUrl, sessionId } = harness;
    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();

    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'Codex native review e2e UI socket connects',
      });

      const instructions = [
        'Review the app-server native review integration.',
        'Focus on avoiding duplicated final assistant text.',
      ].join('\n');

      const started = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
        req: {
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions,
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
          intentInput: {
            engineId: 'codex',
            engineIds: ['codex'],
            instructions,
            changeType: 'committed',
            base: { kind: 'none' },
          },
        },
        secret,
        schema: ExecutionRunStartResponseSchema,
        timeoutMs: 40_000,
      });

      let requests = await readFakeCodexAppServerRequestLog(requestLogPath);
      await waitFor(async () => {
        requests = await readFakeCodexAppServerRequestLog(requestLogPath);
        return requests.some((entry) => entry.method === 'review/start' || entry.method === 'turn/start');
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Codex app-server receives first review turn request',
      });
      const reviewStarts = requests.filter((entry) => entry.method === 'review/start');
      expect(reviewStarts).toHaveLength(1);
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(0);
      expect(reviewStarts[0]?.params).toEqual(expect.objectContaining({
        threadId: expect.any(String),
        delivery: 'inline',
        target: expect.objectContaining({
          custom: expect.objectContaining({
            instructions: expect.stringContaining('Review the app-server native review integration.'),
          }),
        }),
      }));

      let finished: ExecutionRunGetResponse | null = null;
      await waitFor(async () => {
        const res = await callSessionRpc({
          ui,
          sessionId,
          method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          req: { runId: started.runId, includeStructured: true },
          secret,
          schema: ExecutionRunGetResponseSchema,
          timeoutMs: 40_000,
        });
        if (res.run.status === 'running') return false;
        finished = res;
        return true;
      }, {
        timeoutMs: 90_000,
        intervalMs: 250,
        context: 'Codex native review execution run finishes',
      });

      expect(finished?.run.status).toBe('succeeded');
      expect(finished?.run.intent).toBe('review');
      expect(finished?.structuredMeta?.kind).toBe('review_findings.v2');
      expect(finished?.run.availableActionIds).toContain('review.triage');

      const payload = finished?.structuredMeta?.payload as { findings?: unknown[]; overviewMarkdown?: unknown } | undefined;
      expect(payload?.findings?.length ?? 0).toBe(1);
      expect(String(payload?.overviewMarkdown ?? '')).toContain(nativeReviewTextMarker);

      const sidechainRows = await fetchAllSidechainMessages({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        sidechainId: started.sidechainId,
      });
      const reviewMessages = sidechainRows
        .map((row) => decryptLegacyBase64Normalized(row.content.c, secret))
        .map(readCodexMessageText)
        .filter((message): message is string => typeof message === 'string' && message.includes(nativeReviewTextMarker));
      expect(reviewMessages).toHaveLength(1);

      const findingId = String((payload?.findings?.[0] as { id?: unknown } | undefined)?.id ?? '');
      expect(findingId).not.toBe('');

      const acted = await callSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
        req: {
          runId: started.runId,
          actionId: 'review.triage',
          input: {
            findings: [{ id: findingId, status: 'accept', comment: 'Confirmed in native Codex review e2e' }],
          },
        },
        secret,
        schema: ExecutionRunActionResponseSchema,
        timeoutMs: 40_000,
      });
      expect(acted.ok).toBe(true);
    } finally {
      ui.close();
    }
  }, 240_000);
});
