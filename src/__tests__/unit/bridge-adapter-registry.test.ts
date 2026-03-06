import assert from 'node:assert/strict';
import {
  BaseChannelAdapter,
  registerAdapterFactory,
  createAdapter,
  getRegisteredTypes,
  type DeliverFn,
} from '../../lib/bridge/channel-adapter';
import type {
  ChannelType, InboundMessage, OutboundMessage, SendResult,
} from '../../lib/bridge/types';

// ── Mock Adapter ────────────────────────────────────────────────

class MockAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'mock';
  private running = false;

  async start() { this.running = true; }
  async stop() { this.running = false; }
  isRunning() { return this.running; }

  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(_message: OutboundMessage): Promise<SendResult> { return { ok: true }; }

  validateConfig(): string | null { return null; }
  isAuthorized(_userId: string, _chatId: string): boolean { return true; }
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log('Running bridge-adapter-registry tests...\n');

  // Test: registerAdapterFactory + getRegisteredTypes
  {
    registerAdapterFactory('mock', () => new MockAdapter());
    const types = getRegisteredTypes();
    assert.ok(types.includes('mock'), 'getRegisteredTypes() should include "mock"');
    console.log('PASS: getRegisteredTypes() includes "mock"');
  }

  // Test: createAdapter returns instance with correct channelType
  {
    const adapter = createAdapter('mock');
    assert.ok(adapter !== null, 'createAdapter("mock") should return an instance');
    assert.equal(adapter!.channelType, 'mock', 'channelType should be "mock"');
    console.log('PASS: createAdapter("mock") returns instance with channelType "mock"');
  }

  // Test: createAdapter returns null for nonexistent type
  {
    const adapter = createAdapter('nonexistent');
    assert.equal(adapter, null, 'createAdapter("nonexistent") should return null');
    console.log('PASS: createAdapter("nonexistent") returns null');
  }

  // Test: default deliverResponse calls deliverFn with plain parseMode
  {
    const adapter = new MockAdapter();
    const address = { channelType: 'mock', chatId: 'chat-1' };
    let captured: OutboundMessage | null = null;

    const deliverFn: DeliverFn = async (_adapter, message, _opts) => {
      captured = message;
      return { ok: true };
    };

    await adapter.deliverResponse(address, 'hello **world**', deliverFn, { sessionId: 's1' });

    assert.ok(captured !== null, 'deliverFn should have been called');
    assert.equal(captured!.parseMode, 'plain', 'parseMode should be "plain"');
    assert.equal(captured!.text, 'hello **world**', 'text should be the raw markdown');
    assert.deepEqual(captured!.address, address, 'address should be passed through');
    console.log('PASS: default deliverResponse calls deliverFn with plain parseMode');
  }

  // Test: default messageLimit is 4096
  {
    const adapter = new MockAdapter();
    assert.equal(adapter.messageLimit, 4096, 'default messageLimit should be 4096');
    console.log('PASS: default messageLimit is 4096');
  }

  // Test: default streamDefaults has expected values
  {
    const adapter = new MockAdapter();
    const defaults = adapter.streamDefaults;
    assert.equal(defaults.intervalMs, 700, 'intervalMs should be 700');
    assert.equal(defaults.minDeltaChars, 20, 'minDeltaChars should be 20');
    assert.equal(defaults.maxChars, 3900, 'maxChars should be 3900');
    console.log('PASS: default streamDefaults has expected values');
  }

  console.log('\nAll tests passed.');
}

main();
