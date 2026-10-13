// Android apps (T021): collects the bundle `adaptAndroidBundle` reads, from REA's JADX provider in one
// REA MCP session (each plain CLI command restarts JADX, ~9 s each). Node-only. The APK is never run.
//
// For the app's own classes (not bundled libraries): each class's members, every method decompiled
// (capped), and incoming references to each top-level class.
import { androidAppClassFilter } from './android-manifest.js';
import { openReaSession, type ReaSessionOptions } from './rea-session.js';

export interface AndroidSessionOptions extends ReaSessionOptions {
  apk: string;
  onProgress?: (message: string) => void;
  /** Most methods to decompile; the rest are reported as not analyzed. */
  maxMethods?: number;
  /** Most classes to inspect and trace. */
  maxClasses?: number;
}

/** REA's JADX provider needs the jadx-headless-mcp JAR (and a JDK). */
export function jadxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['REA_JADX_MCP_JAR']);
}

interface ClassResult {
  normalized_result?: { methods?: { name?: unknown; overload_index?: unknown }[]; inner_classes?: unknown[] };
}

export async function collectAndroidBundle(options: AndroidSessionOptions): Promise<Record<string, unknown>> {
  const { onProgress = () => {}, maxMethods = 1500, maxClasses = 500 } = options;
  const path = options.apk;
  const session = await openReaSession(options);
  try {
    onProgress('JADX is decompiling the APK');
    const pkg = await session.call('inspect_android_package', { path });
    const search = (await session.call('search_android_classes', { path, query: '' })) as { normalized_result?: { matches?: unknown[] } };
    const isApp = androidAppClassFilter(pkg);
    const topLevel = (search.normalized_result?.matches ?? []).filter((c): c is string => typeof c === 'string' && isApp(c));
    const classes: Record<string, unknown> = {};
    const queue = [...topLevel];
    let skippedClasses = 0;
    while (queue.length) {
      const name = queue.shift() as string;
      if (name in classes) continue;
      if (Object.keys(classes).length >= maxClasses) {
        skippedClasses++;
        continue;
      }
      const result = (await session.call('inspect_android_class', { path, class_name: name })) as ClassResult;
      classes[name] = result;
      for (const inner of result.normalized_result?.inner_classes ?? []) if (typeof inner === 'string') queue.push(inner);
    }
    onProgress(`decompiling methods of ${Object.keys(classes).length} classes`);
    const methods: Record<string, unknown> = {};
    let skippedMethods = 0;
    for (const [className, result] of Object.entries(classes)) {
      for (const m of (result as ClassResult).normalized_result?.methods ?? []) {
        if (typeof m.name !== 'string') continue;
        const overload = typeof m.overload_index === 'number' ? m.overload_index : 0;
        if (Object.keys(methods).length >= maxMethods) {
          skippedMethods++;
          continue;
        }
        methods[`${className}#${m.name}#${overload}`] = await session.call('inspect_android_method', { path, class_name: className, method_name: m.name, overload_index: overload });
      }
    }
    onProgress('tracing references between classes');
    const references: Record<string, unknown> = {};
    for (const className of topLevel) {
      if (className in classes) references[className] = await session.call('trace_android_references', { path, class_name: className });
    }
    return {
      inspect_android_package: pkg,
      search_android_classes: search,
      inspect_android_class: classes,
      inspect_android_method: methods,
      trace_android_references: references,
      // What the collector chose not to ask REA (not REA output).
      studio_collection: { max_classes: maxClasses, skipped_classes: skippedClasses, max_methods: maxMethods, skipped_methods: skippedMethods },
    };
  } finally {
    await session.close();
  }
}
