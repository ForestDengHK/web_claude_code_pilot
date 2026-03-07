import { NextRequest, NextResponse } from 'next/server';
import { getSetting } from '@/lib/db';
import { buildProviderRequest, type SttProviderConfig } from '@/lib/stt/providers';

export async function POST(request: NextRequest) {
  // 1. Read STT settings
  const provider = getSetting('stt_provider');
  const apiKey = getSetting('stt_api_key');
  if (!provider || !apiKey) {
    return NextResponse.json(
      { error: 'Speech-to-text not configured. Go to Settings to set up an STT provider.' },
      { status: 400 },
    );
  }

  const config: SttProviderConfig = {
    provider,
    apiKey,
    endpoint: getSetting('stt_endpoint'),
    model: getSetting('stt_model'),
    deployment: getSetting('stt_deployment'),
  };

  // 2. Extract audio file from multipart form
  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
  }

  // 3. Build provider-specific request
  let providerReq;
  try {
    providerReq = buildProviderRequest(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid STT configuration';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // 4. Forward to provider
  const providerForm = new FormData();
  providerForm.append('file', file, file.name || 'audio.webm');
  for (const [k, v] of Object.entries(providerReq.formFields)) {
    providerForm.append(k, v);
  }

  try {
    const response = await fetch(providerReq.url, {
      method: 'POST',
      headers: providerReq.headers,
      body: providerForm,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      return NextResponse.json(
        { error: `STT provider error (${response.status}): ${errText}` },
        { status: 502 },
      );
    }

    const result = await response.json();
    return NextResponse.json({ text: result.text || '' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to reach STT provider';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
