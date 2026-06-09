// dapp/src/pages/landingpage.tsx
// the landing page is a fully-cloned static html page (framer site) served from /public.
// this component just redirects to it.
import { useEffect } from 'react';

export function LandingPage() {
  useEffect(() => {
    window.location.replace('/shield-landing.html');
  }, []);
  return null;
}
