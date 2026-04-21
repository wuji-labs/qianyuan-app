import { spawnSync } from 'node:child_process';

import type { RepairFinding } from '@/diagnostics/doctorRepair';

import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { bold, success, warning } from '@/ui/format/styles';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

import { copyForFinding, copyForeignHome } from './prompts/_copy';

/**
 * Invoke the **current** CLI binary — not whatever `happier` resolves to on
 * PATH — as a synchronous child process with the given arguments. Delegates
 * to `buildHappyCliSubprocessLaunchSpec` so we get the same resolution logic
 * used by the rest of the codebase:
 *
 *  - Bypasses the shim wrapper (`bin/happier.mjs`, `happier.cmd`) — important
 *    for Windows where the .cmd wrapper is argv[1].
 *  - Resolves the packaged entrypoint (`dist/index.mjs`) and bundled
 *    single-executable / tsx-dev fallbacks for dev variants.
 *  - Passes the runtime-matched Node/Bun launcher plus the same
 *    `--no-warnings --no-deprecation` flags the wrapper would have used.
 *  - Inherits stdio so command output streams live to the user.
 */
function runCliCommand(args: readonly string[]): boolean {
  let launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>;
  try {
    launchSpec = buildHappyCliSubprocessLaunchSpec([...args]);
  } catch {
    // Subprocess entrypoint couldn't be resolved (no packaged dist, no
    // bundled binary, no tsx fallback). Downgrade to a non-zero result so
    // the caller surfaces the same retry-manually warning as a failing exit.
    return false;
  }
  const env = launchSpec.env
    ? { ...process.env, ...launchSpec.env }
    : process.env;
  const result = spawnSync(launchSpec.filePath, launchSpec.args, {
    stdio: 'inherit',
    env,
  });
  return result.status === 0;
}

/**
 * Walks the findings in canonical order, printing each finding's explanation
 * and asking a single yes/no per actionable finding.
 *
 * Returns `true` if the caller should apply the underlying repair plan
 * (i.e. the user accepted at least one automatic-startup finding).
 *
 * First-cut scope:
 *  - foreign_home:       informational only (printed, no prompt)
 *  - automatic_startup_*: prompt per finding; any accepted → apply plan once
 *  - running_daemon_*:   print copy + one-line next-step guidance (no auto-apply yet)
 *  - local_relay_*:      print copy + one-line next-step guidance (no auto-apply yet)
 *
 * Per-finding dispatch for running-daemon and local-relay actions will arrive
 * in a follow-up; today's behavior mirrors the existing plan-apply path.
 */
export async function runGuidedRepair(params: Readonly<{
  findings: readonly RepairFinding[];
  currentCli: Readonly<{ releaseChannel: string; version: string }>;
}>): Promise<boolean> {
  let acceptedAutomaticStartup = false;

  for (const finding of params.findings) {
    if (finding.kind === 'automatic_startup_foreign_home') {
      const lines = copyForeignHome(finding);
      console.log('');
      for (const line of lines) console.log(line);
      continue;
    }

    const copy = copyForFinding(finding, params.currentCli);
    if (!copy) continue;

    console.log('');
    for (const line of copy.body) console.log(line);

    const answer = await promptConfirmYesNo(bold(copy.question), { default: copy.default });
    if (!answer) continue;

    if (finding.kind.startsWith('automatic_startup_')) {
      acceptedAutomaticStartup = true;
      continue;
    }
    // Non-automatic-startup findings: dispatch by spawning the current CLI
    // with the right subcommand. No ask-then-print — if the user said yes we
    // actually run it here.
    const ok = dispatchFindingAction(finding);
    console.log(ok ? success(' ✔ done.') : warning(' ⚠ that command failed — you can retry manually.'));
  }

  return acceptedAutomaticStartup;
}

function dispatchFindingAction(finding: RepairFinding): boolean {
  switch (finding.kind) {
    case 'cli_self_update_available':
      return runCliCommand(cliSelfUpdateArgs(finding.releaseChannel));
    case 'running_daemon_cli_mismatch':
      // Prefer `service restart` whenever a managing service exists for the
      // same relay profile — the daemon takeover path is guarded against
      // service-owned profiles and would fail with "A background service is
      // already installed for the selected relay." Only call daemon-takeover
      // when the classifier confirmed no such service is present.
      if (finding.recoveryStrategy === 'service-restart') {
        return runCliCommand(['service', 'restart']);
      }
      return runCliCommand(['daemon', 'restart', '--takeover']);
    case 'running_daemon_duplicate_profile': {
      // Stop the older daemon: prefer the one NOT started by automatic startup,
      // else the last one in the list.
      const ordered = [...finding.daemons].sort((a, b) =>
        (b.startedBy === 'automatic-startup' ? 1 : 0) - (a.startedBy === 'automatic-startup' ? 1 : 0),
      );
      const older = ordered[ordered.length - 1];
      return runCliCommand([
        'daemon', 'stop',
        '--server-id', finding.serverId,
        '--pid', String(older.pid),
      ]);
    }
    case 'local_relay_lane_missing':
      return runCliCommand(['relay', 'host', 'install', '--channel', finding.targetReleaseChannel, '--yes']);
    case 'local_relay_version_stale':
      return runCliCommand(['relay', 'host', 'install', '--channel', finding.entry.releaseChannel, '--yes']);
    default:
      // Other findings (automatic-startup) are applied via the plan path after
      // the walk returns true. This function should only see dispatchable kinds.
      return false;
  }
}

function cliSelfUpdateArgs(channel: 'stable' | 'preview' | 'dev'): string[] {
  if (channel === 'preview') return ['self', 'update', '--preview'];
  if (channel === 'dev') return ['self', 'update', '--dev'];
  return ['self', 'update'];
}
