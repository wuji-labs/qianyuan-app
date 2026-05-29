import type { PermissionIntent } from '../types.js';
import { parsePermissionIntentAlias } from '../permissions/index.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type MetadataStringOverrideStateV1 =
  | { state: 'set'; value: string; updatedAt: number }
  | { state: 'cleared'; updatedAt: number };

/**
 * Resolve the canonical permission intent from a session metadata snapshot.
 *
 * This is shared across UI/CLI so that legacy aliases and persistence rules stay consistent.
 */
export function resolvePermissionIntentFromSessionMetadata(
  metadata: unknown,
): { intent: PermissionIntent; updatedAt: number } | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const rawMode = typeof obj.permissionMode === 'string' ? obj.permissionMode.trim() : '';
  if (!rawMode) return null;

  const intent = parsePermissionIntentAlias(rawMode);
  if (!intent) return null;

  const updatedAt = asFiniteNumber(obj.permissionModeUpdatedAt);
  return { intent, updatedAt };
}

/**
 * Resolve a nested `{ v: 1, updatedAt, <valueKey> }` override from session metadata.
 *
 * This state-aware reader preserves explicit clear tombstones (`null`, empty strings,
 * or whitespace strings) so runtime consumers can clear stale in-memory state. Missing
 * value keys remain malformed/missing data, not clears.
 */
export function resolveMetadataStringOverrideStateV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): MetadataStringOverrideStateV1 | null {
  const obj = asRecord(metadata);
  if (!obj) return null;

  const rawOverride = asRecord(obj[overrideKey]);
  if (!rawOverride) return null;
  if (!Object.prototype.hasOwnProperty.call(rawOverride, valueKey)) return null;

  const updatedAt = asFiniteNumber(rawOverride.updatedAt);
  const rawValue = rawOverride[valueKey];
  if (typeof rawValue === 'string') {
    const value = rawValue.trim();
    return value ? { state: 'set', value, updatedAt } : { state: 'cleared', updatedAt };
  }
  if (rawValue === null) return { state: 'cleared', updatedAt };
  return null;
}

/**
 * Resolve the newest valid state across canonical + legacy override aliases.
 *
 * Pass keys in canonical-preferred order; equal timestamps keep the first valid key.
 */
export function resolveMetadataStringOverrideStateV1FromAliases(
  metadata: unknown,
  overrideKeys: readonly string[],
  valueKey: string,
): MetadataStringOverrideStateV1 | null {
  let best: MetadataStringOverrideStateV1 | null = null;
  for (const overrideKey of overrideKeys) {
    const next = resolveMetadataStringOverrideStateV1(metadata, overrideKey, valueKey);
    if (!next) continue;
    if (!best || next.updatedAt > best.updatedAt) {
      best = next;
    }
  }
  return best;
}

/**
 * Resolve a nested `{ v: 1, updatedAt, <valueKey>: string }` override from session metadata.
 *
 * Used for fields like:
 * - `metadata.modelOverrideV1 = { v: 1, updatedAt, modelId }`
 * - `metadata.acpSessionModeOverrideV1 = { v: 1, updatedAt, modeId }`
 *
 * This compatibility wrapper is intentionally set-only; callers that must observe
 * clears should use `resolveMetadataStringOverrideStateV1`.
 */
export function resolveMetadataStringOverrideV1(
  metadata: unknown,
  overrideKey: string,
  valueKey: string,
): { value: string; updatedAt: number } | null {
  const resolved = resolveMetadataStringOverrideStateV1(metadata, overrideKey, valueKey);
  if (resolved?.state !== 'set') return null;
  return { value: resolved.value, updatedAt: resolved.updatedAt };
}

