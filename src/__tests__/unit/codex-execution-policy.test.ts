import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSandboxPolicy,
  resolveDesiredApprovalPolicy,
  resolveDesiredSandboxMode,
} from '../../lib/codex-client';

describe('resolveDesiredApprovalPolicy', () => {
  it('forces never when skip-permissions is enabled', () => {
    assert.equal(resolveDesiredApprovalPolicy(true, null, null), 'never');
  });

  it('preserves a safe configured approval policy when shield is off', () => {
    assert.equal(resolveDesiredApprovalPolicy(false, 'on-request', null), 'on-request');
    assert.equal(resolveDesiredApprovalPolicy(false, 'untrusted', null), 'untrusted');
  });

  it('overrides configured never when shield is off', () => {
    assert.equal(resolveDesiredApprovalPolicy(false, 'never', null), 'untrusted');
  });

  it('overrides a never thread policy when shield is off', () => {
    assert.equal(resolveDesiredApprovalPolicy(false, null, 'never'), 'untrusted');
  });
});

describe('resolveDesiredSandboxMode', () => {
  it('forces workspace-write when shield is off and config is full access', () => {
    assert.equal(
      resolveDesiredSandboxMode(false, 'danger-full-access', 'danger-full-access'),
      'workspace-write',
    );
  });

  it('preserves a safe configured sandbox when shield is off', () => {
    assert.equal(resolveDesiredSandboxMode(false, 'workspace-write', null), 'workspace-write');
    assert.equal(resolveDesiredSandboxMode(false, 'read-only', null), 'read-only');
  });

  it('keeps the existing sandbox when skip-permissions is enabled', () => {
    assert.equal(
      resolveDesiredSandboxMode(true, 'danger-full-access', 'workspace-write'),
      'danger-full-access',
    );
  });
});

describe('buildSandboxPolicy', () => {
  it('builds a restrictive workspace-write policy rooted at the working directory', () => {
    const policy = buildSandboxPolicy('workspace-write', '/repo', null);
    assert.deepEqual(policy, {
      type: 'workspaceWrite',
      writableRoots: ['/repo'],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
  });

  it('merges configured workspace-write settings', () => {
    const policy = buildSandboxPolicy('workspace-write', '/repo', {
      writable_roots: ['/cache', '/repo'],
      network_access: true,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
    assert.deepEqual(policy, {
      type: 'workspaceWrite',
      writableRoots: ['/repo', '/cache'],
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
  });
});
