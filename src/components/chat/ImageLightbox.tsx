'use client';

import { useState, useCallback } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { PinchZoomContainer } from '@/components/project/PinchZoomContainer';

interface LightboxImage {
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageLightbox({ images, initialIndex, open, onOpenChange }: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const goToPrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
  }, [images.length]);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
  }, [images.length]);

  // Reset index when dialog opens with a new initialIndex
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (newOpen) {
      setCurrentIndex(initialIndex);
    }
    onOpenChange(newOpen);
  }, [initialIndex, onOpenChange]);

  if (images.length === 0) return null;

  const current = images[currentIndex];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="h-[92vh] w-[92vw] max-w-[92vw] p-0 border-none bg-black/90 shadow-none sm:max-w-[92vw]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        {/* Dedicated close button: the shared dialog close renders a dark X that
            is invisible on this black backdrop. A white icon on a translucent
            circle (z-20, large tap target) stays visible and reliably hittable
            even while the image is zoomed. */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="absolute right-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white shadow-md backdrop-blur-sm transition hover:bg-black/80"
        >
          <XIcon className="h-5 w-5" />
        </button>
        <div className="relative h-full w-full">
          {/* Pinch-to-zoom / pan / double-tap — same gestures as file preview.
              resetKey clears zoom when navigating to another image. */}
          <PinchZoomContainer resetKey={current.src}>
            <div className="flex h-full w-full items-center justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.src}
                alt={current.alt}
                className="max-h-full max-w-full object-contain select-none"
                draggable={false}
              />
            </div>
          </PinchZoomContainer>

          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={goToPrev}
                className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition"
              >
                <ChevronLeftIcon className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={goToNext}
                className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition"
              >
                <ChevronRightIcon className="h-6 w-6" />
              </button>
              <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-white/70 text-sm">
                {currentIndex + 1} / {images.length}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
