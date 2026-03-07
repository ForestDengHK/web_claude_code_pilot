// src/lib/stt/providers.ts

export interface SttProviderConfig {
  provider: string;
  apiKey: string;
  endpoint?: string;
  model?: string;
  deployment?: string;
}

interface SttRequest {
  url: string;
  headers: Record<string, string>;
  formFields: Record<string, string>;
}

type SttRequestBuilder = (config: SttProviderConfig) => SttRequest;

const PROVIDER_BUILDERS: Record<string, SttRequestBuilder> = {
  azure_openai: (config) => ({
    url: `${config.endpoint}/openai/deployments/${config.deployment}/audio/transcriptions?api-version=2024-06-01`,
    headers: { 'api-key': config.apiKey },
    formFields: {},
  }),

  openai: (config) => ({
    url: `${config.endpoint || 'https://api.openai.com'}/v1/audio/transcriptions`,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    formFields: { model: config.model || 'whisper-1' },
  }),

  groq: (config) => ({
    url: `${config.endpoint || 'https://api.groq.com/openai'}/v1/audio/transcriptions`,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    formFields: { model: config.model || 'whisper-large-v3' },
  }),
};

export function buildProviderRequest(config: SttProviderConfig): SttRequest {
  const builder = PROVIDER_BUILDERS[config.provider];
  if (!builder) {
    throw new Error(`Unknown STT provider: ${config.provider}`);
  }
  return builder(config);
}
