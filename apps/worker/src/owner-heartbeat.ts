import type { Readable } from "node:stream";

// Private host-to-container liveness channel; uploaded bytes never reach stdin.
export const OWNER_HEARTBEAT = "rea-owner\n";
export const OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
export const OWNER_TIMEOUT_MS = 20_000;
export const OWNER_PROTOCOL_LABEL = "rea-studio.owner-protocol";
export const OWNER_PROTOCOL_VERSION = "1";

export function monitorOwner(input: Readable, onLost: () => void) {
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout>;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller may close before awaiting readiness; never emit an unhandled rejection.
  void ready.catch(() => {});
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    input.off("data", beat).off("end", lost).off("close", lost).off("error", lost);
    input.pause();
  };
  const lost = () => {
    if (stopped) return;
    stop();
    rejectReady(new Error("Analysis owner disconnected."));
    onLost();
  };
  const beat = (chunk: Buffer | string) => {
    if (stopped || chunk.length === 0) return;
    clearTimeout(timer);
    timer = setTimeout(lost, OWNER_TIMEOUT_MS);
    if (!started) { started = true; resolveReady(); }
  };
  timer = setTimeout(lost, OWNER_TIMEOUT_MS);
  input.on("data", beat).once("end", lost).once("close", lost).once("error", lost);
  input.resume();
  if (input.destroyed || input.readableEnded) lost();
  return {
    ready,
    close() { stop(); input.destroy(); },
  };
}
