/**
 * Startup, before the first request.
 *
 * ONE JOB: make an unconfigured store impossible to miss. lib/store.js announces
 * which adapter it is standing on, but it only did so when something first
 * touched the store — which on a deploy nobody has hit yet is never, and on a
 * deploy that gets hit is buried under whatever else that request logged. The
 * failure being announced is a quota that LOOKS enforced while counting inside
 * each lambda separately, and an invisible failure is the one that survives.
 *
 * Next calls `register()` once per server process, on both Vercel and Railway.
 * It must not throw and must not slow the boot down: everything here is a
 * synchronous read of process.env plus a console line.
 */
export async function register() {
  // The edge runtime gets its own copy of this module and has no store of its
  // own to announce; announcing twice would only teach people to skim it.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { announceStore } = await import("./lib/store.js");
    announceStore();
  } catch (e) {
    // A broken startup log must never be the reason a deploy fails to boot.
    console.error(`[store] could not report the store configuration — ${String(e?.message ?? e)}`);
  }
}
