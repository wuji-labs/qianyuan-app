import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planServiceAction, stopService } from './service_manager.mjs';

test('planServiceAction plans a systemd user install', () => {
  const plan = planServiceAction({
    backend: 'systemd-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    definitionPath: '/home/me/.config/systemd/user/dev.happier.selfhost.service',
    definitionContents: '[Unit]\nDescription=x\n',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, '/home/me/.config/systemd/user/dev.happier.selfhost.service');
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('daemon-reload')));
  assert.ok(plan.commands.some((c) => c.cmd === 'systemctl' && c.args.includes('--user') && c.args.includes('enable')));
});

test('planServiceAction plans a windows task install', () => {
  const plan = planServiceAction({
    backend: 'schtasks-user',
    action: 'install',
    label: 'dev.happier.selfhost',
    taskName: 'Happier\\dev.happier.selfhost',
    definitionPath: 'C:\\\\Users\\\\me\\\\.happier\\\\services\\\\dev.happier.selfhost.ps1',
    definitionContents: 'Set-Location -LiteralPath "C:\\\\Users\\\\me"',
    persistent: true,
  });

  assert.equal(plan.writes.length, 1);
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Create')));
  assert.ok(plan.commands.some((c) => c.cmd === 'schtasks' && c.args.includes('/Run')));
});

test('stopService passes the launchd definition path for persistent macOS services', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'happier-service-stop-launchd-'));
  const binDir = join(tempRoot, 'bin');
  const logPath = join(tempRoot, 'launchctl.log');
  const previousPath = process.env.PATH;
  const previousLogPath = process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;

  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLogPath == null) {
      delete process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;
    } else {
      process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH = previousLogPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  await mkdir(binDir, { recursive: true });
  const launchctlPath = join(binDir, 'launchctl');
  await writeFile(
    launchctlPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const logPath = process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH;",
      "if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(process.argv.slice(2))}\\n`, 'utf8');",
    ].join('\n'),
    'utf8',
  );
  await chmod(launchctlPath, 0o755);

  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${previousPath ?? ''}`;
  process.env.HAPPIER_TEST_LAUNCHCTL_LOG_PATH = logPath;

  await assert.doesNotReject(
    stopService({
      platform: 'darwin',
      mode: 'user',
      homeDir: tempRoot,
      spec: {
        label: 'dev.happier.selfhost',
        description: 'Happier test service',
        programArgs: ['/tmp/happier-server'],
        workingDirectory: tempRoot,
      },
      persistent: true,
      uid: 501,
    }),
  );

  const launchctlInvocations = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const bootoutInvocation = launchctlInvocations.find((args) => args[0] === 'bootout');

  assert.deepEqual(bootoutInvocation, [
    'bootout',
    'gui/501',
    join(tempRoot, 'Library', 'LaunchAgents', 'dev.happier.selfhost.plist'),
  ]);
});
