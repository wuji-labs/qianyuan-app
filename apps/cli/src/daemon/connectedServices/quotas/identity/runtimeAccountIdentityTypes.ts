import type { ConnectedServiceId } from '@happier-dev/protocol';

export type RuntimeAccountIdentityProofStrength = 'exact' | 'weak';

export type RuntimeAccountIdentitySource =
  | 'runtime_quota_snapshot'
  | 'active_account_verification';

export type RuntimeAccountIdentityRecordInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: RuntimeAccountIdentityProofStrength;
  groupGeneration: number | null;
}>;

export type RuntimeAccountIdentityEntry = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string | null;
  profileId: string;
  providerAccountId: string;
  accountLabel: string | null;
  observedAtMs: number;
  source: RuntimeAccountIdentitySource;
  proofStrength: 'exact';
  groupGeneration: number | null;
}>;

export type RuntimeAccountIdentityRecordResult =
  | Readonly<{ status: 'recorded' }>
  | Readonly<{
      status: 'suppressed';
      reason:
        | 'exact_provider_account_proof_required'
        | 'missing_session_id'
        | 'missing_profile_id'
        | 'missing_provider_account_id'
        | 'missing_group_generation'
        | 'invalid_observed_at';
    }>;
