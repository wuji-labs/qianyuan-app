import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import { createConnectedServiceMaterializationIdentity } from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';

type ConnectedServiceForkPatch = {
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
};

export type ConnectedServiceForkInheritedOverrides = Readonly<{
  spawn: ConnectedServiceForkPatch;
  metadata: ConnectedServiceForkPatch;
}>;

export type ConnectedServiceForkLaunchContext = Readonly<{
  hasConnectedServices: boolean;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  spawn: ConnectedServiceForkPatch;
  metadata: ConnectedServiceForkPatch;
}>;

function readNonEmptyConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data.bindingsByServiceId).length > 0 ? parsed.data : null;
}

export function createConnectedServiceForkLaunchContext(params: Readonly<{
  inherited: ConnectedServiceForkInheritedOverrides;
  nowMs?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceForkLaunchContext {
  const inheritedConnectedServices =
    readNonEmptyConnectedServices(params.inherited.spawn.connectedServices)
    ?? readNonEmptyConnectedServices(params.inherited.metadata.connectedServices);
  if (!inheritedConnectedServices) {
    return {
      hasConnectedServices: false,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    };
  }

  const materializationIdentity = createConnectedServiceMaterializationIdentity({
    ...(params.nowMs ? { nowMs: params.nowMs } : {}),
    ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
  });

  return {
    hasConnectedServices: true,
    materializationIdentity,
    spawn: {
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    },
    metadata: {
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    },
  };
}
