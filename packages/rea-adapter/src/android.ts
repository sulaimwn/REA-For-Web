// REA 6.4.0 Android analysis (JADX provider) → StudioProject (T021).
//
// Input is the bundle `collectAndroidBundle` gathers in one REA MCP session (see android-session.ts
// and fixtures/samples/tiny-android.rea-6.4.0.json):
//   inspect_android_package                      package, SDKs, permissions, decoded manifest
//   search_android_classes                       every class name
//   inspect_android_class   { <class>: env }     the app's classes: methods, fields, inner classes
//   inspect_android_method  { <class>#<method>#<overload>: env }   each method decompiled to Java
//   trace_android_references { <class>: env }    classes whose code refers to each top-level class
//   studio_collection                            what the collector capped (not REA output)
//
// REA facts: the manifest's package, permissions and components; classes and methods; references.
// Studio rules (labeled `studio-heuristic`) read REA's decompiled Java for what the manifest and
// member lists can't say: the WebView JavaScript bridge (`addJavascriptInterface`), pages it loads,
// URL literals, databases / preferences / files, components started with an Intent, and network APIs.
import {
  STUDIO_SCHEMA_VERSION,
  type AndroidComponentNode,
  type Evidence,
  type FindingCoverage,
  type ManagedMethodNode,
  type ManagedTypeNode,
  type Origin,
  type StudioEdge,
  type StudioNode,
  type StudioProject,
} from '@rea-studio/schema';
import { manifestComponents } from './android-manifest.js';
import { ReaOutputError } from './errors.js';
import { assessEndpoints } from './heuristics.js';
import type { AdapterOptions, AdapterReport } from './index.js';

interface Envelope {
  evidence_id?: string;
  subject?: { name?: string; digest?: { sha256?: string } };
  normalized_result?: unknown;
  confidence?: string;
  authority?: string;
  limitations?: unknown;
  locations?: { kind?: string; path?: string }[];
}

interface PackageResult {
  package_name?: unknown;
  version_name?: unknown;
  min_sdk?: unknown;
  target_sdk?: unknown;
  permissions?: unknown;
  manifest?: { text?: unknown; status?: unknown };
}
interface MethodInfo { name?: unknown; overload_index?: unknown }
interface ClassResult { class_name?: unknown; methods?: MethodInfo[]; fields?: { name?: unknown }[]; inner_classes?: unknown[] }
interface MethodResult { body_status?: unknown; source?: { text?: unknown; status?: unknown } }
interface Reference { kind?: unknown; reported_full_name?: unknown; containing_class?: unknown; top_class?: unknown }
const limitationsOf = (env: Envelope | undefined): string[] => Array.isArray(env?.limitations)
  ? env.limitations.filter((l): l is string => typeof l === 'string') : [];

/** True for a bundle of REA Android (JADX) tool results. */
export function isAndroidBundle(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || !('inspect_android_package' in raw)) return false;
  const classes = (raw as Record<string, unknown>)['inspect_android_class'];
  return !!classes && typeof classes === 'object' && !Array.isArray(classes);
}

export const ANDROID_RULES = {
  bridge: 'android-webview-bridge',
  page: 'android-webview-page',
  url: 'android-url-literal',
  storage: 'android-storage-call',
  intent: 'android-intent-target',
  network: 'android-network-api',
} as const;

