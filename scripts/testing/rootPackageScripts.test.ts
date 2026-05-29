import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

test('root typecheck aggregator includes cli-common', () => {
  const typecheckInner = rootPackage.scripts?.['typecheck:inner'] ?? '';

  assert.match(
    typecheckInner,
    /yarn workspace @happier-dev\/cli-common typecheck/,
    'root yarn typecheck should run the cli-common typecheck lane',
  );
});

test('root provider aliases expose Cursor smoke and extended presets', () => {
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:smoke'],
    'yarn workspace @happier-dev/tests providers:cursor:smoke',
  );
  assert.equal(
    rootPackage.scripts?.['test:providers:cursor:extended'],
    'yarn workspace @happier-dev/tests providers:cursor:extended',
  );
});
