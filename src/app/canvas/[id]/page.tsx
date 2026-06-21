'use client';

import { useParams } from 'next/navigation';
import CanvasPanel from '@/components/canvas/CanvasPanel';

export default function CanvasPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  if (!id) return <div style={{ padding: 16 }}>missing canvas id</div>;
  return (
    <div style={{ height: '100dvh' }}>
      <CanvasPanel id={id} />
    </div>
  );
}
