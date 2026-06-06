type PowerShellInvocation = {
  command: string;
  args: string[];
};

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function toPowerShellStringLiteral(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

function quoteWindowsProcessArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;

  let quoted = '"';
  let backslashCount = 0;

  for (const char of value) {
    if (char === '\\') {
      backslashCount += 1;
      continue;
    }

    if (char === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1);
      quoted += '"';
      backslashCount = 0;
      continue;
    }

    if (backslashCount > 0) {
      quoted += '\\'.repeat(backslashCount);
      backslashCount = 0;
    }
    quoted += char;
  }

  if (backslashCount > 0) {
    quoted += '\\'.repeat(backslashCount * 2);
  }

  return `${quoted}"`;
}

export function buildPowerShellStartWindowsTerminalInvocation(params: {
  filePath: string;
  args: string[];
  workingDirectory: string;
  windowId: string;
  title: string;
}): PowerShellInvocation {
  const argsArray = [
    '-w',
    params.windowId,
    'new-tab',
    '--title',
    params.title,
    '--startingDirectory',
    params.workingDirectory,
    params.filePath,
    ...params.args,
  ];
  const argsCommandLine = argsArray.map((arg) => quoteWindowsProcessArgument(arg)).join(' ');
  const script = [
    '$ErrorActionPreference = "Stop";',
    `$p = Start-Process -FilePath 'wt.exe' -ArgumentList ${toPowerShellStringLiteral(argsCommandLine)} -WorkingDirectory ${toPowerShellStringLiteral(params.workingDirectory)} -PassThru;`,
    'Write-Output $p.Id;',
  ].join(' ');

  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}
