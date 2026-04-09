import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo-testflight-distribute dry-run accepts an EAS build json artifact for later metadata resolution', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-build-json-'));
  const buildJsonPath = path.join(tmpDir, 'eas_build.ios.json');
  fs.writeFileSync(
    buildJsonPath,
    `${JSON.stringify([{ id: 'eas-build-123', platform: 'IOS' }], null, 2)}\n`,
    'utf8',
  );

  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-testflight-distribute',
      '--environment',
      'dev',
      '--build-json',
      buildJsonPath,
      '--external-groups',
      'Public Beta',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] testflight distribute: environment=dev/);
  assert.match(out, /eas_build_id=eas-build-123/);
  assert.doesNotMatch(out, /build_number=/);
});
