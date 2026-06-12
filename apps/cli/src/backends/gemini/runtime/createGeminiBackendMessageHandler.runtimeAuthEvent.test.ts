import { afterEach, describe, expect, it, vi } from 'vitest';

import { GEMINI_PROVIDER_RUNTIME_ERROR_EVENT } from '../acp/transport';
import { createGeminiBackendMessageHandler } from './createGeminiBackendMessageHandler';

describe('createGeminiBackendMessageHandler (provider runtime error events)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never renders raw provider runtime error payloads to the transcript or terminal', () => {
    // No gemini connected-service selection -> classification is null and nothing is reported;
    // either way the RAW payload must stay suppressed (Gemini CLI retries 429s internally).
    vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', '');

    const session = {
      sessionId: 'session-1',
      sendAgentMessage: vi.fn(),
      sendSessionEvent: vi.fn(),
      updateMetadata: vi.fn(),
      keepAlive: vi.fn(),
    } as any;
    const messageBuffer = { addMessage: vi.fn(), updateLastMessage: vi.fn() } as any;
    const state = {
      thinking: false,
      accumulatedResponse: '',
      isResponseInProgress: false,
      hadToolCallInTurn: false,
      hadThinkingInTurn: false,
      hadPermissionInTurn: false,
      taskStartedSent: false,
      changeTitleCompleted: false,
    } as any;
    const diffProcessor = {
      processToolResult: vi.fn(),
      processFsEdit: vi.fn(),
    } as any;

    const handler = createGeminiBackendMessageHandler({
      session,
      messageBuffer,
      state,
      diffProcessor,
    });

    handler({
      type: 'event',
      name: GEMINI_PROVIDER_RUNTIME_ERROR_EVENT,
      payload: {
        source: 'gemini_stderr',
        status: 429,
        message: 'RAW_PROVIDER_ERROR_RESOURCE_EXHAUSTED',
      },
    } as any);

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(session.sendSessionEvent).not.toHaveBeenCalled();
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(messageBuffer.updateLastMessage).not.toHaveBeenCalled();
  });
});
