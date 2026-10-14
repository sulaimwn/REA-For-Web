/** Private uploads are mode 0600; the Linux queue must own them as this UID. */
export const WORKER_USER = "1000:1000";

// Keep this module dependency-free and erasable: setup tools import the source
// before a build, using the repository's supported Node 22.19+/24.11+ runtime.
export function assertQueueIdentity(): void {
  if (process.platform === "linux" && process.geteuid?.() !== Number(WORKER_USER.split(":")[0])) {
    throw new Error("The Linux upload queue must run as UID 1000 so the sandbox can read its private inputs.");
  }
}
