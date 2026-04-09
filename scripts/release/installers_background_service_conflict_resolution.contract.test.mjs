import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('installers perform installed-service preflight before interactive background-service replacement choices', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('service list --json'), 'expected bash installer to preflight installed background services');
  assert.ok(bashSource.includes('service install --yes --replace-existing=all'), 'expected bash installer replace-existing install command');
  assert.ok(bashSource.includes('service install --yes'), 'expected bash installer add-another install command');

  assert.ok(powershellSource.includes('service", "list", "--json"'), 'expected PowerShell installer to preflight installed background services');
  assert.ok(powershellSource.includes('service", "install", "--yes", "--replace-existing=all"'), 'expected PowerShell installer replace-existing install command');
  assert.ok(powershellSource.includes('service", "install", "--yes"'), 'expected PowerShell installer add-another install command');
});

test('installers accept both service-list JSON shapes used by dev and remote-dev', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('"entries":[]'), 'expected bash installer to recognize empty entries inventories');
  assert.ok(bashSource.includes('"services":[]'), 'expected bash installer to recognize empty services inventories');

  assert.ok(powershellSource.includes("PSObject.Properties['entries']"), 'expected PowerShell installer to detect entries inventories by property presence');
  assert.ok(powershellSource.includes("PSObject.Properties['services']"), 'expected PowerShell installer to detect services inventories by property presence');
});

test('installers silently skip automatic background-service setup when the installed CLI lacks service-list support', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(
    bashSource.includes('background_service_inventory_is_supported'),
    'expected bash installer to detect unsupported background-service management surfaces',
  );
  assert.ok(
    powershellSource.includes('Supported = $false'),
    'expected PowerShell installer to detect unsupported background-service management surfaces',
  );
});
