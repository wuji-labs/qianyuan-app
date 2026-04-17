import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTrailingJsonObjectForTests } from '../pipeline/release-validation/executors/installers-smoke-local-build.mjs';

test('installers-smoke local-build parses the trailing build-cli JSON payload after tool chatter', () => {
  const parsed = parseTrailingJsonObjectForTests(`
yarn run v1.22.22
$ node scripts/pipeline/release/build-cli-binaries.mjs --channel preview --targets darwin-arm64
{
  "product": "happier",
  "channel": "preview",
  "version": "1.2.3-preview.4",
  "outDir": "/tmp/dist/release-assets/cli",
  "artifacts": [
    "happier-v1.2.3-preview.4-darwin-arm64.tar.gz"
  ],
  "checksums": "/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt",
  "signature": "/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt.minisig"
}`);

  assert.deepEqual(parsed, {
    product: 'happier',
    channel: 'preview',
    version: '1.2.3-preview.4',
    outDir: '/tmp/dist/release-assets/cli',
    artifacts: [
      'happier-v1.2.3-preview.4-darwin-arm64.tar.gz',
    ],
    checksums: '/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt',
    signature: '/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt.minisig',
  });
});
