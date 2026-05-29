export type SessionMutationDeliveryClassification =
    | 'durable_required'
    | 'durable_best_effort'
    | 'ephemeral_drop_ok';

export type SessionMutationFactType =
    | 'transcript_message_append'
    | 'session_turn'
    | 'session_end'
    | 'usage_observation'
    | 'registered_session_state_field'
    | 'keep_alive_presence'
    | 'ephemeral_agent_message';

/**
 * Delivery classification for session-scoped facts:
 * - durable_required facts affect runtime recovery or user-visible state and must be queued,
 *   retried, and persisted until acknowledged.
 * - durable_best_effort facts may use fallback transports but are not required for recovery.
 * - ephemeral_drop_ok facts are transient presence/stream hints and must not be persisted.
 */
export const SESSION_MUTATION_DELIVERY_CLASSIFICATION: Readonly<Record<SessionMutationFactType, SessionMutationDeliveryClassification>> = {
    transcript_message_append: 'durable_required',
    session_turn: 'durable_required',
    session_end: 'durable_required',
    usage_observation: 'durable_best_effort',
    registered_session_state_field: 'durable_required',
    keep_alive_presence: 'ephemeral_drop_ok',
    ephemeral_agent_message: 'ephemeral_drop_ok',
};
