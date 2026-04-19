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
  assert.ok(bashSource.includes('doctor repair --json'), 'expected bash installer to prefer aggregated doctor repair preflight when available');
  assert.ok(bashSource.includes('daemonRunning'), 'expected bash installer to consume aggregated daemon status from doctor repair preflight');
  assert.ok(bashSource.includes('service list 2>/dev/null'), 'expected bash installer to print installed background-service summaries');
  assert.ok(bashSource.includes('service status --json 2>/dev/null'), 'expected bash installer to summarize current background-service owner status from JSON');
  assert.ok(bashSource.includes('run_background_service_repair_if_supported'), 'expected bash installer replace-existing path to route through the repair compatibility helper');
  assert.ok(bashSource.includes('background_service_inventory_has_default_following'), 'expected bash installer to distinguish singleton default services from add-another flows');

  assert.ok(powershellSource.includes('service", "list", "--json"'), 'expected PowerShell installer to preflight installed background services');
  assert.ok(powershellSource.includes('daemonRunning'), 'expected PowerShell installer to consume aggregated daemon status from doctor repair preflight');
  assert.ok(powershellSource.includes('Installed background services:'), 'expected PowerShell installer to print structured installed background-service summaries');
  assert.ok(powershellSource.includes('@("service", "status", "--json")'), 'expected PowerShell installer to summarize current background-service owner status from JSON');
  assert.ok(powershellSource.includes('Invoke-DoctorRepairIfSupported'), 'expected PowerShell installer replace-existing path to route through the repair compatibility helper');
  assert.ok(powershellSource.includes(".targetMode -eq 'default-following'"), 'expected PowerShell installer to distinguish singleton default services from add-another flows');
});

test('installers accept both service-list JSON shapes used by dev and remote-dev', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /"\(entries\|services\|existingServices\)"/,
    'expected bash installer to recognize entries/services/existingServices inventory shapes',
  );
  assert.match(
    bashSource,
    /"\(entries\|services\|existingServices\)".*\\\[/,
    'expected bash installer to recognize empty inventories even when JSON is pretty-printed',
  );

  assert.ok(powershellSource.includes('$payload.entries'), 'expected PowerShell installer to read entries inventories');
  assert.ok(powershellSource.includes('$payload.services'), 'expected PowerShell installer to read services inventories');
  assert.match(
    powershellSource,
    /if \(\$entries\.Count -gt 0 -or \$services\.Count -gt 0 -or \$propertyNames -contains 'entries' -or \$propertyNames -contains 'services'\)/,
    'expected PowerShell installer to treat empty legacy inventories as supported rather than unsupported',
  );
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

test('installers preserve existing background services during noninteractive preview/dev updates', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /if background_service_inventory_is_supported "\$\{services_json\}" && ! background_service_inventory_is_empty "\$\{services_json\}"; then[\s\S]*if \[\[ "\$\{NONINTERACTIVE\}" == "1" \]\]; then[\s\S]*echo "1"/,
    'expected bash installer to preserve existing managed services during noninteractive updates',
  );
  assert.match(
    powershellSource,
    /\$hasExistingServices = \$Entries\.Count -gt 0[\s\S]*if \(\$Noninteractive -eq "1"\) \{[\s\S]*if \(\$hasExistingServices\) \{[\s\S]*return "1"/,
    'expected PowerShell installer to preserve existing managed services during noninteractive updates',
  );
});

test('installers use structured background-service copy before asking whether to update startup behavior', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('Automatic Startup'), 'expected bash installer to show automatic startup state before prompting');
  assert.ok(
    bashSource.includes('Installed background services:') && bashSource.includes('Automatic startup follows the'),
    'expected bash installer to show installed services and automatic-startup status before prompting',
  );
  assert.ok(bashSource.includes('Current daemon status:'), 'expected bash installer to show the current daemon status with the service summary');
  assert.ok(bashSource.includes('Local relays:'), 'expected bash installer to show local relay inventory from the aggregated preflight');
  assert.ok(
    bashSource.includes('Update automatic startup for the') && bashSource.includes('Use this installation for automatic startup?'),
    'expected bash installer prompts to ask only the next relevant automatic-startup decision',
  );
  assert.match(
    bashSource,
    /if \[\[ "\$\{has_existing_services\}" == "1" \]\] && background_service_inventory_has_matching_default_following "\$\{services_json\}"; then[\s\S]*echo "0"/,
    'expected bash installer to suppress automatic-startup prompts when the current default-following service already matches the selected channel',
  );

  assert.ok(powershellSource.includes('Installed background services:'), 'expected PowerShell installer to show installed background services before prompting');
  assert.ok(
    powershellSource.includes('Current daemon status:') && powershellSource.includes('Automatic startup follows the'),
    'expected PowerShell installer to show installed services, current daemon status, and automatic-startup status before prompting',
  );
  assert.ok(powershellSource.includes('Local relays:'), 'expected PowerShell installer to show local relay inventory from the aggregated preflight');
  assert.ok(
    powershellSource.includes('Update automatic startup for the') && powershellSource.includes('Use this installation for automatic startup?'),
    'expected PowerShell installer prompts to ask only the next relevant automatic-startup decision',
  );
  assert.match(
    powershellSource,
    /if \(\$hasExistingServices -and \(Test-BackgroundServiceInventoryHasMatchingDefaultFollowing -Entries \$Entries\)\) \{\s*return "0"\s*\}/,
    'expected PowerShell installer to suppress automatic-startup prompts when the current default-following service already matches the selected channel',
  );
});

