import { describe, expect, it } from 'vitest';

import { mapPiRpcEventToAgentMessages } from './eventMapping';

describe('mapPiRpcEventToAgentMessages', () => {
  it('maps assistant message updates to model-output fullText', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'hello' }]);
  });

  it('preserves leading whitespace in model output text', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' world' },
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'hello world' }]);
  });

  it('maps tool execution lifecycle events', () => {
    const start = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'find',
      args: { pattern: '**/*.ts' },
    });
    const end = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'find',
      result: { files: ['a.ts'] },
      isError: true,
    });

    expect(start).toEqual([{ type: 'tool-call', callId: 'call-1', toolName: 'find', args: { pattern: '**/*.ts' } }]);
    expect(end).toEqual([
      { type: 'tool-result', callId: 'call-1', toolName: 'find', result: { files: ['a.ts'] }, isError: true },
    ]);
  });

  it('maps Pi tool result image content to transient session media', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'draw',
      result: {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      },
    });

    expect(output).toEqual([
      {
        type: 'tool-result',
        callId: 'call-1',
        toolName: 'draw',
        result: {
          content: [
            { type: 'text', text: 'done' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          ],
        },
      },
      {
        type: 'session-media',
        source: 'pi-tool-result',
        media: [
          {
            kind: 'base64',
            data: 'iVBORw0KGgo=',
            mimeType: 'image/png',
            origin: {
              source: 'tool-output',
              toolCallId: 'call-1',
              contentIndex: 1,
            },
            dedupeKey: expect.stringMatching(/^pi:tool-result:call-1:[a-f0-9]{64}$/),
          },
        ],
      },
    ]);
  });

  it('maps tool execution updates to streaming tool-result chunks', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      partialResult: { content: [{ type: 'text', text: 'hi\\n' }], details: {} },
    });

    expect(output).toEqual([
      { type: 'tool-result', callId: 'call-1', toolName: 'bash', result: { _stream: true, stdoutChunk: 'hi\\n' } },
    ]);
  });

  it('emits final assistant fullText on message_end', () => {
    const output = mapPiRpcEventToAgentMessages({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
    });
    expect(output).toEqual([{ type: 'model-output', fullText: 'final' }]);
  });

  it('maps turn lifecycle events to status messages', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_start' })).toEqual([{ type: 'status', status: 'running' }]);
    expect(mapPiRpcEventToAgentMessages({ type: 'turn_end' })).toEqual([{ type: 'status', status: 'idle' }]);
  });

  it('maps compaction lifecycle events to structured provider events', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'compaction_start', reason: 'manual' })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'started',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'manual',
          source: 'provider-event',
        },
      },
    ]);

    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 1234, tokensAfter: 456 },
      aborted: false,
      retryAttempt: 2,
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'completed',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'threshold',
          source: 'provider-event',
          tokenCountBefore: 1234,
          tokenCountAfter: 456,
          retryAttempt: 2,
        },
      },
    ]);

    expect(mapPiRpcEventToAgentMessages({
      type: 'compaction_end',
      reason: 'manual',
      cancelled: true,
    })).toEqual([
      {
        type: 'event',
        name: 'context_compaction',
        payload: {
          type: 'context-compaction',
          phase: 'cancelled',
          provider: 'pi',
          lifecycleId: 'pi:context-compaction',
          trigger: 'manual',
          source: 'provider-event',
        },
      },
    ]);
  });

  it('returns an empty list for unknown events', () => {
    expect(mapPiRpcEventToAgentMessages({ type: 'something_new' })).toEqual([]);
  });
});
