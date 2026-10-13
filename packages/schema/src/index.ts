// StudioProject: the contract between the REA adapter, the API, and the UI.
//
// Derived from real `rea-agents@6.4.0` `analyze-javascript-application` output
// (see fixtures/README.md). Every enum value below was observed in a fixture or
// is listed by REA's own CLI schema; nothing is invented. Unknown future values
// from REA must be mapped to the closest "unknown"/"other" member by the adapter.
//
// v0.1 deliberately omits REA's semantic (function-level dataflow) graph.

export const STUDIO_SCHEMA_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Evidence

/** How a fact was established. Mirrors REA `evidence.state`. */
export const EVIDENCE_STATES = ['observed', 'inferred', 'unavailable'] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/**
 * REA's categorical confidence, strongest first. There is no numeric score:
 * never convert these to percentages. Note that confidence describes REA's
 * certainty about the extracted value, not whether the node kind is correct
 * (e.g. REA marks misclassified `endpoint` values as `exact`).
 */
export const CONFIDENCE_LEVELS = ['exact', 'high', 'medium', 'low', 'unknown'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Where a fact points in the analyzed artifact. Paths are relative to the artifact root. */
export type EvidenceLocation =
  | {
      kind: 'source-range';
      file: string;
      start: { line: number; column: number };
      end: { line: number; column: number };
    }
  | { kind: 'artifact-path'; file: string };

export interface Evidence {
  state: EvidenceState;
  confidence: Confidence;
  /** REA `evidence.authority`. Seen: `artifact-bytes`, `ast-static-analysis`, `static-relationship-inference`. */
  authority: string;
  /** REA `evidence.extractor.operation`, e.g. `map-ipc-transmission`. */
  extractor: string;
  location: EvidenceLocation | null;
  /** REA's per-fact limitations, verbatim. */
  limitations: string[];
}

/**
 * Who asserted a node or edge. REA facts are `rea`. Anything Studio derives on
 * top of REA (e.g. linking `window.api.x()` to a bridge, filtering endpoints)
 * must be `studio-heuristic` so the UI can label it as our interpretation.
 */
export type Origin =
  | { source: 'rea' }
  | { source: 'studio-heuristic'; heuristic: string; basis: string };

// ---------------------------------------------------------------------------
// Coverage and failures

export const COVERAGE_STATUSES = ['complete', 'partial', 'unknown'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export interface Coverage {
  status: CoverageStatus;
  truncated: boolean;
  /** Named limits REA reported, e.g. `javascript_analysis_worker_heap_limit_bytes`. */
  limits: { name: string; value: number; unit: string }[];
}

/** REA `analysis_failure` / `application_projection_failure`, minus nested details. */
export interface AnalysisFailure {
  /** Seen: `resource_constraint`. */
  code: string;
  category: string;
  message: string;
  retryable: boolean;
}

/** Finding categories of an Electron/JavaScript app, in display order. */
export const JAVASCRIPT_FINDING_CATEGORIES = [
  'source-files',
  'imports',
  'processes',
  'windows',
  'ipc',
  'bridge-apis',
  'native-addons',
  'endpoints',
  'storage',
  'workers',
] as const;

/** Finding categories of a .NET program (REA managed static analysis, T021), in display order. */
export const DOTNET_FINDING_CATEGORIES = ['types', 'methods', 'native-imports', 'external-apis'] as const;

/**
 * Areas the UI reports on. Each gets a FindingCoverage entry. A project lists only
 * the categories for its kind of app (see the two lists above).
 */
/** Finding categories of a native program (REA with Ghidra, T021), in display order. */
export const NATIVE_FINDING_CATEGORIES = ['functions', 'native-imports', 'endpoints', 'storage'] as const;

export const FINDING_CATEGORIES = [...JAVASCRIPT_FINDING_CATEGORIES, ...DOTNET_FINDING_CATEGORIES, 'functions'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * "Not found" and "absent" are different claims.
 * - `found`: at least one item.
 * - `not-found`: nothing was found. This is NOT evidence of absence; REA states
 *   that missing static findings never establish absence.
 * - `confirmed-absent`: absence was positively established. REA 6.4.0 static
 *   analysis never establishes this; reserved for future evidence sources.
 */
export type FindingStatus = 'found' | 'not-found' | 'confirmed-absent';

export interface FindingCoverage {
  category: FindingCategory;
  status: FindingStatus;
  count: number;
  /** Items REA saw but could not resolve, e.g. IPC calls with a variable channel. */
  unresolvedCount: number;
  /** Coverage of the analysis that would have produced these findings. */
  coverage: CoverageStatus;
  /** Short human-readable reasons, e.g. "7 IPC operations use dynamic channel names". */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Nodes

interface NodeBase<K extends string> {
  /** REA `node_id`, or a Studio id for deduplicated/heuristic nodes. */
  id: string;
  kind: K;
  label: string;
  /** One entry per REA observation backing this node. */
  evidence: Evidence[];
  origin: Origin;
}

/** The package.json(s) in the artifact. */
export interface PackageNode extends NodeBase<'package'> {
  name: string;
  version: string | null;
  path: string;
  main: string | null;
}

/** A shipped file (REA `javascript-asset` / `artifact`). */
export interface FileNode extends NodeBase<'file'> {
  path: string;
  /** Seen: javascript, html, json, package-json. Source maps and native add-ons have their own kinds. */
  fileKind: 'javascript' | 'html' | 'json' | 'package-json' | 'other';
  bytes: number | null;
  parseStatus: 'complete' | 'partial' | null;
  /** Set when REA dropped this file's relationships (e.g. shared result budget). */
  analysisIssue: AnalysisFailure | null;
}

/**
 * An original source file recovered from a source map (REA `source-module`),
 * e.g. `app/src/ui/history/compare.tsx`. Distinct from what actually ships:
 * REA 6.4.0 gives these no import edges of their own.
 */
export interface SourceFileNode extends NodeBase<'source-file'> {
  /** Resolved path, e.g. `app/src/ui/history/compare.tsx`. */
  path: string;
  /** Name as written in the map, e.g. `webpack:///./app/src/ui/history/compare.tsx`. */
  originalName: string;
  sourceMapPath: string;
  contentAvailable: boolean;
}

/** A source map file or reference (REA `source-map`). */
export interface SourceMapNode extends NodeBase<'source-map'> {
  path: string | null;
  /** `false` when a bundle references a map that isn't shipped. */
  available: boolean;
}

/** A JS module as shipped or as recovered from a bundle (REA `javascript-module`, role `source-module`). */
export interface ModuleNode extends NodeBase<'module'> {
  path: string;
  format: 'esm' | 'commonjs' | 'unknown';
  exportNames: string[];
  /** Present when the module was recovered from inside a bundle chunk. */
  bundler: { name: string; runtime: string; moduleKey: string } | null;
}

/**
 * Something imported by specifier that isn't a file in the artifact
 * (e.g. `electron`, `fs`, `node:path`). Deduplicated by specifier: REA emits
 * one node per import site; their evidence is merged here.
 */
export interface ExternalModuleNode extends NodeBase<'external-module'> {
  specifier: string;
  resolution: 'external' | 'not-found' | 'unresolved';
}

/** A bundler chunk (REA `javascript-chunk`). */
export interface BundleChunkNode extends NodeBase<'bundle-chunk'> {
  path: string;
  /** Seen: `webpack`, `esbuild`. */
  bundler: string;
  runtime: string;
  chunkKeys: string[];
  moduleCount: number;
}

/** An Electron process entrypoint (REA `electron-main` / `electron-renderer` / `electron-preload`). */
export interface ProcessNode extends NodeBase<'process'> {
  role: 'main' | 'renderer' | 'preload';
  /** File the process starts from, relative to the artifact root. */
  path: string;
  declaredPath: string;
  /** e.g. `package.json:main`, `html-script-entrypoint`, `BrowserWindow:webPreferences.preload`. */
  mechanism: string;
}

export interface WebPreference {
  name: string;
  /** Seen: `literal`. */
  status: string;
  value: string | number | boolean | null;
  expression: string | null;
}

/** A `new BrowserWindow(...)` site (REA `browser-window`). */
export interface WindowNode extends NodeBase<'window'> {
  sourcePath: string;
  webPreferences: WebPreference[];
  preloadPath: string | null;
}

/** `contextBridge.exposeInMainWorld(apiKey, {...})` (REA `context-bridge-api`). */
export interface BridgeApiNode extends NodeBase<'bridge-api'> {
  apiKey: string | null;
  world: string;
  members: string[];
  unknownMemberCount: number;
}

export type IpcSide = 'main' | 'renderer';
/** Seen: send, send-sync, invoke, on, handle. */
export type IpcOperation = 'send' | 'send-sync' | 'invoke' | 'on' | 'handle';
export type ChannelResolution = 'literal' | 'dynamic';

/** An IPC channel (REA `ipc-channel`). `channel` is null when its name is a runtime value. */
export interface IpcChannelNode extends NodeBase<'ipc-channel'> {
  channel: string | null;
  /** Source text of the channel argument when dynamic, e.g. `e`. */
  channelExpression: string | null;
  resolution: ChannelResolution;
  usages: { side: IpcSide; operation: IpcOperation }[];
}

/** An `ipcMain.handle/on` or `ipcRenderer.on` registration (REA `ipc-handler`). */
export interface IpcHandlerNode extends NodeBase<'ipc-handler'> {
  side: IpcSide;
  operation: IpcOperation;
  channel: string | null;
  channelExpression: string | null;
  /** Seen: `inline-function`, `identifier`. */
  handlerKind: string;
}

/** A shipped `.node` binary (REA `native-addon`). */
export interface NativeAddonNode extends NodeBase<'native-addon'> {
  path: string;
  bytes: number | null;
}

/**
 * A candidate network endpoint or route (REA `endpoint`). Unfiltered REA 6.4.0
 * output is mostly false positives (2 of 89 real in GitHub Desktop); any
 * filtering is a studio-heuristic concern, not part of this node.
 */
export interface EndpointNode extends NodeBase<'endpoint'> {
  endpointKind: 'network' | 'route';
  value: string;
  /** How it was found, e.g. `call:fetch`, `call:request`, `call:XA.CODES.get`. */
  mechanism: string;
}

/** A persisted key (REA `storage`). */
export interface StorageNode extends NodeBase<'storage'> {
  /** Seen: `local-storage`. */
  storageKind: string;
  name: string | null;
  mechanism: string;
}

/** A `new Worker(...)` site (REA `worker`). */
export interface WorkerNode extends NodeBase<'worker'> {
  expression: string | null;
  resolvedPath: string | null;
}

// ---------------------------------------------------------------------------
// .NET nodes (T021). From REA's managed static analysis: `inspect_managed_*` plus
// `project_managed_application_graph`. Nothing here loads or runs the assembly.

/** A managed assembly and its module (REA `managed-assembly` + `managed-module`). */
export interface AssemblyNode extends NodeBase<'assembly'> {
  name: string;
  version: string | null;
  /** Module file name, e.g. `TinyNotes.exe`. */
  moduleName: string | null;
  /** Module version id; identifies this exact build. */
  mvid: string | null;
  /** e.g. `anycpu`, `x86`, `x64`. */
  architecture: string | null;
  /** CLR metadata version, e.g. `v4.0.30319`. */
  runtimeVersion: string | null;
  ilOnly: boolean | null;
  /** `Type.Method` of the entry point, when it's a method in this assembly. */
  entryPoint: string | null;
  references: { name: string; version: string | null }[];
  resources: { name: string; bytes: number | null; embedded: boolean }[];
}

/** A type defined in the assembly (REA `managed-type`). */
export interface ManagedTypeNode extends NodeBase<'managed-type'> {
  fullName: string;
  namespace: string;
  name: string;
  /** Compiler-made types such as `<Module>` or async state machines (`<PushAsync>d__0`). */
  compilerGenerated: boolean;
  /** Field names, from REA `managed-field` nodes (not drawn as nodes of their own). */
  fields: string[];
}

/** A method defined in the assembly (REA `managed-method`, plus its `managed-native-implementation` if any). */
export interface ManagedMethodNode extends NodeBase<'managed-method'> {
  declaringType: string;
  name: string;
  /** IL body size in bytes; null for P/Invoke declarations, which have no body. */
  ilSize: number | null;
  /** Declared as a P/Invoke into native code; see the `imports` edge to its `native-import`. */
  pinvoke: boolean;
  entryPoint: boolean;
}

/** A P/Invoke declaration: managed code calling a native library (REA `managed-pinvoke-import`). */
export interface NativeImportNode extends NodeBase<'native-import'> {
  /** e.g. `user32.dll`. REA proves the declaration only, not that the library or export exists. */
  library: string;
  /** Native export name, e.g. `MessageBoxW` or `seal_note`. */
  entryPoint: string;
  /** Managed method that declares it, e.g. `SealNote`. */
  /** .NET: the managed method that declares it (e.g. `SealNote`); null for a native program's own imports. */
  managedName: string | null;
  /** e.g. `winapi`, `cdecl`. */
  callingConvention: string | null;
  charSet: string | null;
}

/**
 * A member outside the assembly that its code calls (a CIL `call`/`callvirt`/`newobj`
 * target from REA `inspect_managed_members.call_edges`). REA 6.4.0 doesn't resolve the
 * declaring type, so only the member name and signature are known.
 */
/** A function in a native program, as Ghidra analyzed it through REA (T021). Import thunks are folded into their import. */
export interface NativeFunctionNode extends NodeBase<'native-function'> {
  /** Entry address, e.g. `0x1400016a0`. */
  address: string;
  /** Symbol name, or Ghidra's `FUN_<address>` when the binary has no symbol. */
  name: string;
  /** The program's entry point (`entry`, or a C runtime start symbol). */
  entryPoint: boolean;
}

export interface ExternalMemberNode extends NodeBase<'external-member'> {
  name: string;
  parameterTypes: string[];
  returnType: string | null;
}

/** Part of the artifact REA could not analyze (REA `unknown`). Shown so gaps are visible. */
export interface AnalysisGapNode extends NodeBase<'analysis-gap'> {
  path: string;
  operation: string;
  failure: AnalysisFailure | null;
}

export type StudioNode =
  | PackageNode
  | FileNode
  | SourceFileNode
  | SourceMapNode
  | ModuleNode
  | ExternalModuleNode
  | BundleChunkNode
  | ProcessNode
  | WindowNode
  | BridgeApiNode
  | IpcChannelNode
  | IpcHandlerNode
  | NativeAddonNode
  | EndpointNode
  | StorageNode
  | WorkerNode
  | AssemblyNode
  | ManagedTypeNode
  | ManagedMethodNode
  | NativeImportNode
  | ExternalMemberNode
  | NativeFunctionNode
  | AnalysisGapNode;

export type StudioNodeKind = StudioNode['kind'];

export const NODE_KINDS = [
  'package',
  'file',
  'source-file',
  'source-map',
  'module',
  'external-module',
  'bundle-chunk',
  'process',
  'window',
  'bridge-api',
  'ipc-channel',
  'ipc-handler',
  'native-addon',
  'endpoint',
  'storage',
  'worker',
  'assembly',
  'managed-type',
  'managed-method',
  'native-import',
  'external-member',
  'native-function',
  'analysis-gap',
] as const satisfies readonly StudioNodeKind[];

// Compile-time check that NODE_KINDS lists every StudioNode kind.
type MissingNodeKinds = Exclude<StudioNodeKind, (typeof NODE_KINDS)[number]>;
const nodeKindsComplete: [MissingNodeKinds] extends [never] ? true : MissingNodeKinds = true;
void nodeKindsComplete;

// ---------------------------------------------------------------------------
// Edges

/** REA relation names, kept verbatim. */
export const RELATIONS = [
  'contains',
  'imports',
  'exposes',
  'loads',
  'maps_to',
  'invokes',
  'sends',
  'handles',
  'calls',
  'persists_to',
] as const;
export type Relation = (typeof RELATIONS)[number];

/** Relation-specific facts copied from REA edge properties. All optional. */
export interface EdgeDetails {
  // imports / exposes
  specifier?: string | null;
  /** e.g. `require`, `import`, `re-export`, `export`, `commonjs-export`. */
  linkKind?: string;
  importedName?: string | null;
  exportedName?: string | null;
  resolutionStatus?: 'resolved' | 'external' | 'not-found' | null;
  // IPC
  channel?: string | null;
  channelExpression?: string | null;
  channelResolution?: ChannelResolution;
  side?: IpcSide;
  operation?: IpcOperation;
  /** How REA paired sender and handler, e.g. `unique-exact-literal-channel`. */
  pairingBasis?: string;
  // calls / persists_to / loads. For .NET calls: the CIL opcode (`call`, `callvirt`, `newobj`).
  mechanism?: string;
  /** .NET calls: how many call sites the drawn edge stands for. */
  callSites?: number;
}

export interface StudioEdge {
  /** REA `edge_id`, or a Studio id for heuristic edges. */
  id: string;
  source: string;
  target: string;
  relation: Relation;
  evidence: Evidence;
  origin: Origin;
  details: EdgeDetails;
}

// ---------------------------------------------------------------------------
// Project

export interface TargetInfo {
  /** Package name when known, else the artifact's file/directory name. */
  name: string;
  version: string | null;
  /** REA `subject.digest.sha256`. Also the cache/dedupe key. */
  sha256: string;
  /**
   * Extracted app directory or shipped ASAR archive, matching REA's artifact format; `pe` for a
   * .NET executable or DLL; `url` for a website captured through a browser.
   */
  format: 'asar' | 'directory' | 'pe' | 'url';
  /**
   * `electron` when REA found any Electron process (main, preload or renderer); otherwise `javascript`.
   * `dotnet` for managed PE/CLI programs; `web` for a website (T021).
   */
  appKind: 'electron' | 'javascript' | 'dotnet' | 'web' | 'native';
}

export interface AnalysisInfo {
  engine: {
    package: 'rea-agents';
    version: string;
    /** e.g. `analyze_javascript_application`. */
    operation: string;
  };
  /** REA `evidence_id` of the full result this project was built from. */
  reaEvidenceId: string;
  coverage: Coverage;
  /** REA top-level limitations, deduplicated, verbatim. */
  limitations: string[];
  statistics: {
    relevantFiles: number;
    parsedJavascriptFiles: number;
    parseFailures: number;
    findings: number;
  };
  /** Files whose relationships REA dropped; see FileNode.analysisIssue. */
  filesWithAnalysisIssues: number;
  /** Parts of REA's output intentionally left out of this project. `managed-fields` are listed on their type instead. */
  omitted: ('semantic-graph' | 'export-shape-nodes' | 'managed-fields')[];
}

/** REA `summary.ipc`, renamed. Lets the UI explain IPC gaps. */
export interface IpcSummary {
  operations: number;
  literalChannels: number;
  dynamicChannelOperations: number;
  rendererTransmissions: number;
  rendererListeners: number;
  mainHandlers: number;
  pairedRendererTransmissions: number;
  ambiguousRendererTransmissions: number;
  unpairedLiteralRendererTransmissions: number;
}

export interface StudioProject {
  schemaVersion: typeof STUDIO_SCHEMA_VERSION;
  /** Equals target.sha256. */
  id: string;
  target: TargetInfo;
  analysis: AnalysisInfo;
  findings: FindingCoverage[];
  ipcSummary: IpcSummary;
  nodes: StudioNode[];
  edges: StudioEdge[];
}
