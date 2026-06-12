import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../types';
import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression';

function userMessage(text: string, timestampMs: number): RawJSONLines {
  return {
    type: 'user',
    uuid: `user-${timestampMs}`,
    timestamp: new Date(timestampMs).toISOString(),
    message: { role: 'user', content: text },
  } as RawJSONLines;
}

describe('createClaudeUnifiedPromptEchoSuppressor', () => {
  it('suppresses a fresh accepted UI prompt echo once', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 1_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: 'hello from ui' });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('hello from ui', 1_100))).toBe(true);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('hello from ui', 1_200))).toBe(false);
  });

  it('does not suppress matching terminal-origin prompts after an accepted UI prompt echo expires', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 10_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: 'same text' });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('same text', 16_001))).toBe(false);
  });

  it('bounds the persisted prompt-text registry by evicting the oldest entries', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 1_000 });

    // Seed far past the bound; only the newest entries may survive.
    const total = 2_500;
    for (let i = 0; i < total; i += 1) {
      suppressor.recordPersistedUserPromptTexts([{ text: `persisted prompt ${i}`, suppressBeforeMs: 1_000_000 }]);
    }

    // The oldest entry was evicted: it no longer suppresses a matching transcript row.
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('persisted prompt 0', 2_000))).toBe(false);
    // The newest entry still suppresses.
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(`persisted prompt ${total - 1}`, 2_000))).toBe(true);
  });
});
