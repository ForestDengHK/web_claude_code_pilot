import { NextRequest, NextResponse } from 'next/server';
import { getFavoriteDirectories, addFavoriteDirectory, removeFavoriteDirectory, getRecentDirectories } from '@/lib/db';

export async function GET() {
  try {
    const favorites = getFavoriteDirectories();
    const recent = getRecentDirectories();
    return NextResponse.json({ favorites, recent });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch favorites' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { path, name } = body;
    if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
    addFavoriteDirectory(path, name || path.split('/').pop() || path);
    const favorites = getFavoriteDirectories();
    return NextResponse.json({ favorites });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to add favorite' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { path } = body;
    if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
    removeFavoriteDirectory(path);
    const favorites = getFavoriteDirectories();
    return NextResponse.json({ favorites });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to remove favorite' }, { status: 500 });
  }
}
