import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';

describe('resolveConnectedServiceMaterializedRootDir', () => {
  it('derives the deterministic root from the materialization identity id (the segment the spawn path uses)', () => {
    expect(resolveConnectedServiceMaterializedRootDir({
      baseDir: '/home/user/.happier/daemon/connected-services/materialized',
      agentId: 'pi',
      materializationKey: 'session-123',
      materializationIdentity: { v: 1, id: 'csm_abc' },
    })).toBe(join('/home/user/.happier/daemon/connected-services/materialized', 'csm_abc', 'pi'));
  });

  it('falls back to the normalized materialization key when no identity is present', () => {
    // No identity → segment is the normalized key (same fallback materializeConnectedServicesForSpawn uses).
    const root = resolveConnectedServiceMaterializedRootDir({
      baseDir: '/base',
      agentId: 'codex',
      materializationKey: 'spawn-1700000000000-abcd',
      materializationIdentity: null,
    });
    expect(root.startsWith(join('/base'))).toBe(true);
    expect(root.endsWith(join('codex'))).toBe(true);
    // The identity-less segment is NOT the raw key verbatim if it required normalization; but for a
    // path-safe key it is preserved between baseDir and agentId.
    expect(root).toBe(join('/base', 'spawn-1700000000000-abcd', 'codex'));
  });
});
