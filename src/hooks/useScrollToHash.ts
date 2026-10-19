import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scrolls to the element named by the URL hash once it renders, so links such
 * as /#compare or /security#audits land on sections of lazily rendered pages.
 */
export function useScrollToHash(): void {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    let attempts = 0;
    const timer = window.setInterval(() => {
      const element = document.getElementById(id);
      attempts += 1;
      if (element || attempts > 50) {
        window.clearInterval(timer);
        element?.scrollIntoView();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [hash]);
}
