import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeStackTestRunnerEnv } from './test_env.mjs';

test('sanitizeStackTestRunnerEnv removes live stack and server scope from inherited test env', () => {
  const env = sanitizeStackTestRunnerEnv({
    PATH: '/bin',
    HOME: '/Users/alice',
    HAPPIER_STACK_STACK: 'repo-live',
    HAPPIER_STACK_ENV_FILE: '/Users/alice/.happier/stacks/repo-live/env',
    HAPPIER_STACK_SERVER_PORT: '52753',
    HAPPIER_HOME_DIR: '/Users/alice/.happier/stacks/repo-live/cli',
    HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
    HAPPIER_WEBAPP_URL: 'http://happier-repo-live.localhost:18829',
    HAPPIER_ACTIVE_SERVER_ID: 'stack_repo_live__id_default',
    HAPPIER_FEATURE_POLICY_ENV: '',
    HAPPIER_TEST_FEATURES_DENY: 'voice',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    HOME: '/Users/alice',
    HAPPIER_FEATURE_POLICY_ENV: '',
    HAPPIER_TEST_FEATURES_DENY: 'voice',
  });
});

test('sanitizeStackTestRunnerEnv can seed isolated stack roots for runner subprocesses', () => {
  const env = sanitizeStackTestRunnerEnv(
    {
      PATH: '/bin',
      HOME: '/Users/alice',
      HAPPIER_STACK_HOME_DIR: '/Users/alice/.happier-stack',
      HAPPIER_STACK_STORAGE_DIR: '/Users/alice/.happier/stacks',
    },
    {
      isolatedStackRoot: '/tmp/happier-stack-test-root',
    },
  );

  assert.equal(env.HAPPIER_STACK_HOME_DIR, '/tmp/happier-stack-test-root/home');
  assert.equal(env.HAPPIER_STACK_STORAGE_DIR, '/tmp/happier-stack-test-root/stacks');
  assert.equal(env.HAPPIER_STACK_WORKSPACE_DIR, '/tmp/happier-stack-test-root/workspace');
  assert.equal(env.HAPPIER_STACK_RUNTIME_DIR, '/tmp/happier-stack-test-root/runtime');
});

test('sanitizeStackTestRunnerEnv can seed the repo checkout without restoring live stack scope', () => {
  const env = sanitizeStackTestRunnerEnv(
    {
      PATH: '/bin',
      HAPPIER_STACK_STACK: 'repo-live',
      HAPPIER_STACK_REPO_DIR: '/Users/alice/live-stack-repo',
    },
    {
      isolatedStackRoot: '/tmp/happier-stack-test-root',
      repoDir: '/workspace/happier',
    },
  );

  assert.equal(env.HAPPIER_STACK_STACK, undefined);
  assert.equal(env.HAPPIER_STACK_REPO_DIR, '/workspace/happier');
});
