import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAvailableProviders } from '../skill-providers/filter';
import type { SkillProvider } from '../skill-providers/types';

function make(
  id: string,
  isAvailable: SkillProvider['isAvailable'],
): SkillProvider {
  return {
    id,
    label: id,
    capabilities: { read: true, enableToggle: false, edit: false, create: false },
    isAvailable,
    // ListComponent is not exercised by filter; a no-op placeholder is fine
    ListComponent: (() => null) as unknown as SkillProvider['ListComponent'],
  };
}

describe('resolveAvailableProviders', () => {
  it('returns an empty array when given no providers', async () => {
    const out = await resolveAvailableProviders([]);
    assert.deepEqual(out, []);
  });

  it('includes providers whose isAvailable resolves to true', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => true);
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a', 'b']);
  });

  it('excludes providers whose isAvailable resolves to false', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => false);
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a']);
  });

  it('coerces thrown exceptions to unavailable', async () => {
    const a = make('a', async () => true);
    const b = make('b', async () => { throw new Error('boom'); });
    const out = await resolveAvailableProviders([a, b]);
    assert.deepEqual(out.map((p) => p.id), ['a']);
  });

  it('preserves input order', async () => {
    const providers = ['x', 'y', 'z'].map((id) => make(id, async () => true));
    const out = await resolveAvailableProviders(providers);
    assert.deepEqual(out.map((p) => p.id), ['x', 'y', 'z']);
  });
});
