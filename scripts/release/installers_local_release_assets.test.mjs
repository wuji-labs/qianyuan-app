import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh --version can resolve local release assets without fetching GitHub metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-local-assets-version-'));
  const binDir = join(root, 'bin');
  const assetsDir = join(root, 'assets');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const version = '9.9.9-preview.42';
  await writeFile(join(assetsDir, `happier-v${version}-linux-x64.tar.gz`), 'archive', 'utf8');
  await writeFile(join(assetsDir, `checksums-happier-v${version}.txt`), 'checksum', 'utf8');
  await writeFile(join(assetsDir, `checksums-happier-v${version}.txt.minisig`), 'signature', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
  };

  const res = spawnSync('bash', [installerPath, '--version'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 0, `expected local-assets version check to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /channel:\s+preview/i);
  assert.match(stdout, /version:\s+9\.9\.9-preview\.42/i);

  await rm(root, { recursive: true, force: true });
});
