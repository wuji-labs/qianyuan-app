export type CodexLiveAccountIdentity = Readonly<{
  activeAccountId: string | null;
  accountLabel: string | null;
}>;

type CodexAccountReadClient = Readonly<{
  request(method: 'account/read', params: null): Promise<unknown>;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readCodexLiveAccountIdentity(value: unknown): CodexLiveAccountIdentity {
  const response = readRecord(value);
  const account = readRecord(response?.account) ?? response;
  return {
    activeAccountId: readString(
      account?.id
        ?? account?.accountId
        ?? account?.account_id
        ?? account?.chatgptAccountId
        ?? account?.chatgpt_account_id,
    ),
    accountLabel: readString(account?.email ?? account?.accountEmail ?? account?.account_email),
  };
}

export async function readCodexLiveAccountIdentityFromClient(
  client: CodexAccountReadClient,
): Promise<CodexLiveAccountIdentity> {
  return readCodexLiveAccountIdentity(await client.request('account/read', null));
}
