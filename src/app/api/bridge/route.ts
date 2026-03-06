import { NextRequest, NextResponse } from 'next/server';

// GET /api/bridge — get bridge status
export async function GET() {
  try {
    const { getBridgeStatus } = await import('@/lib/bridge/bridge-manager');
    const status = getBridgeStatus();
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get bridge status';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/bridge — start/stop bridge
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body; // 'start' | 'stop'

    if (action === 'start') {
      const { startBridge } = await import('@/lib/bridge/bridge-manager');
      await startBridge();
      return NextResponse.json({ ok: true, message: 'Bridge started' });
    }

    if (action === 'stop') {
      const { stopBridge } = await import('@/lib/bridge/bridge-manager');
      await stopBridge();
      return NextResponse.json({ ok: true, message: 'Bridge stopped' });
    }

    return NextResponse.json({ ok: false, error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to perform bridge action';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
