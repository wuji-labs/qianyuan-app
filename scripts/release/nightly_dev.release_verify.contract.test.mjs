import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('nightly-dev workflow runs reusable release verification against the dev channel', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[cli, hstack, server_runtime, ui_web, ui_mobile, ui_desktop, docker\][\s\S]*?uses:\s*\.\/\.github\/workflows\/release-verify\.yml/,
    'nightly-dev should invoke the reusable release-verify workflow after publish lanes finish',
  );
  assert.match(
    raw,
    /release_verify:[\s\S]*?channel:\s*dev/,
    'nightly-dev should validate the dev channel through release-verify',
  );
  assert.match(
    raw,
    /permissions:\s*[\s\S]*?actions:\s*read/,
    'nightly-dev should grant actions: read because the reusable release-verify workflow requires it',
  );

  for (const inputName of [
    'run_installers_smoke',
    'run_binary_smoke',
    'run_cli_update_continuity',
    'run_daemon_continuity',
    'run_session_continuity',
  ]) {
    assert.match(
      raw,
      new RegExp(`release_verify:[\\s\\S]*?${inputName}:\\s*true`),
      `nightly-dev should explicitly enable ${inputName} when invoking release-verify`,
    );
  }
});
