import fs from 'node:fs';

export function doesInstalledDaemonServiceDefinitionMatchExpected(params: Readonly<{
  installedPath: string;
  expectedContents: string;
}>): boolean {
  try {
    return fs.readFileSync(params.installedPath, 'utf-8').trim() === params.expectedContents.trim();
  } catch {
    return false;
  }
}
