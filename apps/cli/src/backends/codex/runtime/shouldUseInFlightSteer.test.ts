import { describe, expect, it } from 'vitest';

import { shouldUseInFlightSteer } from './shouldUseInFlightSteer';

describe('shouldUseInFlightSteer', () => {
    it('allows steering when the runtime supports it and the active turn is steerable', () => {
        expect(shouldUseInFlightSteer({
            runtime: {
                supportsInFlightSteer: () => true,
                isTurnInFlight: () => true,
                canSteerPrompt: () => true,
            },
            didChangePermissionMode: false,
            isSpecialCommand: false,
        })).toBe(true);
    });

    it('blocks steering when the runtime marks the active turn as non-steerable', () => {
        expect(shouldUseInFlightSteer({
            runtime: {
                supportsInFlightSteer: () => true,
                isTurnInFlight: () => true,
                canSteerPrompt: () => false,
            },
            didChangePermissionMode: false,
            isSpecialCommand: false,
        })).toBe(false);
    });

    it('falls back to in-flight state for runtimes without active-turn steerability', () => {
        expect(shouldUseInFlightSteer({
            runtime: {
                supportsInFlightSteer: () => true,
                isTurnInFlight: () => true,
            },
            didChangePermissionMode: false,
            isSpecialCommand: false,
        })).toBe(true);
    });

    it('blocks steering when the permission mode changed', () => {
        expect(shouldUseInFlightSteer({
            runtime: {
                supportsInFlightSteer: () => true,
                isTurnInFlight: () => true,
                canSteerPrompt: () => true,
            },
            didChangePermissionMode: true,
            isSpecialCommand: false,
        })).toBe(false);
    });
});
