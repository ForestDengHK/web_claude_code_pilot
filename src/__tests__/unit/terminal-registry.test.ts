import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalProvider, ConnectOptions } from '../../lib/terminal/provider.js';

function makeStub(id: string): TerminalProvider {
  return {
    id,
    displayName: `Stub(${id})`,
    type: 'stub',
    connect: async (_sid: string, _opts: ConnectOptions) => { throw new Error('stub'); },
  };
}

describe('ProviderRegistry', async () => {
  // Fresh class instance per test — avoids singleton state bleed
  const { ProviderRegistry } = await import('../../lib/terminal/registry.js');

  it('starts empty', () => {
    const reg = new ProviderRegistry();
    assert.deepEqual(reg.list(), []);
  });

  it('registers and retrieves a provider', () => {
    const reg = new ProviderRegistry();
    const p = makeStub('local');
    reg.register(p);
    assert.strictEqual(reg.get('local'), p);
  });

  it('lists all registered providers', () => {
    const reg = new ProviderRegistry();
    reg.register(makeStub('local'));
    reg.register(makeStub('ssh-x'));
    assert.equal(reg.list().length, 2);
  });

  it('returns undefined for unknown id', () => {
    const reg = new ProviderRegistry();
    assert.strictEqual(reg.get('ghost'), undefined);
  });

  it('throws when registering duplicate id', () => {
    const reg = new ProviderRegistry();
    reg.register(makeStub('local'));
    assert.throws(() => reg.register(makeStub('local')), /already registered/);
  });
});
