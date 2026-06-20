import { describe, it, expect } from 'vitest';
import { ARTIFACT_SANDBOX, ARTIFACT_CSP, withCsp } from '../../lib/artifact-sandbox';

describe('artifact sandbox security primitives', () => {
  it('allows scripts but NEVER same-origin', () => {
    expect(ARTIFACT_SANDBOX).toContain('allow-scripts');
    expect(ARTIFACT_SANDBOX).not.toContain('allow-same-origin');
  });

  it('CSP blocks all external network by default', () => {
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
  });

  it('injects the CSP meta into an existing <head>', () => {
    const out = withCsp('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    // injected right after the opening head tag, before existing head content
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
  });

  it('wraps a fragment without <head> in a full document carrying the CSP', () => {
    const out = withCsp('<p>just a fragment</p>');
    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain('<p>just a fragment</p>');
  });
});
