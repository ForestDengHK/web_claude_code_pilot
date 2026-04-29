'use client';

import { LoadingImage } from './LoadingImage';

interface ImageThumbnailProps {
  src: string;
  alt: string;
  onClick: () => void;
}

export function ImageThumbnail({ src, alt, onClick }: ImageThumbnailProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition"
    >
      <LoadingImage
        src={src}
        alt={alt}
        className="max-h-32 w-full object-cover rounded-lg"
      />
    </button>
  );
}
