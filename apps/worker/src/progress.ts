import { StringDecoder } from "node:string_decoder";
import type { AdapterReport } from "@rea-studio/rea-adapter";

export type AnalysisProgress = { phase: string; message: string; terminal?: boolean };
export type ContainerFailure = { code: string; message: string };
export type ContainerResult = { projectId: string; reaVersion: string; report: AdapterReport };

function resultReceipt(value: unknown): ContainerResult | undefined {
  if (!value || typeof value !== "object") return;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.projectId !== "string" || !/^[a-f0-9]{64}$/iu.test(receipt.projectId) ||
      typeof receipt.reaVersion !== "string" || !receipt.report || typeof receipt.report !== "object") return;
  const report = receipt.report as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  for (const key of ["reaNodes", "reaEdges", "droppedExportShapeNodes", "mergedExternalModuleNodes",
    "droppedEdgesToDroppedNodes", "droppedEdgesDanglingEndpoint"]) {
    if (!count(report[key])) return;
  }
  for (const key of ["droppedEdgesUnknownRelation", "unrecognizedNodeKinds"]) {
    const values = report[key];
    if (!values || typeof values !== "object" || Array.isArray(values) || !Object.values(values).every(count)) return;
  }
  return { projectId: receipt.projectId, reaVersion: receipt.reaVersion, report: report as unknown as AdapterReport };
}

// stderr is orchestration metadata. StudioProject JSON on stdout stays opaque.
export class ProgressDecoder {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private dropping = false;
  failure: ContainerFailure | undefined;
  result: ContainerResult | undefined;
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
    const receipt = resultReceipt(envelope.studio_worker_result);
    if (receipt) this.result = receipt;
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
