import type {
  ChannelType, ChannelAddress, InboundMessage, OutboundMessage,
  SendResult, PreviewCapabilities, StreamConfig,
} from './types';

/**
 * Delivery function signature — injected into deliverResponse to keep adapters thin.
 * Adapters don't import the delivery layer directly.
 */
export type DeliverFn = (
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: { sessionId?: string; dedupKey?: string },
) => Promise<SendResult>;

export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;

  // Lifecycle
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;

  // Message I/O
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;

  // Auth
  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  // OCP: Rendering pushed into adapter. Default = plain text.
  async deliverResponse(
    address: ChannelAddress,
    markdownText: string,
    deliverFn: DeliverFn,
    opts?: { sessionId?: string },
  ): Promise<SendResult> {
    return deliverFn(this, { address, text: markdownText, parseMode: 'plain' }, opts);
  }

  // Platform limits as adapter properties (not a central dict)
  get messageLimit(): number { return 4096; }
  get streamDefaults(): StreamConfig {
    return { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 };
  }

  // Optional hooks
  processMediaAttachments?(message: InboundMessage): Promise<void>;
  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {}
  onMessageStart?(_chatId: string): void;
  onMessageEnd?(_chatId: string): void;
  acknowledgeUpdate?(_updateId: number): void;
  getPreviewCapabilities?(_chatId: string): PreviewCapabilities | null;
  sendPreview?(_chatId: string, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;
  endPreview?(_chatId: string, _draftId: number): void;
}

// ── Adapter Registry ────────────────────────────────────────────

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
