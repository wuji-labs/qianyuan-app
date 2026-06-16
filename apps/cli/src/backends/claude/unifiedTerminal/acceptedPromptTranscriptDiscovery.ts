import type { RawJSONLines } from '../types';

type AcceptedPrompt = Readonly<{
  text: string;
  acceptedAtMs: number;
  expiresAtMs: number;
}>;

export type ClaudeUnifiedAcceptedPromptTranscriptDiscovery = Readonly<{
  recordAcceptedPrompt(input: Readonly<{ message: string; acceptedAtMs?: number | undefined }>): void;
  consumeMatchingTranscript(messages: readonly unknown[]): boolean;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readMessageTimestampMs(message: unknown): number | null {
  const raw = (message as Record<string, unknown>).timestamp;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCommandNamePromptText(content: string): string | null {
  const match = content.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  const commandName = match?.[1]?.trim();
  return commandName && commandName.startsWith('/') ? commandName : null;
}

function readUserPromptTexts(message: RawJSONLines): readonly string[] {
  if (message.type !== 'user') return [];
  if ((message as Record<string, unknown>).isMeta === true) return [];
  const content = message.message?.content;
  if (typeof content !== 'string' || content.length === 0) return [];
  const commandName = readCommandNamePromptText(content);
  return commandName ? [content, commandName] : [content];
}

function readQueuedCommandPromptTexts(value: unknown): readonly string[] {
  const message = readObject(value);
  if (!message) return [];
  if (message.type === 'queue-operation') {
    if (message.operation !== 'enqueue') return [];
    const content = message.content;
    return typeof content === 'string' && content.length > 0 ? [content] : [];
  }
  if (message.type === 'attachment') {
    const attachment = readObject(message.attachment);
    if (!attachment || attachment.type !== 'queued_command') return [];
    const prompt = attachment.prompt;
    return typeof prompt === 'string' && prompt.length > 0 ? [prompt] : [];
  }
  return [];
}

function readPromptTexts(message: unknown): readonly string[] {
  const record = readObject(message);
  if (!record) return [];
  if (record.type === 'user') return readUserPromptTexts(record as RawJSONLines);
  return readQueuedCommandPromptTexts(record);
}

function promptTextsMatch(transcriptText: string, acceptedPromptText: string): boolean {
  if (transcriptText === acceptedPromptText) return true;
  return transcriptText.startsWith('/')
    && acceptedPromptText.startsWith(`${transcriptText} `);
}

function isCommandNameOnlyFallbackMatch(transcriptText: string, acceptedPromptText: string): boolean {
  return transcriptText.startsWith('/')
    && transcriptText !== acceptedPromptText
    && acceptedPromptText.startsWith(`${transcriptText} `);
}

export function createClaudeUnifiedAcceptedPromptTranscriptDiscovery(opts: Readonly<{
  acceptedPromptWindowMs: number;
  nowMs?: (() => number) | undefined;
}>): ClaudeUnifiedAcceptedPromptTranscriptDiscovery {
  const acceptedPrompts: AcceptedPrompt[] = [];
  const nowMs = opts.nowMs ?? Date.now;
  const acceptedPromptWindowMs = Math.max(100, Math.trunc(opts.acceptedPromptWindowMs));

  function pruneExpired(referenceMs: number): void {
    while (acceptedPrompts.length > 0) {
      const next = acceptedPrompts[0];
      if (!next || next.expiresAtMs >= referenceMs) return;
      acceptedPrompts.shift();
    }
  }

  function matchesPromptWindow(message: unknown, acceptedPrompt: AcceptedPrompt): boolean {
    const timestampMs = readMessageTimestampMs(message);
    if (timestampMs === null) {
      return nowMs() <= acceptedPrompt.expiresAtMs;
    }
    return timestampMs >= acceptedPrompt.acceptedAtMs - acceptedPromptWindowMs
      && timestampMs <= acceptedPrompt.expiresAtMs;
  }

  return {
    recordAcceptedPrompt(input) {
      if (input.message.length === 0) return;
      const rawAcceptedAtMs = input.acceptedAtMs;
      const acceptedAtMs =
        typeof rawAcceptedAtMs === 'number' && Number.isFinite(rawAcceptedAtMs)
          ? Math.trunc(rawAcceptedAtMs)
          : nowMs();
      pruneExpired(acceptedAtMs);
      acceptedPrompts.push({
        text: input.message,
        acceptedAtMs,
        expiresAtMs: acceptedAtMs + acceptedPromptWindowMs,
      });
    },

    consumeMatchingTranscript(messages) {
      pruneExpired(nowMs());
      for (const message of messages) {
        const texts = readPromptTexts(message);
        if (texts.length === 0) continue;
        let matchIndex = -1;
        for (const text of texts) {
          const matchingIndices = acceptedPrompts
            .map((acceptedPrompt, index) => ({ acceptedPrompt, index }))
            .filter(({ acceptedPrompt }) => (
              promptTextsMatch(text, acceptedPrompt.text) && matchesPromptWindow(message, acceptedPrompt)
            ));
          if (matchingIndices.length === 0) continue;
          const exactMatch = matchingIndices.find(({ acceptedPrompt }) => acceptedPrompt.text === text);
          if (exactMatch) {
            matchIndex = exactMatch.index;
            break;
          }
          const fallbackMatches = matchingIndices.filter(({ acceptedPrompt }) => (
            isCommandNameOnlyFallbackMatch(text, acceptedPrompt.text)
          ));
          if (fallbackMatches.length > 1 && fallbackMatches.length === matchingIndices.length) {
            continue;
          }
          matchIndex = matchingIndices[0]?.index ?? -1;
          break;
        }
        if (matchIndex < 0) continue;
        acceptedPrompts.splice(matchIndex, 1);
        return true;
      }
      return false;
    },
  };
}
