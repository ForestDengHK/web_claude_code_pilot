import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getLocalFileHrefPath, rewriteLocalFileHref } from '../../lib/chat-local-file-links';

describe('chat local file link rewriting', () => {
  it('detects macOS screenshot paths emitted as markdown links', () => {
    const href = '/Users/party/Desktop/dsu_story2_e2e/subhead-delete-button-e2edel-fullpage.png';
    assert.equal(getLocalFileHrefPath(href), href);
    assert.equal(
      rewriteLocalFileHref(href, 'session-123'),
      '/api/files/raw?path=%2FUsers%2Fparty%2FDesktop%2Fdsu_story2_e2e%2Fsubhead-delete-button-e2edel-fullpage.png&session_id=session-123',
    );
  });

  it('decodes file URLs before routing them through the raw file API', () => {
    assert.equal(
      rewriteLocalFileHref('file:///Users/party/Desktop/My%20Shot.png', null),
      '/api/files/raw?path=%2FUsers%2Fparty%2FDesktop%2FMy+Shot.png',
    );
  });

  it('supports tilde paths from assistant output', () => {
    assert.equal(
      rewriteLocalFileHref('~/Desktop/shot.png', 'abc'),
      '/api/files/raw?path=%7E%2FDesktop%2Fshot.png&session_id=abc',
    );
  });

  it('leaves web, app, and ordinary relative links untouched', () => {
    assert.equal(rewriteLocalFileHref('https://example.com/image.png', 'abc'), 'https://example.com/image.png');
    assert.equal(rewriteLocalFileHref('/chat/7bee6c2ba20c9f856286297f576658e7', 'abc'), '/chat/7bee6c2ba20c9f856286297f576658e7');
    assert.equal(rewriteLocalFileHref('docs/readme.md', 'abc'), 'docs/readme.md');
  });
});
