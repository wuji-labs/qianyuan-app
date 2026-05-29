import { describe, expect, it } from 'vitest';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import type { AgentMessage } from '../../core';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeFakeAcpAgentScript(params: {
  dir: string;
  recordedParamsPath?: string;
  modelSetResponse?: 'empty' | 'staleEcho';
}): string {
  const src = `
    import { writeFileSync } from 'node:fs';

    const decoder = new TextDecoder();
    let buf = '';
    const recordedParamsPath = ${JSON.stringify(params.recordedParamsPath ?? '')};
    const modelSetResponse = ${JSON.stringify(params.modelSetResponse ?? 'empty')};

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;
        const id = req.id;
        const method = req.method;
        const params = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'default[]',
                options: [
                  {
                    group: 'cursor',
                    name: 'Cursor',
                    options: [
                      { value: 'default[]', name: 'Default' },
                      { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                    ],
                  },
                ],
              },
              {
                id: 'mode',
                name: 'Session Mode',
                description: 'Controls how the agent behaves.',
                type: 'select',
                currentValue: 'ask',
                options: [
                  { value: 'ask', name: 'Ask', description: 'Ask before changes' },
                  { value: 'code', name: 'Code', description: 'Write code' },
                ],
              },
              {
                id: 'telemetry',
                name: 'Telemetry',
                type: 'boolean',
                currentValue: 'false',
              },
            ],
          });
          continue;
        }

        if (method === 'session/set_config_option') {
          const configId = params && params.configId;
          const value = params && params.value;
          if (recordedParamsPath) {
            writeFileSync(recordedParamsPath, JSON.stringify(params), 'utf8');
          }
          if (configId === 'clear') {
            ok(id, { configOptions: [] });
            continue;
          }
          if (configId === 'model') {
            if (modelSetResponse === 'staleEcho') {
              ok(id, {
                configOptions: [
                  {
                    id: 'model',
                    name: 'Model',
                    category: 'model',
                    type: 'select',
                    currentValue: 'default[]',
                    options: [
                      { value: 'default[]', name: 'Default' },
                      { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
                    ],
                  },
                  {
                    id: 'mode',
                    name: 'Session Mode',
                    type: 'select',
                    currentValue: 'ask',
                    options: [
                      { value: 'ask', name: 'Ask' },
                      { value: 'code', name: 'Code' },
                    ],
                  },
                ],
              });
              continue;
            }
            ok(id, {});
            continue;
          }
          const nextTelemetry = configId === 'telemetry' ? value : 'false';
          ok(id, {
            configOptions: [
              {
                id: 'telemetry',
                name: 'Telemetry',
                type: 'boolean',
                currentValue: nextTelemetry,
              },
            ],
          });
          continue;
        }

        ok(id, {});
      }
    });
  `;

  return writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-agent.mjs',
    source: src,
  });
}

async function readRecordedParams(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid recorded ACP params at ${path}`);
  }
  return parsed as Record<string, unknown>;
}

describe('AcpBackend session configOptions', () => {
  it('captures configOptions from newSession and can set a config option', async () => {
    await withTempDir('happier-acp-config-options-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const events: AgentMessage[] = [];
        backend.onMessage((msg) => {
          if (msg.type === 'event') events.push(msg);
        });

        const started = await backend.startSession();
        expect(started.sessionId).toBe('test-session');

        expect(backend.getSessionConfigOptionsState()).toEqual([
          expect.objectContaining({
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'default[]',
            options: [
              { value: 'default[]', name: 'Default' },
              { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
            ],
          }),
          expect.objectContaining({ id: 'mode', type: 'select', currentValue: 'ask' }),
          expect.objectContaining({ id: 'telemetry', type: 'boolean', currentValue: 'false' }),
        ]);

        expect(events.some((e) => e.type === 'event' && e.name === 'config_options_state')).toBe(true);

        await backend.setSessionConfigOption(started.sessionId, 'telemetry', 'true');
        expect(backend.getSessionConfigOptionsState()).toEqual([
          expect.objectContaining({ id: 'telemetry', currentValue: 'true' }),
        ]);

        expect(events.some((e) => e.type === 'event' && e.name === 'config_options_update')).toBe(true);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('clears configOptions state when setSessionConfigOption returns an empty list', async () => {
    await withTempDir('happier-acp-config-options-clear-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        expect(backend.getSessionConfigOptionsState()).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: 'telemetry' })]),
        );

        await backend.setSessionConfigOption(started.sessionId, 'clear', '1');
        expect(backend.getSessionConfigOptionsState()).toEqual([]);
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('optimistically updates configOptions state when setSessionConfigOption succeeds without echoing options', async () => {
    await withTempDir('happier-acp-config-options-optimistic-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        await backend.setSessionConfigOption(started.sessionId, 'model', 'composer-2.5[fast=true]');

        expect(backend.getSessionConfigOptionsState()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            currentValue: 'composer-2.5[fast=true]',
          }),
        ]));
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('repairs stale echoed configOptions for the config option that was accepted by the ACP agent', async () => {
    await withTempDir('happier-acp-config-options-stale-echo-', async (dir) => {
      const scriptPath = writeFakeAcpAgentScript({ dir, modelSetResponse: 'staleEcho' });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        await backend.setSessionConfigOption(started.sessionId, 'model', 'composer-2.5[fast=true]');

        expect(backend.getSessionConfigOptionsState()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'model',
            currentValue: 'composer-2.5[fast=true]',
          }),
          expect.objectContaining({
            id: 'mode',
            currentValue: 'ask',
          }),
        ]));
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });

  it('marks boolean set_config_option payloads with their value type for Cursor-compatible ACP agents', async () => {
    await withTempDir('happier-acp-config-options-typed-', async (dir) => {
      const recordedParamsPath = join(dir, 'set-config-option-params.json');
      const scriptPath = writeFakeAcpAgentScript({ dir, recordedParamsPath });
      let backend: AcpBackend | null = null;

      try {
        backend = new AcpBackend({
          agentName: 'test',
          cwd: dir,
          command: process.execPath,
          args: [scriptPath],
        });

        const started = await backend.startSession();
        await backend.setSessionConfigOption(started.sessionId, 'telemetry', true);

        expect(await readRecordedParams(recordedParamsPath)).toMatchObject({
          sessionId: 'test-session',
          configId: 'telemetry',
          value: true,
          type: 'boolean',
        });
      } finally {
        try {
          await backend?.dispose();
        } catch {}
      }
    });
  });
});
