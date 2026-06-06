import { describe, expect, it } from 'vitest';
import { compareMachineHomeDirs } from '@happier-dev/protocol';

import { resolveMachineControlLocalityProof } from './machineControlLocality';

describe('machineControlLocality', () => {
  it('returns exact proof when machine ids match without requiring host or home', () => {
    expect(resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-local',
      currentMachineId: 'machine-local',
    })).toBe('exact_machine_id');
  });

  it('returns same-host-home proof for stale ids with normalized host and Windows home paths', () => {
    expect(resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'LEEROY-MBP.local',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: 'C:\\Users\\Leeroy\\',
      currentMachineHomeDir: 'c:/users/leeroy',
    })).toBe('same_host_home');
  });

  it('rejects stale ids when host or home proof is missing or mismatched', () => {
    expect(resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'old-host',
      currentMachineHost: 'new-host',
      sessionHomeDir: '/Users/leeroy',
      currentMachineHomeDir: '/Users/leeroy',
    })).toBeNull();
    expect(resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'leeroy-mbp',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: '/Users/leeroy',
      currentMachineHomeDir: '/Users/other',
    })).toBeNull();
    expect(resolveMachineControlLocalityProof({
      sessionMachineId: 'machine-before-restart',
      currentMachineId: 'machine-after-restart',
      sessionHost: 'leeroy-mbp',
      currentMachineHost: 'leeroy-mbp',
      sessionHomeDir: null,
      currentMachineHomeDir: '/Users/leeroy',
    })).toBeNull();
  });

  it('normalizes tilde home forms when the opposite side supplies the home base', () => {
    expect(compareMachineHomeDirs('~\\', 'C:\\Users\\Leeroy', { homeDir: 'C:\\Users\\Leeroy' })).toBe(true);
    expect(compareMachineHomeDirs('~\\', '/Users/leeroy', { homeDir: '/Users/leeroy' })).toBe(true);
    expect(compareMachineHomeDirs('~/', '/Users/leeroy', { homeDir: '/Users/leeroy' })).toBe(true);
  });

  it('does not collapse sibling home directories', () => {
    expect(compareMachineHomeDirs('C:\\Users\\Leeroy', 'C:\\Users\\Leeroy2')).toBe(false);
    expect(compareMachineHomeDirs('/Users/leeroy', '/Users/leeroy2')).toBe(false);
  });
});
