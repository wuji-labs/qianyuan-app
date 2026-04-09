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

test('published preview and dev PowerShell installers keep background-service auto-install opt-in by default', async () => {
  const previewRaw = await readFile(join(repoRoot, 'apps', 'website', 'public', 'install-preview.ps1'), 'utf8');
  const devRaw = await readFile(join(repoRoot, 'apps', 'website', 'public', 'install-dev.ps1'), 'utf8');

  assert.match(previewRaw, /if \(\$Channel -eq "stable"\) \{\s*return "1"\s*\}/i);
  assert.match(devRaw, /if \(\$Channel -eq "stable"\) \{\s*return "1"\s*\}/i);
  assert.doesNotMatch(previewRaw, /if \(\$Channel -eq "preview"\) \{\s*return "1"\s*\}/i);
  assert.doesNotMatch(devRaw, /if \(\$Channel -eq "dev"\) \{\s*return "1"\s*\}/i);
});
