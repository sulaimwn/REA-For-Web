// Reads the decoded AndroidManifest.xml that REA's JADX provider returns (`inspect_android_package`
// → `manifest.text`). The manifest is JADX's decoding of the APK's binary XML; this only lists the
// declared components. Element and attribute names are fixed by Android, so a small reader suffices.

export type AndroidComponentType = 'activity' | 'service' | 'receiver' | 'provider';

export interface ManifestComponent {
  componentType: AndroidComponentType;
  /** Fully qualified class name (relative `.Name` entries resolved against the package). */
  className: string;
  /** `android:exported`; null when the manifest doesn't say. */
  exported: boolean | null;
  intentActions: string[];
  /** Content provider authorities. */
  authorities: string | null;
  /** Declares MAIN + LAUNCHER: the app's home-screen entry. */
  launcher: boolean;
}

const ELEMENT = /<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/gu;
const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`\\bandroid:${name}\\s*=\\s*"([^"]*)"`, 'u').exec(attrs);
  return m ? (m[1] as string).replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>') : null;
};

export function manifestComponents(manifestText: string, packageName: string): ManifestComponent[] {
  const components: ManifestComponent[] = [];
  for (const m of manifestText.matchAll(ELEMENT)) {
    const tag = m[1] as string;
    const attrs = m[2] as string;
    const body = m[4] ?? '';
    const rawName = attr(attrs, tag === 'activity-alias' ? 'targetActivity' : 'name');
    if (!rawName) continue;
    const className = rawName.startsWith('.') ? `${packageName}${rawName}` : rawName.includes('.') ? rawName : `${packageName}.${rawName}`;
    const exported = attr(attrs, 'exported');
    const intentActions = [...body.matchAll(/<action\b[^>]*\bandroid:name\s*=\s*"([^"]+)"/gu)].map((a) => a[1] as string);
    const categories = [...body.matchAll(/<category\b[^>]*\bandroid:name\s*=\s*"([^"]+)"/gu)].map((a) => a[1] as string);
    components.push({
      componentType: tag === 'activity-alias' ? 'activity' : (tag as AndroidComponentType),
      className,
      exported: exported === null ? null : exported === 'true',
      intentActions,
      authorities: attr(attrs, 'authorities'),
      launcher: intentActions.includes('android.intent.action.MAIN') && categories.includes('android.intent.category.LAUNCHER'),
    });
  }
  return components;
}

interface PackageResult {
  package_name?: unknown;
  manifest?: { text?: unknown };
}

/**
 * Which classes belong to the app (rather than bundled libraries): those in the package's namespace
 * or in the package of a declared component.
 */
export function androidAppClassFilter(inspectAndroidPackage: unknown): (className: string) => boolean {
  const result = (inspectAndroidPackage as { normalized_result?: PackageResult } | null)?.normalized_result;
  const packageName = typeof result?.package_name === 'string' ? result.package_name : '';
  const text = typeof result?.manifest?.text === 'string' ? result.manifest.text : '';
  const prefixes = new Set<string>(packageName ? [`${packageName}.`] : []);
  for (const c of manifestComponents(text, packageName)) {
    const dot = c.className.lastIndexOf('.');
    if (dot > 0) prefixes.add(c.className.slice(0, dot + 1));
  }
  return (className) => [...prefixes].some((p) => className.startsWith(p));
}
