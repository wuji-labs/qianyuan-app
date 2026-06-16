import { describe, expect, it } from 'vitest';

import { STANDARD_CONTINUATION_RESUME_PROMPT } from '@/daemon/connectedServices/continuation/continuationResumePrompt';
import type { RawJSONLines } from '../types';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';

describe('createClaudeUnifiedAcceptedPromptTranscriptDiscovery', () => {
  it('consumes Claude queued-command enqueue rows as provider-accepted input', () => {
    const prompt = 'Please continue the QA from the current checkpoint.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: new Date(10_250).toISOString(),
      content: prompt,
    } as unknown as RawJSONLines])).toBe(true);
  });

  it('consumes Claude queued-command attachment rows as provider-accepted input', () => {
    const prompt = 'Please continue fully and completely.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'attachment',
      timestamp: new Date(10_250).toISOString(),
      attachment: {
        type: 'queued_command',
        prompt,
      },
    } as unknown as RawJSONLines])).toBe(true);
  });

  it('does not consume Claude queued-command removal rows as provider-accepted input', () => {
    const prompt = 'Please continue fully and completely.';
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'remove',
      timestamp: new Date(10_250).toISOString(),
      content: prompt,
    } as unknown as RawJSONLines])).toBe(false);
  });

  it('does not consume meta continuation transcript rows as provider-accepted input', () => {
    const prompt = STANDARD_CONTINUATION_RESUME_PROMPT;
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: prompt, acceptedAtMs: 10_000 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'meta-continuation-prompt',
      isMeta: true,
      timestamp: new Date(10_100).toISOString(),
      message: {
        role: 'user',
        content: prompt,
      },
    } satisfies RawJSONLines])).toBe(false);

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'provider-visible-prompt',
      timestamp: new Date(10_200).toISOString(),
      message: {
        role: 'user',
        content: prompt,
      },
    } satisfies RawJSONLines])).toBe(true);
  });

  it('does not consume command-name-only slash evidence when multiple accepted prompts share the command', () => {
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    discovery.recordAcceptedPrompt({ message: '/model opus', acceptedAtMs: 10_000 });
    discovery.recordAcceptedPrompt({ message: '/model sonnet', acceptedAtMs: 10_010 });

    expect(discovery.consumeMatchingTranscript([{
      type: 'user',
      uuid: 'command-name-only',
      timestamp: new Date(10_250).toISOString(),
      message: {
        role: 'user',
        content: '<command-name>/model</command-name>\n<command-message>model</command-message>',
      },
    } satisfies RawJSONLines])).toBe(false);

    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: new Date(10_300).toISOString(),
      content: '/model opus',
    } as unknown as RawJSONLines])).toBe(true);
    expect(discovery.consumeMatchingTranscript([{
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: new Date(10_320).toISOString(),
      content: '/model sonnet',
    } as unknown as RawJSONLines])).toBe(true);
  });
});
