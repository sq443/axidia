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
