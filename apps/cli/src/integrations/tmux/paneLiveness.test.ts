import { describe, expect, it } from 'vitest';

import { evaluateTmuxPaneLiveness, type TmuxPaneLivenessExecutor } from './paneLiveness';

describe('evaluateTmuxPaneLiveness', () => {
  it('returns live pane metadata from tmux display-message output', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => {
      expect(args).toEqual([
        'display-message',
        '-p',
        '-t',
        'happy:claude.1',
        '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}',
      ]);
      return { returncode: 0, stdout: '0\t12345\tclaude\n', stderr: '', command: [...args] };
    };

    await expect(evaluateTmuxPaneLiveness({ executor, target: 'happy:claude.1', observedAt: 42 })).resolves.toEqual({
      paneAlive: true,
      paneDead: false,
      panePid: 12345,
      paneCurrentCommand: 'claude',
      observedAt: 42,
    });
  });

  it('redacts sensitive pane command diagnostics', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 0,
      stdout: '0\t12345\tclaude ANTHROPIC_API_KEY=sk-ant-secret-value\n',
      stderr: '',
      command: [...args],
    });

    const liveness = await evaluateTmuxPaneLiveness({ executor, target: 'happy:claude.1', observedAt: 43 });

    expect(liveness.paneCurrentCommand).toContain('ANTHROPIC_API_KEY=[redacted-token]');
    expect(liveness.paneCurrentCommand).not.toContain('sk-ant-secret-value');
  });

  it('returns not alive for dead or missing panes', async () => {
    const deadExecutor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 0,
      stdout: '1\t12345\tzsh\n',
      stderr: '',
      command: [...args],
    });
    const missingExecutor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 1,
      stdout: '',
      stderr: 'can not find pane',
      command: [...args],
    });

    await expect(evaluateTmuxPaneLiveness({ executor: deadExecutor, target: 'dead', observedAt: 100 })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      panePid: 12345,
    });
    await expect(evaluateTmuxPaneLiveness({ executor: missingExecutor, target: 'missing', observedAt: 101 })).resolves.toEqual({
      paneAlive: false,
      paneDead: true,
      observedAt: 101,
    });
  });
});
