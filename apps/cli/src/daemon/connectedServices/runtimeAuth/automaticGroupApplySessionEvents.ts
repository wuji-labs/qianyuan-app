export function shouldCommitAutomaticGroupApplySessionEvent(
  event: unknown,
  policy: Readonly<{ commitAccountSwitchEvents: boolean }>,
): boolean {
  const record = event && typeof event === 'object' ? event as Readonly<{ type?: unknown }> : null;
  if (record?.type !== 'connected_service_account_switch') return true;
  return policy.commitAccountSwitchEvents;
}
