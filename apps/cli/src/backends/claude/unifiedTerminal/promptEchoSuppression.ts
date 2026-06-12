import type { RawJSONLines } from '../types';

export type ClaudeUnifiedAcceptedPrompt = Readonly<{
  message: string;
  acceptedAtMs?: number | undefined;
}>;

export type ClaudeUnifiedPersistedUserPromptText = Readonly<{
  text: string;
  suppressBeforeMs: number;
}>;

export type ClaudeUnifiedPromptEchoSuppressor = Readonly<{
  recordAcceptedPrompt(input: ClaudeUnifiedAcceptedPrompt): void;
  recordPersistedUserPromptTexts(inputs: Iterable<ClaudeUnifiedPersistedUserPromptText>): void;
  shouldSuppressTranscriptMessage(message: RawJSONLines): boolean;
}>;

export type ClaudeUnifiedPromptEchoSuppressorOptions = Readonly<{
  nowMs?: (() => number) | undefined;
  acceptedPromptEchoWindowMs?: number | undefined;
}>;

type AcceptedPromptEcho = Readonly<{
  text: string;
  expiresAtMs: number;
}>;

/**
 * Upper bound on distinct persisted prompt texts retained for echo suppression. Entries are only
 * deleted on a successful suppression match, so without a bound the registry grows for the whole
 * session lifetime (each resume/rescan seeding can add up to 500 rows). 2048 comfortably covers
 * several reseeds while keeping memory flat; eviction is oldest-first (Map insertion order).
 */
const MAX_PERSISTED_PROMPT_TEXTS = 2_048;

function readMessageTimestampMs(message: RawJSONLines): number | null {
  const raw = (message as Record<string, unknown>).timestamp;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAcceptedPromptEchoWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30_000;
  return Math.max(100, Math.trunc(value));
}

export function createClaudeUnifiedPromptEchoSuppressor(
  opts: ClaudeUnifiedPromptEchoSuppressorOptions = {},
): ClaudeUnifiedPromptEchoSuppressor {
  const acceptedPromptEchoes: AcceptedPromptEcho[] = [];
  const persistedPromptTexts = new Map<string, number[]>();
  const nowMs = opts.nowMs ?? Date.now;
  const acceptedPromptEchoWindowMs = normalizeAcceptedPromptEchoWindowMs(opts.acceptedPromptEchoWindowMs);

  function pruneExpiredAcceptedPromptEchoes(observedAtMs: number): void {
    while (acceptedPromptEchoes.length > 0) {
      const next = acceptedPromptEchoes[0];
      if (!next || next.expiresAtMs >= observedAtMs) return;
      acceptedPromptEchoes.shift();
    }
  }

  return {
    recordAcceptedPrompt(input) {
      if (input.message.length === 0) return;
      const rawAcceptedAtMs = input.acceptedAtMs;
      const acceptedAtMs =
        typeof rawAcceptedAtMs === 'number' && Number.isFinite(rawAcceptedAtMs)
          ? Math.trunc(rawAcceptedAtMs)
          : nowMs();
      acceptedPromptEchoes.push({
        text: input.message,
        expiresAtMs: acceptedAtMs + acceptedPromptEchoWindowMs,
      });
    },

    recordPersistedUserPromptTexts(inputs) {
      for (const input of inputs) {
        if (input.text.length === 0 || !Number.isFinite(input.suppressBeforeMs)) continue;
        const existing = persistedPromptTexts.get(input.text) ?? [];
        existing.push(input.suppressBeforeMs);
        // Re-set to refresh insertion order so eviction drops the least-recently-recorded text.
        persistedPromptTexts.delete(input.text);
        persistedPromptTexts.set(input.text, existing);
        while (persistedPromptTexts.size > MAX_PERSISTED_PROMPT_TEXTS) {
          const oldestKey = persistedPromptTexts.keys().next().value;
          if (oldestKey === undefined) break;
          persistedPromptTexts.delete(oldestKey);
        }
      }
    },

    shouldSuppressTranscriptMessage(message) {
      if (message.type !== 'user') return false;
      const content = message.message?.content;
      if (typeof content !== 'string') return false;
      const observedAtMs = readMessageTimestampMs(message) ?? nowMs();
      pruneExpiredAcceptedPromptEchoes(observedAtMs);
      const nextAcceptedEcho = acceptedPromptEchoes[0];
      if (nextAcceptedEcho?.text === content) {
        acceptedPromptEchoes.shift();
        return true;
      }

      const persistedCutoffs = persistedPromptTexts.get(content);
      if (!persistedCutoffs || persistedCutoffs.length === 0) return false;
      const timestampMs = readMessageTimestampMs(message);
      if (timestampMs === null) return false;
      const matchIndex = persistedCutoffs.findIndex((cutoffMs) => timestampMs < cutoffMs);
      if (matchIndex < 0) return false;
      persistedCutoffs.splice(matchIndex, 1);
      if (persistedCutoffs.length === 0) {
        persistedPromptTexts.delete(content);
      }
      return true;
    },
  };
}
