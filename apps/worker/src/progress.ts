import { StringDecoder } from "node:string_decoder";

export type AnalysisProgress = { phase: string; message: string; terminal?: boolean };
export type ContainerFailure = { code: string; message: string };

// stderr is orchestration metadata. Raw analysis JSON on stdout stays opaque.
export class ProgressDecoder {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private dropping = false;
  failure: ContainerFailure | undefined;
  constructor(private onProgress?: (progress: AnalysisProgress) => void) {}
  write(chunk: Buffer) {
    for (const segment of this.decoder.write(chunk).split(/(?<=\n)/u)) {
      if (!this.dropping) this.pending += segment;
      if (this.pending.length > 16_384) { this.pending = ""; this.dropping = true; }
      if (segment.endsWith("\n")) {
        if (!this.dropping) this.line(this.pending.trim());
        this.pending = "";
        this.dropping = false;
      }
    }
  }
  end() {
    this.pending += this.decoder.end();
    if (!this.dropping) this.line(this.pending.trim());
    this.pending = "";
  }
  private line(line: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (parsed === null || typeof parsed !== "object") return;
    const envelope = parsed as Record<string, unknown>;
    const value = envelope.rea_progress;
    if (value !== null && typeof value === "object") {
      const progress = value as Record<string, unknown>;
      if (typeof progress.phase === "string" && typeof progress.message === "string") {
        const event: AnalysisProgress = { phase: progress.phase, message: progress.message };
        if (typeof progress.terminal === "boolean") event.terminal = progress.terminal;
        this.onProgress?.(event);
      }
    }
    const failure = envelope.studio_worker_error;
    if (failure !== null && typeof failure === "object") {
      const error = failure as Record<string, unknown>;
      if (typeof error.code === "string" && typeof error.message === "string") {
        this.failure = { code: error.code, message: error.message.slice(0, 1_024) };
      }
    }
  }
}