test('installers prefer doctor repair --report-only for interactive post-install summaries when supported', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /read_background_service_report_text[\s\S]*doctor repair --report-only[\s\S]*if \[\[ -n "\$\{report_text\}" \]\]; then[\s\S]*print_installed_background_service_summary/,
    'expected bash installer to prefer doctor repair --report-only and only fall back to shell-owned summaries when unsupported',
  );
  assert.match(
    powershellSource,
    /Get-BackgroundServiceReportText[\s\S]*@\("doctor", "repair", "--report-only"\)[\s\S]*if \(-not \[string\]::IsNullOrWhiteSpace\(\$backgroundServiceReportText\)\) \{[\s\S]*Show-InstalledBackgroundServiceSummary[\s\S]*Show-InstalledLocalRelaySummary/,
    'expected PowerShell installer to prefer doctor repair --report-only and only fall back to PowerShell-owned summaries when unsupported',
  );
});

test('PowerShell installer attempts doctor repair --report-only even before any background service exists', async () => {
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    powershellSource,
    /if \(\$shouldInspectBackgroundServices -and \$Noninteractive -ne "1"\) \{[\s\S]*\$backgroundServiceReportText = Get-BackgroundServiceReportText -CliPath \$invoker[\s\S]*elseif \(\$backgroundServiceInventory\.Supported -and \$backgroundServiceInventory\.Entries\.Count -gt 0\) \{/,
    'expected PowerShell installer to try doctor repair --report-only for interactive installs even when no background service is installed yet, and only fall back to local summaries when inventory exists',
  );
});

test('installers reuse --yes when auto-installing a background service after noninteractive repair', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('run_background_service_repair_if_supported'), 'expected bash installer to centralize repair compatibility handling');
  assert.ok(bashSource.includes('run_background_service_install_compatibly'), 'expected bash installer to centralize service-install compatibility handling');
  assert.ok(powershellSource.includes('Invoke-DoctorRepairIfSupported'), 'expected PowerShell installer to centralize repair compatibility handling');
  assert.ok(powershellSource.includes('Invoke-BackgroundServiceInstallCompatibly'), 'expected PowerShell installer to centralize service-install compatibility handling');
});

test('installers skip doctor repair execution when the installed CLI only exposes legacy service commands', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.match(
    bashSource,
    /run_background_service_repair_if_supported[\s\S]*if \[\[ "\$\{repair_status\}" == "2" \]\]; then[\s\S]*run_background_service_install_compatibly/,
    'expected bash installer to bypass doctor repair execution when the command is unsupported and continue with legacy service install',
  );
  assert.match(
    powershellSource,
    /Invoke-DoctorRepairIfSupported[\s\S]*elseif \(\$repairResult\.Status -eq 'unsupported'\) \{[\s\S]*Invoke-BackgroundServiceInstallCompatibly/,
    'expected PowerShell installer to bypass doctor repair execution when the command is unsupported and continue with legacy service install',
  );
});

test('installers filter unsupported setup-relay default flags against the installed CLI help surface', async () => {
  const bashSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.sh'), 'utf8');
  const powershellSource = await readFile(join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1'), 'utf8');

  assert.ok(bashSource.includes('filter_supported_setup_relay_default_args'), 'expected bash installer to filter setup-relay default args against relay host install help');
  assert.match(
    powershellSource,
    /Get-SupportedSetupRelayDefaultArgs[\s\S]*relay host install --help/,
    'expected PowerShell installer to filter setup-relay default args against relay host install help',
  );
});