const STORAGE_CALLS: { pattern: RegExp; storageKind: string; call: string }[] = [
  { pattern: /\bopenOrCreateDatabase\(\s*"([^"\\]+)"/gu, storageKind: 'sqlite', call: 'openOrCreateDatabase' },
  { pattern: /\bgetDatabasePath\(\s*"([^"\\]+)"/gu, storageKind: 'sqlite', call: 'getDatabasePath' },
  { pattern: /\bdatabaseBuilder\([^;]*?,\s*"([^"\\]+)"\s*\)/gu, storageKind: 'sqlite', call: 'Room.databaseBuilder' },
  // SQLiteOpenHelper subclasses pass the database name to super(context, name, factory, version).
  { pattern: /\bsuper\(\s*\w+\s*,\s*"([^"\\]+\.db)"/gu, storageKind: 'sqlite', call: 'SQLiteOpenHelper' },
  { pattern: /\bgetSharedPreferences\(\s*"([^"\\]+)"/gu, storageKind: 'shared-preferences', call: 'getSharedPreferences' },
  { pattern: /\bopenFile(?:Output|Input)\(\s*"([^"\\]+)"/gu, storageKind: 'file', call: 'openFileOutput' },
];
const NETWORK_APIS: { pattern: RegExp; api: string }[] = [
  { pattern: /\.openConnection\(/u, api: 'java.net.URL.openConnection' },
  { pattern: /\.newCall\(/u, api: 'okhttp3.OkHttpClient.newCall' },
  { pattern: /\bnew Socket\(/u, api: 'java.net.Socket' },
];
const START_CALL = /\b(startService|startForegroundService|startActivity|startActivityForResult|sendBroadcast|bindService)\(/u;
const INTENT_TARGET = /\bnew Intent\([^;]*?\(Class<\?>\)\s*([\w.$]+)\.class\s*\)/gu;
const URL_LITERAL = /"((?:https?|wss?):\/\/[^"\\\s]+)"/gu;
const BRIDGE = /\.addJavascriptInterface\(\s*(?:new\s+([\w.$]+)\s*\([^()]*\)|[^,]+?)\s*,\s*"([^"\\]+)"\s*\)/gu;
const LOAD_URL = /\.loadUrl\(\s*"([^"\\]+)"/gu;
const SYNTHETIC_METHOD = /^(lambda\$|access\$|\$values$|\$\$)/u;

