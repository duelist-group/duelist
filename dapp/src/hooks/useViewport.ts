// dapp/src/hooks/useViewport.ts
// tiny viewport hook so inline-styled components can react to screen size.
// media queries cannot target inline styles, so layout decisions that depend
// on width are made in js here. breakpoints: mobile < 768, tablet 768-1023,
// desktop >= 1024 (the point where the fixed sidebar fits comfortably).
import { useEffect, useState } from 'react';

export const MOBILE_MAX = 767;
export const TABLET_MAX = 1023;

export interface Viewport {
  width: number;
  isMobile: boolean;   // phones
  isTablet: boolean;   // tablets / small laptops
  isCompact: boolean;  // mobile or tablet — no room for the fixed sidebar
}

function read(): Viewport {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const isMobile = width <= MOBILE_MAX;
  const isTablet = width > MOBILE_MAX && width <= TABLET_MAX;
  return { width, isMobile, isTablet, isCompact: isMobile || isTablet };
}

export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(read);

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVp(read()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return vp;
}
