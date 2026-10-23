// iOS Safari ignores user-scalable=no, so pinch and double-tap zoom are cancelled directly while
// playing (they would zoom the play field under the player's fingers).
const cancel = (e) => e.preventDefault();
const multiTouch = (e) => {
  if (e.touches.length > 1) e.preventDefault();
};
let blocked = false;

export function blockZoom(on) {
  if (on === blocked) return;
  blocked = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
    document[method](type, cancel, { passive: false });
  }
  document[method]('touchmove', multiTouch, { passive: false });
}

export const zoomBlocked = () => blocked;

// iPhone / iPad (iPadOS reports itself as a Mac, but with touch).
export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Opened from the Home Screen (no address bar already).
export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
