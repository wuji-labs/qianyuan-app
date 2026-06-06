import { describe, expect, it } from 'vitest';

import { buildPowerShellStartWindowsTerminalInvocation } from './windowsTerminalSpawn';

describe('buildPowerShellStartWindowsTerminalInvocation', () => {
  it('quotes the Windows Terminal command line so paths and arguments with spaces stay intact', () => {
    const invocation = buildPowerShellStartWindowsTerminalInvocation({
      filePath: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'apps\\cli\\package-dist\\index.mjs',
        'claude',
        '--prompt',
        'prompt with spaces',
        'quote"inside',
      ],
      workingDirectory: 'C:\\Users\\test qa\\repo',
      windowId: 'happier qa',
      title: 'Happier Claude Session',
    });

    const script = invocation.args.at(-1) ?? '';

    expect(script).toContain(
      "-ArgumentList '-w \"happier qa\" new-tab --title \"Happier Claude Session\" --startingDirectory \"C:\\Users\\test qa\\repo\" \"C:\\Program Files\\nodejs\\node.exe\" apps\\cli\\package-dist\\index.mjs claude --prompt \"prompt with spaces\" \"quote\\\"inside\"'",
    );
  });
});
