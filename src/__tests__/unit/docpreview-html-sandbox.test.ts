import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ARTIFACT_SANDBOX } from '../../lib/artifact-sandbox';

// Guards the security boundary between the two HTML renderers:
//  - DocPreview's generic .html branch renders TRUSTED user files same-origin
//    (src=/api/preview, sandbox includes allow-same-origin). The artifacts work
//    must NOT have rerouted or weakened that path.
//  - The artifact renderer renders UNTRUSTED model HTML in an opaque origin
//    (no allow-same-origin). These must never converge.
describe('html sandbox invariants', () => {
  const docPreviewSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/components/layout/DocPreview.tsx'),
    'utf8',
  );

  it('generic user .html preview stays the same-origin /api/preview iframe', () => {
    assert.match(docPreviewSrc, /\/api\/preview/);
    assert.match(docPreviewSrc, /sandbox="allow-scripts allow-same-origin/);
  });

  it('the artifact sandbox never allows same-origin', () => {
    assert.match(ARTIFACT_SANDBOX, /allow-scripts/);
    assert.doesNotMatch(ARTIFACT_SANDBOX, /allow-same-origin/);
  });
});
