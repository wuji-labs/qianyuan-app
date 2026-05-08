import type { Page } from '@playwright/test';

export type EnsureAccountReadyForConnectPage = Pick<Page, 'getByTestId' | 'getByRole' | 'waitForTimeout'>;

const READY_TEST_IDS = [
  'session-getting-started-kind-connect_machine',
  'session-getting-started-kind-start_daemon',
  'session-getting-started-kind-create_session',
  'session-getting-started-kind-select_session',
  'sidebar-expand-button',
  'session-composer-input',
  'new-session-composer-input',
  'settings-button',
] as const;

const READY_ROLE_BUTTON_NAMES = [
  'Settings',
  'Start New Session',
  'Sessions',
  'Home',
] as const;

async function countReadySignals(page: EnsureAccountReadyForConnectPage): Promise<number> {
  let total = 0;
  for (const testId of READY_TEST_IDS) {
    total += await page.getByTestId(testId).count();
  }
  for (const name of READY_ROLE_BUTTON_NAMES) {
    total += await page.getByRole('button', { name }).count();
  }
  return total;
}

async function clickCreateAccountIfPresent(page: EnsureAccountReadyForConnectPage): Promise<void> {
  const byTestId = page.getByTestId('welcome-create-account');
  if ((await byTestId.count()) > 0) {
    await byTestId.click();
    return;
  }

  const byRole = page.getByRole('button', { name: 'Create account' });
  if ((await byRole.count()) > 0) {
    await byRole.click();
  }
}

export async function ensureAccountReadyForConnect(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  timeoutMs?: number;
  clickCreateAccount?: boolean;
}>): Promise<void> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : 120_000;

  if (params.clickCreateAccount !== false) {
    await clickCreateAccountIfPresent(params.page);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await countReadySignals(params.page)) > 0) return;
    await params.page.waitForTimeout(250);
  }

  throw new Error(`Account did not reach a ready UI state within ${timeoutMs}ms.`);
}
