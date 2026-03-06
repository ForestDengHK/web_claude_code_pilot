import { NextRequest, NextResponse } from 'next/server';

// POST /api/settings/telegram/verify — verify a bot token by calling Telegram's getMe API
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ ok: false, error: 'Token is required' }, { status: 400 });
    }

    if (!/^\d+:[A-Za-z0-9_-]{35}$/.test(token)) {
      return NextResponse.json({ ok: false, error: 'Invalid token format' }, { status: 400 });
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();

    if (data.ok) {
      return NextResponse.json({
        ok: true,
        bot: {
          id: data.result.id,
          username: data.result.username,
          firstName: data.result.first_name,
        },
      });
    }

    return NextResponse.json({ ok: false, error: data.description }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
