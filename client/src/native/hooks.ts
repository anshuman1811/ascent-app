import { useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { isNative } from './platform';

// Android back button: close an open dialog first, then go back in the app's history,
// and only leave the app (to the background, like other Android apps) from the first screen.
export function useAndroidBackButton() {
  useEffect(() => {
    if (!isNative()) return;
    const handle = CapApp.addListener('backButton', ({ canGoBack }) => {
      // Dialogs mark their close button with data-back-close; the last one in the DOM is
      // the topmost (e.g. a photo lightbox opened from inside a modal).
      const closers = document.querySelectorAll<HTMLElement>('[data-back-close]');
      if (closers.length) {
        closers[closers.length - 1].click();
      } else if (canGoBack) {
        window.history.back();
      } else {
        CapApp.minimizeApp();
      }
    });
    return () => { handle.then(h => h.remove()); };
  }, []);
}

// Keep the screen on while mounted (live workout). No-op in the browser.
export function useKeepAwake(active = true) {
  useEffect(() => {
    if (!isNative() || !active) return;
    KeepAwake.keepAwake().catch(() => {});
    return () => { KeepAwake.allowSleep().catch(() => {}); };
  }, [active]);
}