export function adaptAndroidBundle(raw: unknown, options: AdapterOptions): { project: StudioProject; report: AdapterReport } {
  const b = raw as Record<string, unknown>;
  const pkgEnv = b['inspect_android_package'] as Envelope | undefined;
  const pkg = (pkgEnv?.normalized_result ?? null) as PackageResult | null;
  const sha256 = pkgEnv?.subject?.digest?.sha256;
  if (!pkgEnv || !pkg || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(sha256)) {
    throw new ReaOutputError('Android analysis bundle has no package inspection with a digest');
  }
  const classEnvs = (b['inspect_android_class'] ?? {}) as Record<string, Envelope>;
  const methodEnvs = (b['inspect_android_method'] ?? {}) as Record<string, Envelope>;
  const referenceEnvs = (b['trace_android_references'] ?? {}) as Record<string, Envelope>;
  const collection = (b['studio_collection'] ?? {}) as { skipped_classes?: unknown; skipped_methods?: unknown };

  const packageName = typeof pkg.package_name === 'string' ? pkg.package_name : null;
  const versionName = typeof pkg.version_name === 'string' ? pkg.version_name : null;
  const fileName = (options.targetName ?? pkgEnv.subject?.name ?? 'app.apk').split(/[\\/]/u).pop() as string;
  const name = packageName ?? fileName;
  const manifestText = typeof pkg.manifest?.text === 'string' ? pkg.manifest.text : '';
  const id = (suffix: string) => `android:${sha256}:${suffix}`;

  const evidenceFrom = (env: Envelope | undefined, extractor: string, fallbackFile: string): Evidence => ({
    state: env?.confidence === 'observed' ? 'observed' : 'inferred',
    // REA reports JADX's results as observed in the shipped bytes, without a confidence grade.
    confidence: 'unknown',
    authority: env?.authority ?? 'shipped-artifact',
    extractor,
    location: { kind: 'artifact-path', file: env?.locations?.find((l) => typeof l.path === 'string')?.path ?? fallbackFile },
    limitations: limitationsOf(env),
  });
  const rea: Origin = { source: 'rea' };
  const manifestEvidence = evidenceFrom(pkgEnv, 'inspect_android_package', 'AndroidManifest.xml');

  const nodes: StudioNode[] = [];
  const edges: StudioEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const addNode = (n: StudioNode) => {
    if (nodeIds.has(n.id)) return false;
    nodeIds.add(n.id);
    nodes.push(n);
    return true;
  };
  const addEdge = (e: StudioEdge) => {
    if (e.source === e.target || edgeIds.has(e.id) || !nodeIds.has(e.source) || !nodeIds.has(e.target)) return false;
    edgeIds.add(e.id);
    edges.push(e);
    return true;
  };
  const contains = (source: string, target: string, evidence: Evidence) =>
    addEdge({ id: `${source}->${target}:contains`, source, target, relation: 'contains', evidence, origin: rea, details: {} });

  const report: AdapterReport = {
    reaNodes: 0, reaEdges: 0, droppedExportShapeNodes: 0, mergedExternalModuleNodes: 0, droppedEdgesToDroppedNodes: 0,
    droppedEdgesUnknownRelation: {}, droppedEdgesDanglingEndpoint: 0, foldedAsarEntries: 0, droppedSelfEdges: 0, unrecognizedNodeKinds: {}, heuristicEdges: {},
    endpointVerdicts: { plausible: 0, unlikely: 0 },
  };

  // The APK, its package and what the manifest declares.
  const root = id('apk');
  addNode({ id: root, kind: 'file', label: fileName, evidence: [manifestEvidence], origin: rea, path: '', fileKind: 'other', bytes: null,
    parseStatus: manifestText && pkg.manifest?.status === 'complete' ? 'complete' : 'partial', analysisIssue: null });
  const components = manifestComponents(manifestText, packageName ?? '');
  const launcher = components.find((c) => c.launcher)?.className ?? null;
  const packageId = id('package');
  addNode({
    id: packageId, kind: 'package', label: packageName ?? fileName, evidence: [manifestEvidence], origin: rea,
    name: packageName ?? fileName, version: versionName, path: 'AndroidManifest.xml', main: launcher,
  });
  contains(root, packageId, manifestEvidence);
  const permissions = Array.isArray(pkg.permissions) ? pkg.permissions.filter((p): p is string => typeof p === 'string') : [];
  for (const permission of permissions) {
    const nodeId = id(`permission:${permission}`);
    addNode({ id: nodeId, kind: 'android-permission', label: permission.replace(/^android\.permission\./u, ''), evidence: [manifestEvidence], origin: rea, name: permission });
    contains(packageId, nodeId, manifestEvidence);
  }
  const classNodeId = new Map<string, string>();
  for (const c of components) {
    const nodeId = id(`class:${c.className}`);
    const node: AndroidComponentNode = {
      id: nodeId, kind: 'android-component', label: c.className.split('.').pop() as string, evidence: [manifestEvidence], origin: rea,
      componentType: c.componentType, className: c.className, exported: c.exported, intentActions: c.intentActions, authorities: c.authorities, launcher: c.launcher,
    };
    if (addNode(node)) classNodeId.set(c.className, nodeId);
    contains(packageId, nodeId, manifestEvidence);
  }

  // The app's classes (a declared component is drawn as its component) and their methods.
  const classNames = Object.keys(classEnvs).sort();
  const outerOf = (className: string) => {
    for (let dot = className.lastIndexOf('.'); dot > 0; dot = className.lastIndexOf('.', dot - 1)) {
      const outer = className.slice(0, dot);
      if (outer in classEnvs) return outer;
    }
    return null;
  };
  for (const className of classNames) {
    if (classNodeId.has(className)) continue;
    const outer = outerOf(className);
    const namespace = (outer ? outer : className).slice(0, (outer ? outer : className).lastIndexOf('.'));
    const simple = className.slice(namespace.length + 1);
    const result = (classEnvs[className]?.normalized_result ?? {}) as ClassResult;
    const node: ManagedTypeNode = {
      id: id(`class:${className}`), kind: 'managed-type', label: simple, evidence: [evidenceFrom(classEnvs[className], 'inspect_android_class', 'classes.dex')], origin: rea,
      fullName: className, namespace, name: simple,
      compilerGenerated: /\$\$|\$\d|(^|\.)(R|BuildConfig)(\.|$)/u.test(simple),
      fields: (result.fields ?? []).map((f) => f.name).filter((f): f is string => typeof f === 'string'),
    };
    addNode(node);
    classNodeId.set(className, node.id);
  }
  for (const className of classNames) {
    const nodeId = classNodeId.get(className) as string;
    const outer = outerOf(className);
    contains(outer ? (classNodeId.get(outer) as string) : packageId, nodeId, evidenceFrom(classEnvs[className], 'inspect_android_class', 'classes.dex'));
  }
  const methodNodeId = new Map<string, string>();
  const methodsOf = new Map<string, ManagedMethodNode[]>();
  let skippedSynthetic = 0;
  for (const className of classNames) {
    const env = classEnvs[className];
    const result = (env?.normalized_result ?? {}) as ClassResult;
    const evidence = evidenceFrom(env, 'inspect_android_class', 'classes.dex');
    const simple = className.slice(className.lastIndexOf('.') + 1);
    for (const m of result.methods ?? []) {
      if (typeof m.name !== 'string') continue;
      const overload = typeof m.overload_index === 'number' ? m.overload_index : 0;
      const key = `${className}#${m.name}#${overload}`;
      const decompiled = (methodEnvs[key]?.normalized_result ?? null) as MethodResult | null;
      const body = typeof decompiled?.source?.text === 'string' ? decompiled.source.text : '';
      // A missing body is unknown, not proof of an empty initializer.
      const emptyInit = (m.name === '<init>' || m.name === '<clinit>') && decompiled?.body_status === 'available' && /\)\s*\{\s*\}\s*$/u.test(body.trim());
      if (emptyInit || SYNTHETIC_METHOD.test(m.name)) {
        skippedSynthetic++;
        continue;
      }
      const node: ManagedMethodNode = {
        id: id(`method:${key}`), kind: 'managed-method', label: `${simple}.${m.name}${overload > 0 ? `#${overload}` : ''}`, evidence: [evidence], origin: rea,
        declaringType: className, name: m.name, ilSize: null, pinvoke: false, entryPoint: className === launcher && m.name === 'onCreate',
      };
      addNode(node);
      methodNodeId.set(key, node.id);
      methodsOf.set(className, [...(methodsOf.get(className) ?? []), node]);
      contains(classNodeId.get(className) as string, node.id, evidence);
    }
  }

  // REA: which classes' code refers to each top-level class.
  const classIdFor = (raw: string) => {
    return classNodeId.get(raw);
  };
  for (const [target, env] of Object.entries(referenceEnvs)) {
    const targetId = classNodeId.get(target);
    const refs = ((env?.normalized_result ?? {}) as { references?: Reference[] }).references;
    if (!targetId || !Array.isArray(refs)) continue;
    const evidence = evidenceFrom(env, 'trace_android_references', 'classes.dex');
    for (const r of refs) {
      const from = r.kind === 'class' ? r.reported_full_name : (r.containing_class || r.top_class);
      const sourceId = typeof from === 'string' ? classIdFor(from) ?? (typeof r.top_class === 'string' ? classIdFor(r.top_class) : undefined) : undefined;
      if (!sourceId) {
        report.droppedEdgesDanglingEndpoint++;
        continue;
      }
      if (sourceId === targetId) {
        report.droppedSelfEdges++;
        continue;
      }
      if (addEdge({ id: `${sourceId}->${targetId}:references`, source: sourceId, target: targetId, relation: 'references', evidence, origin: rea, details: { mechanism: 'class reference' } })) report.reaEdges++;
    }
  }

  // Studio rules over REA's decompiled Java.
  const resolveClass = (simpleOrFull: string, fromClass: string) => {
    const candidates = [`${fromClass}.${simpleOrFull}`, `${fromClass.slice(0, fromClass.lastIndexOf('.'))}.${simpleOrFull}`, simpleOrFull];
    for (const c of candidates) if (classNodeId.has(c)) return c;
    const matches = [...classNodeId.keys()].filter((c) => c.endsWith(`.${simpleOrFull}`));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const heuristic = (rule: string, basis: string, env: Envelope | undefined, limitation: string) => ({
    origin: { source: 'studio-heuristic', heuristic: rule, basis } as Origin,
    evidence: { state: 'inferred', confidence: 'medium', authority: 'studio-heuristic', extractor: rule, location: evidenceFrom(env, rule, 'classes.dex').location, limitations: [...limitationsOf(env), limitation] } as Evidence,
  });
  const addHeuristicEdge = (rule: string, source: string, target: string, relation: StudioEdge['relation'], h: ReturnType<typeof heuristic>, mechanism: string) => {
    if (addEdge({ id: `heuristic:${rule}:${source}->${target}`, source, target, relation, evidence: h.evidence, origin: h.origin, details: { mechanism } })) {
      report.heuristicEdges[rule] = (report.heuristicEdges[rule] ?? 0) + 1;
    }
  };
  const FROM_CODE = 'Read from REA’s decompiled Java by a Studio pattern; not proven to run.';
  for (const [key, methodId] of methodNodeId) {
    const env = methodEnvs[key];
    const result = (env?.normalized_result ?? null) as MethodResult | null;
    if (result?.body_status !== 'available' || typeof result.source?.text !== 'string') continue;
    const code = result.source.text;
    const className = key.slice(0, key.indexOf('#'));

    for (const m of code.matchAll(BRIDGE)) {
      const apiKey = m[2] as string;
      const bridgeClass = m[1] ? resolveClass(m[1], className) : undefined;
      const members = bridgeClass ? (methodsOf.get(bridgeClass) ?? []).filter((x) => x.name !== '<init>') : [];
      const h = heuristic(ANDROID_RULES.bridge, `${key.split('#')[1]} calls addJavascriptInterface(…, "${apiKey}")`, env,
        'Members are the bridge class’s methods; Android exposes only those annotated @JavascriptInterface, which REA’s class inventory doesn’t show.');
      const bridgeId = id(`bridge:${apiKey}`);
      addNode({ id: bridgeId, kind: 'bridge-api', label: `window.${apiKey}`, evidence: [h.evidence], origin: h.origin, apiKey, world: 'android-webview', members: members.map((x) => x.name), unknownMemberCount: bridgeClass ? 0 : 1 });
      addHeuristicEdge(ANDROID_RULES.bridge, methodId, bridgeId, 'exposes', h, 'addJavascriptInterface');
      for (const member of members) addHeuristicEdge(ANDROID_RULES.bridge, bridgeId, member.id, 'calls', h, `window.${apiKey}.${member.name}`);
    }
    const loaded = new Set<string>();
    for (const m of code.matchAll(LOAD_URL)) {
      const url = m[1] as string;
      loaded.add(url);
      const h = heuristic(ANDROID_RULES.page, `WebView.loadUrl("${url}")`, env, FROM_CODE);
      const asset = /^file:\/\/\/android_asset\/(.+)$/u.exec(url);
      const targetId = asset ? id(`asset:${asset[1]}`) : id(`endpoint:${url}`);
      if (asset) addNode({ id: targetId, kind: 'file', label: `assets/${asset[1]}`, evidence: [h.evidence], origin: h.origin, path: `assets/${asset[1]}`, fileKind: /\.html?$/u.test(url) ? 'html' : 'other', bytes: null, parseStatus: null, analysisIssue: null });
      else addNode({ id: targetId, kind: 'endpoint', label: url, evidence: [h.evidence], origin: h.origin, endpointKind: 'network', value: url, mechanism: 'call:WebView.loadUrl' });
      addHeuristicEdge(ANDROID_RULES.page, methodId, targetId, 'loads', h, 'WebView.loadUrl');
    }
    for (const m of code.matchAll(URL_LITERAL)) {
      const url = m[1] as string;
      if (loaded.has(url)) continue;
      const h = heuristic(ANDROID_RULES.url, `URL string in ${key.split('#')[1]}`, env, FROM_CODE);
      const targetId = id(`endpoint:${url}`);
      addNode({ id: targetId, kind: 'endpoint', label: url, evidence: [h.evidence], origin: h.origin, endpointKind: 'network', value: url, mechanism: 'string-literal' });
      addHeuristicEdge(ANDROID_RULES.url, methodId, targetId, 'calls', h, 'string-literal');
    }
    for (const s of STORAGE_CALLS) {
      for (const m of code.matchAll(s.pattern)) {
        const storageName = m[1] as string;
        const h = heuristic(ANDROID_RULES.storage, `${s.call}("${storageName}")`, env, FROM_CODE);
        const targetId = id(`storage:${s.storageKind}:${storageName}`);
        addNode({ id: targetId, kind: 'storage', label: storageName, evidence: [h.evidence], origin: h.origin, storageKind: s.storageKind, name: storageName, mechanism: `call:${s.call}` });
        addHeuristicEdge(ANDROID_RULES.storage, methodId, targetId, 'persists_to', h, s.call);
      }
    }
    const start = START_CALL.exec(code)?.[1];
    if (start) {
      for (const m of code.matchAll(INTENT_TARGET)) {
        const target = resolveClass(m[1] as string, className);
        if (!target) continue;
        const h = heuristic(ANDROID_RULES.intent, `${start} and new Intent(…, ${m[1]}.class) appear in the same method`, env,
          `${FROM_CODE} The Intent's connection to the start call's arguments is not resolved.`);
        addHeuristicEdge(ANDROID_RULES.intent, methodId, classNodeId.get(target) as string, 'invokes', h, start);
      }
    }
    for (const n of NETWORK_APIS) {
      if (!n.pattern.test(code)) continue;
      // `new URL(ENDPOINT)`: the address is in a constant the method-level decompile doesn't show; name it at least.
      const urlExpression = /\bnew URL\(\s*([A-Za-z_$][\w.$]*)\s*\)/u.exec(code)?.[1];
      const mechanism = urlExpression ? `new URL(${urlExpression})` : n.api;
      const h = heuristic(ANDROID_RULES.network, `calls ${n.api}`, env, FROM_CODE);
      const targetId = id(`api:${n.api}`);
      addNode({ id: targetId, kind: 'external-member', label: n.api, evidence: [h.evidence], origin: h.origin, name: n.api, parameterTypes: [], returnType: null });
      addHeuristicEdge(ANDROID_RULES.network, methodId, targetId, 'calls', h, mechanism);
    }
  }

  report.reaNodes = nodes.filter((n) => n.origin.source === 'rea').length;
  report.endpointVerdicts = assessEndpoints(nodes);
  const skippedClasses = typeof collection.skipped_classes === 'number' ? collection.skipped_classes : 0;
  const skippedMethods = typeof collection.skipped_methods === 'number' ? collection.skipped_methods : 0;
  const undecompiled = [...methodNodeId.keys()].filter((k) => (methodEnvs[k]?.normalized_result as MethodResult | null)?.body_status !== 'available').length;
  const searchEnv = b['search_android_classes'] as Envelope | undefined;
  // JADX shows classes a minifier moved into the unnamed package as `defpackage.<short name>`.
  const allClasses = (searchEnv?.normalized_result as { matches?: unknown } | null)?.matches;
  // Generated resource classes (`R`, `BuildConfig`) can land there without any minifier.
  const minifiedClasses = Array.isArray(allClasses)
    ? allClasses.filter((c) => typeof c === 'string' && c.startsWith('defpackage.') && !/^defpackage\.(R|BuildConfig)(\$|$)/u.test(c)).length : 0;
  const queryCoverage = [searchEnv, ...Object.values(referenceEnvs)].map((e) => (e?.normalized_result as { coverage?: unknown } | null)?.coverage);
  const missingClasses = Object.values(classEnvs).filter((e) => !e?.normalized_result).length;
  const missingManifest = !manifestText || pkg.manifest?.status !== 'complete';
  const incompleteQueries = queryCoverage.some((c) => c !== 'complete') || !searchEnv || missingClasses > 0 || report.droppedEdgesDanglingEndpoint > 0;
  const capped = skippedClasses > 0 || skippedMethods > 0;
  const coverage = capped || undecompiled > 0 || missingManifest || incompleteQueries ? 'partial' : 'complete';
  const of = <K extends StudioNode['kind']>(kind: K) => nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === kind);
  const finding = (category: FindingCoverage['category'], count: number, notes: string[], unresolvedCount = 0): FindingCoverage => ({
    category, status: count > 0 ? 'found' : 'not-found', count, unresolvedCount, coverage,
    notes: count > 0 ? notes : ['None found. REA static analysis never proves absence, so there may still be some.', ...notes],
  });
  const heuristicNote = 'Read from REA’s decompiled Java by Studio patterns (labeled as heuristic)';
  const exported = of('android-component').filter((c) => c.exported);
  const limitations = [...new Set([pkgEnv, searchEnv, ...Object.values(classEnvs), ...Object.values(methodEnvs), ...Object.values(referenceEnvs)].flatMap(limitationsOf))];
  limitations.push(
    'Bridges, loaded pages, URLs, storage names, Intent targets and network APIs are read from REA’s decompiled Java with Studio patterns.',
    'Values held in constants (static final fields) aren’t visible in method-level decompilation, so URLs and names stored that way are missed.',
  );
  if (skippedClasses || skippedMethods) limitations.push(`Not analyzed to stay within limits: ${skippedClasses} classes and ${skippedMethods} methods.`);
  if (undecompiled) limitations.push(`${undecompiled} listed methods have no available decompiled body; their behavior is unknown, including any constructors or static initializers.`);
  if (missingManifest) limitations.push('The decoded manifest is missing or incomplete; component declarations may be missing.');
  if (incompleteQueries) limitations.push('Some class or reference queries are missing, incomplete or unresolved.');
  if (manifestText.includes('<activity-alias')) limitations.push('Activity aliases are grouped with their target for launcher/actions; the exported flag describes the target activity only. Alias access rules may differ.');
  limitations.push('Entry-point and compiler-style name flags are Studio heuristics over the manifest and symbol names.');

  const project: StudioProject = {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: sha256,
    target: { name, version: versionName, sha256, format: 'apk', appKind: 'android' },
    analysis: {
      engine: { package: 'rea-agents', version: options.reaVersion, operation: 'inspect_android_package' },
      reaEvidenceId: pkgEnv.evidence_id ?? '',
      coverage: { status: coverage, truncated: capped, limits: [] },
      limitations,
      statistics: { relevantFiles: classNames.length, parsedJavascriptFiles: 0, parseFailures: undecompiled, findings: nodes.length },
      filesWithAnalysisIssues: 0,
      omitted: [],
    },
    findings: [
      finding('components', of('android-component').length, [`${exported.length} declared exported (access can also depend on permissions)`, ...(launcher ? [`Launcher: ${launcher.split('.').pop()}`] : [])]),
      finding('permissions', of('android-permission').length, typeof pkg.target_sdk === 'string' ? [`minSdk ${String(pkg.min_sdk)}, targetSdk ${pkg.target_sdk}`] : []),
      finding('bridge-apis', of('bridge-api').length, [heuristicNote]),
      finding('endpoints', of('endpoint').length, [heuristicNote]),
      finding('storage', of('storage').length, [heuristicNote]),
      finding('types', of('managed-type').length, [
        `${classNames.length} app classes inspected (components are listed as components); bundled libraries left out`,
        ...(minifiedClasses > 0 ? [`${minifiedClasses} more classes were renamed into the default package by a minifier (R8/ProGuard) and left out; their names say nothing about the app`] : []),
      ]),
      finding('methods', of('managed-method').length, [...(undecompiled ? [`${undecompiled} without a decompiled body; reason unknown`] : []), ...(skippedSynthetic ? [`${skippedSynthetic} proven empty initializers or compiler-style method names left out (Studio heuristic)`] : [])]),
    ],
    ipcSummary: {
      operations: 0, literalChannels: 0, dynamicChannelOperations: 0, rendererTransmissions: 0, rendererListeners: 0,
      mainHandlers: 0, pairedRendererTransmissions: 0, ambiguousRendererTransmissions: 0, unpairedLiteralRendererTransmissions: 0,
    },
    nodes,
    edges,
  };
  return { project, report };
}
