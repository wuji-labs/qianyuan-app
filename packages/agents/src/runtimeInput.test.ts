import { describe, expect, it } from 'vitest';

import * as agents from './index.js';
import { AGENTS_CORE } from './manifest.js';

describe('agent runtime input capability', () => {
  it('declares shared in-flight steer support in the manifest for steer-capable providers', () => {
    expect(Reflect.get(AGENTS_CORE.pi, 'runtimeInput')).toEqual({
      inFlightSteerSupported: true,
    });
    expect(Reflect.get(AGENTS_CORE.claude, 'runtimeInput')).toBeUndefined();
  });

  it('re-exports the shared in-flight steer helper from the package root', () => {
    expect(Reflect.get(agents, 'supportsAgentInFlightSteer')).toBeTypeOf('function');
    const supportsAgentInFlightSteer = Reflect.get(agents, 'supportsAgentInFlightSteer') as
      | ((agentId: 'pi' | 'claude') => boolean)
      | undefined;
    expect(supportsAgentInFlightSteer?.('pi')).toBe(true);
    expect(supportsAgentInFlightSteer?.('claude')).toBe(false);
  });
});
