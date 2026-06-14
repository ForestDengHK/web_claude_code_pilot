import { test } from 'node:test';
import assert from 'node:assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const { ToolFlightTracker } = require('../../lib/channels-client') as typeof import('../../lib/channels-client');

test('a tool is in flight after its tool_use and done after its tool_result', () => {
  const t = new ToolFlightTracker();
  assert.equal(t.inFlight, false);
  t.startTool('a');
  assert.equal(t.inFlight, true, 'tool_use → in flight');
  t.finishTool('a');
  assert.equal(t.inFlight, false, 'tool_result → no longer in flight');
});

test('concurrent tools: in flight until the LAST result arrives', () => {
  const t = new ToolFlightTracker();
  t.startTool('a');
  t.startTool('b');
  assert.equal(t.inFlight, true);
  t.finishTool('a');
  assert.equal(t.inFlight, true, 'b still running');
  t.finishTool('b');
  assert.equal(t.inFlight, false, 'both done');
});

// Regression: the CLI sometimes writes a tool_result transcript line BEFORE its
// matching tool_use line (same-instant pair; file order isn't guaranteed). A
// bare counter swallows the early decrement at zero, then never cancels the late
// increment — pinning "a tool is in flight" forever and wedging the turn until
// TURN_TIMEOUT. Id-set tracking must treat the pair as complete in either order.
test('out-of-order: tool_result before tool_use leaves nothing in flight', () => {
  const t = new ToolFlightTracker();
  t.finishTool('mjDmUs'); // result observed first (transcript line order)
  t.startTool('mjDmUs');  // matching use observed after
  assert.equal(t.inFlight, false, 'pair complete regardless of arrival order');
});

test('out-of-order does not corrupt an unrelated concurrent tool', () => {
  const t = new ToolFlightTracker();
  t.startTool('real');     // a genuinely running tool
  t.finishTool('early');   // an out-of-order result for a not-yet-seen use
  t.startTool('early');    // its use arrives late
  assert.equal(t.inFlight, true, 'the genuinely running tool still pins in flight');
  t.finishTool('real');
  assert.equal(t.inFlight, false);
});
