import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.ps1 defaults background service installation to opt-in when noninteractive', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');
  const trimmed = raw.replace(/^\uFEFF?/, '').trimStart();

  assert.match(trimmed, /\$env:HAPPIER_WITH_DAEMON/i);
  assert.match(trimmed, /else\s*\{\s*"0"\s*\}/i);
});

test('install.ps1 defaults background-service commands to the managed install dir when HAPPIER_HOME_DIR is unset', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /\$DaemonServiceStateHomeDir\s*=\s*if\s*\(\$env:HAPPIER_HOME_DIR\)\s*\{\s*\$env:HAPPIER_HOME_DIR\s*\}\s*else\s*\{\s*\$InstallDir\s*\}/i);
  assert.doesNotMatch(raw, /Invoke-InstallerCommandWithDaemonServiceContext[^\n]*-HomeDir \$InstallDir/i);
});

test('install.ps1 calls Resolve-WithDaemonPreference with the renamed Entries parameter', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const raw = await readFile(path, 'utf8');

  assert.match(raw, /Resolve-WithDaemonPreference\s+-Entries\s+\$backgroundServiceInventory\.Entries/i);
  assert.doesNotMatch(raw, /Resolve-WithDaemonPreference\s+-ExistingEntries\s+\$backgroundServiceInventory\.Entries/i);
});

test('published preview and dev PowerShell installers keep background-service auto-install opt-in by default', async () => {
  const previewRaw = await readFile(join(repoRoot, 'apps', 'website', 'public', 'install-preview.ps1'), 'utf8');
  const devRaw = await readFile(join(repoRoot, 'apps', 'website', 'public', 'install-dev.ps1'), 'utf8');

  assert.match(previewRaw, /\[string\] \$Channel = \$\(if \(\$env:HAPPIER_CHANNEL\) \{ \$env:HAPPIER_CHANNEL \} else \{ "preview" \}\),/i);
  assert.match(devRaw, /\[string\] \$Channel = \$\(if \(\$env:HAPPIER_CHANNEL\) \{ \$env:HAPPIER_CHANNEL \} else \{ "dev" \}\),/i);
  assert.match(previewRaw, /if \(\$Channel -eq "stable"\) \{\s*return "1"\s*\}/i);
  assert.match(devRaw, /if \(\$Channel -eq "stable"\) \{\s*return "1"\s*\}/i);
  assert.doesNotMatch(previewRaw, /if \(\$Channel -eq "preview"\) \{\s*return "1"\s*\}/i);
  assert.doesNotMatch(devRaw, /if \(\$Channel -eq "dev"\) \{\s*return "1"\s*\}/i);
});
