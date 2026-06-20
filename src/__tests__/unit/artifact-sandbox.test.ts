import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SANDBOX, ARTIFACT_CSP, withCsp } from '../../lib/artifact-sandbox';

describe('artifact sandbox security primitives', () => {
  it('allows scripts but NEVER same-origin', () => {
    assert.match(ARTIFACT_SANDBOX, /allow-scripts/);
    assert.doesNotMatch(ARTIFACT_SANDBOX, /allow-same-origin/);
  });

  it('CSP blocks all external network by default', () => {
    assert.match(ARTIFACT_CSP, /default-src 'none'/);
  });

  it('injects the CSP meta into an existing <head>', () => {
    const out = withCsp('<html><head><title>x</title></head><body>hi</body></html>');
    assert.match(out, /http-equiv="Content-Security-Policy"/);
    // injected right after the opening head tag, before existing head content
    assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<title>'));
  });

  it('wraps a fragment without <head> in a full document carrying the CSP', () => {
    const out = withCsp('<p>just a fragment</p>');
    assert.match(out, /<!DOCTYPE html>/);
    assert.match(out, /http-equiv="Content-Security-Policy"/);
    assert.match(out, /<p>just a fragment<\/p>/);
  });
});
