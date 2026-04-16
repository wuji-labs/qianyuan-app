import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';
import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';

type ChildServerSelectionEnv = Readonly<{
  activeServerId: string;
  canonicalServerUrl: string;
  apiServerUrl: string;
  webappUrl: string;
}>;

export function buildSpawnChildProcessEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
  serverSelectionEnv?: ChildServerSelectionEnv;
}): NodeJS.ProcessEnv {
  const env = stripNestedSessionDetectionEnv({ ...params.processEnv, ...params.extraEnv });
  delete env.HAPPIER_SESSION_AUTOSTART_DAEMON;

  if (String(params.processEnv.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() === 'background-service') {
    env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY] = '1';
  } else {
    delete env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY];
  }

  if (params.serverSelectionEnv) {
    const { activeServerId, canonicalServerUrl, apiServerUrl, webappUrl } = params.serverSelectionEnv;
    env.HAPPIER_ACTIVE_SERVER_ID = activeServerId;

    if (apiServerUrl !== canonicalServerUrl) {
      env.HAPPIER_PUBLIC_SERVER_URL = canonicalServerUrl;
      env.HAPPIER_LOCAL_SERVER_URL = apiServerUrl;
      env.HAPPIER_SERVER_URL = apiServerUrl;
    } else {
      delete env.HAPPIER_PUBLIC_SERVER_URL;
      delete env.HAPPIER_LOCAL_SERVER_URL;
      env.HAPPIER_SERVER_URL = canonicalServerUrl;
    }

    env.HAPPIER_WEBAPP_URL = webappUrl;
  }

  return env;
}
