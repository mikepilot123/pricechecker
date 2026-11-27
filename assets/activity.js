/* ============================================================
   Is anyone actually using the app on this device right now?

   Background refreshes (repairs, reminder alerts, new bookings, prices,
   inventory) ask before each round. "Idle" means the tab is hidden, or there
   has been no tap, click, key, scroll or mouse movement for IDLE_AFTER_MS.
   While idle they skip their trips to the server, so the Neon database can
   go to sleep (it suspends after 5 minutes without queries) instead of being
   kept awake all day by a screen nobody is looking at.

   When someone comes back (any input, or the tab becoming visible) an
   "rpc-active" event fires once, and each refresher catches up immediately.
   ============================================================ */
(function () {
  "use strict";

  const IDLE_AFTER_MS = 5 * 60 * 1000;
  let lastInputAt = Date.now();
  let wasIdle = false;

  const hidden = () => document.visibilityState === "hidden";
  const idle = () => hidden() || Date.now() - lastInputAt > IDLE_AFTER_MS;

  function markActive() {
    lastInputAt = Date.now();
    if (wasIdle && !hidden()) {
      wasIdle = false;
      window.dispatchEvent(new Event("rpc-active"));
    }
  }

  ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach((type) =>
    window.addEventListener(type, markActive, { passive: true, capture: true }));
  // Mouse movement counts too, but it fires constantly — note it at most
  // every few seconds.
  let lastMove = 0;
  window.addEventListener("mousemove", () => {
    const now = Date.now();
    if (now - lastMove > 5000) { lastMove = now; markActive(); }
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!hidden()) markActive();
    else wasIdle = true;
  });
  // Notice the moment the device goes idle, so the return is announced.
  setInterval(() => { if (idle()) wasIdle = true; }, 30 * 1000);

  window.RPC_ACTIVITY = {
    /** True when nobody is using the app on this device. */
    isIdle: idle,
    IDLE_AFTER_MS,
  };
})();
