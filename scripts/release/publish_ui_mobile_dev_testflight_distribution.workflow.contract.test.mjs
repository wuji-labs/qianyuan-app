import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('publish-ui-mobile-dev distributes submitted iOS dev builds to configured external TestFlight groups', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8');

  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS\s*\}\}/);
  assert.match(src, /node scripts\/pipeline\/run\.mjs expo-testflight-distribute/);
  assert.match(src, /--external-groups "\$\{APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS\}"/);
  assert.match(src, /--build-json "\/tmp\/eas_build\.ios\.json"/);
});
