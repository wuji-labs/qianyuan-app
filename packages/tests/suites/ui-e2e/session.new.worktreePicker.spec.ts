/**
 * Phase 5.7 — Worktree picker UI e2e smoke (agent-input-selection-list-popover-unification).
 *
 * SCOPE (smoke-only): this spec verifies the browser-level wiring that the
 * migrated worktree picker continues to mount the SelectionList popover from
 * the agent-input checkout chip and exposes the quick-actions root step. The
 * actual assertions in the test body (see :138-146) are:
 *
 *   - The popover opens from the new-session checkout chip
 *     (`new-session-checkout-chip`) and renders inside the shared
 *     `agent-input-selection-list-popover` shell.
 *   - The root step `worktree-root` exposes the quick-actions options
 *     `current_path` and `create_git_worktree` via the option testID scheme
 *     `selection-list:worktree-root:option:<id>`.
 *
 * FR4-17.3 normalization 2026-05-12: this header previously also claimed
 * coverage for the create step drill-down, existing-worktree status/age
 * accessory testIDs (`worktree-row-age:<path>`, `worktree-row-status:<path>`),
 * and branch reuse pills (`worktree-branch-reuse:<branch>`). The test body
 * does NOT assert any of those today — adding the missing Playwright
 * assertions requires provisioning a real multi-worktree git repo with SCM
 * enrichment in the test stack, which is deferred to the deep-journey e2e
 * tracked as RV-6 child task T1 (plan §Phase 5.7) and T2 (plan §Phase 7.4).
 *
 * The status pill variant resolution, age text formatting, reuse vs create
 * routing, search filtering, back navigation, and drill-down semantics are
 * exercised by deterministic vitest suites (these own the contract; this
 * spec only proves the browser-level mount + root step renders):
 *
 *   - `apps/ui/sources/components/sessions/new/hooks/screenModel/buildWorktreeSelectionListSteps.test.tsx`
 *     (status pill variant, reuse vs create routing, branch row construction).
 *   - `apps/ui/sources/components/ui/selectionList/__tests__/SelectionList.test.tsx`
 *     (back navigation, search filtering, dynamic section state).
 *   - `apps/ui/sources/components/ui/selectionList/__tests__/SelectionList.dynamicSectionState.test.tsx`
 *     (loading/error/empty states for dynamic branch sections).
 *
 * The vitest path is preferred for those domain transformations because (1)
 * the unit tests can drive the snapshot deterministically without
 * provisioning a real remote git repo with multiple worktrees, (2) Playwright
 * keyboard simulation against a real `repoScmBranchService` RPC is slow and
 * adds little additional signal over the unit tests, (3) the browser-level
 * keyboard handling (Tab focus management, reduced-motion, ghost width
 * measurement) is owned by `SelectionListInputController` and tested there.
 *
 * Anything that requires a real session draft + machine + popover anchor
 * (the popover wiring, the chip → popover → SelectionList composition, the
 * testID contract surface) is what this e2e spec is for.
 */

import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: /new worktree picker (Phase 5 SelectionList migration)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-worktree-picker-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(cliHomeDir, { recursive: true });

        server = await startServerLight({ testDir: suiteDir });
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                HAPPIER_SERVER_URL: server.baseUrl,
            },
        });
        uiBaseUrl = ui.baseUrl;
    });

    test.afterAll(async () => {
        try { await daemon?.stop?.(); } catch { /* best-effort */ }
        try { await ui?.stop?.(); } catch { /* best-effort */ }
        try { await server?.stop?.(); } catch { /* best-effort */ }
    });

    test('the worktree popover renders the migrated SelectionList surface with the quick-actions root step', async ({ page }) => {
        if (!server || !ui || !uiBaseUrl) {
            throw new Error('test infra failed to start');
        }
        test.setTimeout(540_000);

        await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 420_000);
        await waitForInitialAppUi({ page, timeoutMs: 420_000 });
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

        const cliLogin = await startCliAuthLoginForTerminalConnect({
            testDir: suiteDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });
        await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, 90_000);
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();

        daemon = await startTestDaemon({
            testDir: suiteDir,
            happyHomeDir: cliHomeDir,
            env: {
                ...process.env,
                HAPPIER_SERVER_URL: server.baseUrl,
            },
        });

        await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`, 60_000);

        // Open the agent-input checkout chip → SelectionList popover.
        await expect(page.getByTestId('new-session-checkout-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-checkout-chip').click();

        // The worktree picker mounts inside the shared SelectionList popover shell.
        await expect(page.getByTestId('agent-input-selection-list-popover')).toBeVisible({ timeout: 30_000 });

        // The root step `worktree-root` exposes the quick-actions options by
        // stable ids (`current_path` / `create_git_worktree`). Visible labels
        // are intentionally not asserted here.
        await expect(page.getByTestId('selection-list:worktree-root:option:current_path')).toBeVisible();
        await expect(page.getByTestId('selection-list:worktree-root:option:create_git_worktree')).toBeVisible();
    });
});
