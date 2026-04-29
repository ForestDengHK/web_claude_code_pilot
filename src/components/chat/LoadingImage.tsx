'use client';

import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Loading02Icon, ImageNotFound01Icon } from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';

interface LoadingImageProps {
  src: string;
  alt: string;
  className?: string;
  /** When true, render an inline-block <span> wrapper (safe inside <p>);
   *  when false, render a block-level <div>. Defaults to false. */
  inline?: boolean;
  loading?: 'lazy' | 'eager';
}

/**
 * <img> with a centered spinner overlay while loading and a "broken image"
 * fallback on error. Used by chat-side image renderers so the user always
 * sees feedback instead of a blank or flashing area.
 */
export function LoadingImage({
  src,
  alt,
  className,
  inline = false,
  loading = 'lazy',
}: LoadingImageProps) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

  const Wrapper = inline ? 'span' : 'div';
  const wrapperClass = cn(
    'relative overflow-hidden rounded-md bg-muted/30',
    inline ? 'inline-block align-bottom' : 'block',
  );

  if (status === 'error') {
    return (
      <Wrapper className={cn(wrapperClass, 'p-3')}>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <HugeiconsIcon icon={ImageNotFound01Icon} className="h-4 w-4" />
          {alt || 'image'} (load failed)
        </span>
      </Wrapper>
    );
  }

  return (
    <Wrapper className={wrapperClass}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading={loading}
        className={cn(className, status === 'loading' && 'opacity-0')}
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('error')}
      />
      {status === 'loading' && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <HugeiconsIcon
            icon={Loading02Icon}
            className="h-5 w-5 animate-spin text-muted-foreground/70"
          />
        </span>
      )}
    </Wrapper>
  );
}
