// Android apps (T021): the tiny-android fixture (REA + JADX) against its answer key
// (fixtures/sample-apps/tiny-android/ANSWER-KEY.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ANDROID_FINDING_CATEGORIES, NODE_KINDS, RELATIONS, type StudioNode } from '@rea-studio/schema';
import { ANDROID_RULES, adaptReaResult, androidAppClassFilter, isAndroidBundle, manifestComponents } from '../src/index.js';

const samples = new URL('../../../../fixtures/samples/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('tiny-android.rea-6.4.0.json', samples), 'utf8')) as Record<string, unknown>;
const { project, report } = adaptReaResult(raw, { reaVersion: '6.4.0', targetName: 'tiny-notes.apk' });
const byId = new Map(project.nodes.map((n) => [n.id, n]));
const of = <K extends StudioNode['kind']>(k: K) => project.nodes.filter((n): n is Extract<StudioNode, { kind: K }> => n.kind === k);
const links = (relation: string) => project.edges
  .filter((e) => e.relation === relation)
  .map((e) => `${byId.get(e.source)?.label} -> ${byId.get(e.target)?.label}${e.origin.source === 'rea' ? '' : ` [${e.origin.heuristic}]`}`)
  .sort();

describe('Android app (REA + JADX) adapter', () => {
  it('reads the package from the manifest', () => {
    assert.equal(isAndroidBundle(raw), true);
    assert.deepEqual(project.target, { name: 'com.reaforweb.tinynotes', version: '1.2.3', sha256: project.id, format: 'apk', appKind: 'android' });
    assert.deepEqual(project.findings.map((f) => f.category), [...ANDROID_FINDING_CATEGORIES]);
    assert.equal(project.analysis.coverage.status, 'complete');
    const pkg = of('package')[0];
    assert.equal(pkg?.main, 'com.reaforweb.tinynotes.MainActivity');
    assert.deepEqual(of('android-permission').map((p) => p.name).sort(), ['android.permission.INTERNET', 'android.permission.RECEIVE_BOOT_COMPLETED']);
  });

  it('lists the four components with exported flags, intents and the launcher', () => {
    const components = Object.fromEntries(of('android-component').map((c) => [c.label, [c.componentType, c.exported, c.launcher, c.intentActions, c.authorities]]));
    assert.deepEqual(components, {
      MainActivity: ['activity', true, true, ['android.intent.action.MAIN'], null],
      SyncService: ['service', false, false, [], null],
      BootReceiver: ['receiver', true, false, ['android.intent.action.BOOT_COMPLETED'], null],
      NotesProvider: ['provider', false, false, [], 'com.reaforweb.tinynotes.notes'],
    });
  });

  it('finds the WebView bridge with its members, and the page it loads', () => {
    const [bridge] = of('bridge-api');
    assert.equal(bridge?.apiKey, 'notesBridge');
    assert.deepEqual(bridge?.members.sort(), ['save', 'version']);
    assert.equal(bridge?.origin.source, 'studio-heuristic');
    assert.deepEqual(links('exposes'), ['MainActivity.onCreate -> window.notesBridge [android-webview-bridge]']);
    assert.deepEqual(links('loads'), ['MainActivity.onCreate -> assets/index.html [android-webview-page]']);
  });

  it('links classes from REA references, and Intents, storage and network from the decompiled code', () => {
    assert.deepEqual(links('references'), [
      'BootReceiver -> SyncService',
      'MainActivity -> NotesProvider',
      'MainActivity -> SyncService',
      'MainActivity.NotesBridge -> MainActivity',
      'MainActivity.NotesBridge -> NotesProvider',
    ]);
    assert.deepEqual(links('invokes'), [
      'BootReceiver.onReceive -> SyncService [android-intent-target]',
      'MainActivity.onCreate -> SyncService [android-intent-target]',
    ]);
    assert.deepEqual(links('persists_to'), ['NotesProvider.onCreate -> notes.db [android-storage-call]']);
    assert.deepEqual(of('storage').map((s) => [s.storageKind, s.name, s.mechanism]), [['sqlite', 'notes.db', 'call:openOrCreateDatabase']]);
    const network = project.edges.find((e) => e.origin.source === 'studio-heuristic' && e.origin.heuristic === ANDROID_RULES.network);
    assert.equal(byId.get(network?.source ?? '')?.label, 'SyncService.push');
    assert.equal(network?.details.mechanism, 'new URL(ENDPOINT)');
    // The sync URL lives in a static final field, which method-level decompilation doesn't show (answer key).
    assert.equal(of('endpoint').length, 0);
  });

  it('keeps every heuristic labeled and inferred, and REA facts as REA', () => {
    for (const e of project.edges) {
      if (e.origin.source === 'studio-heuristic') assert.equal(e.evidence.state, 'inferred', e.id);
      assert.ok((RELATIONS as readonly string[]).includes(e.relation));
      assert.ok(byId.has(e.source) && byId.has(e.target), e.id);
    }
    for (const n of project.nodes) assert.ok((NODE_KINDS as readonly string[]).includes(n.kind), n.kind);
    assert.equal(new Set(project.edges.map((e) => e.id)).size, project.edges.length);
    assert.deepEqual(report.heuristicEdges, {
      [ANDROID_RULES.intent]: 2, [ANDROID_RULES.bridge]: 3, [ANDROID_RULES.page]: 1, [ANDROID_RULES.storage]: 1, [ANDROID_RULES.network]: 1,
    });
  });
});

describe('Android manifest reader', () => {
  const manifest = `<manifest package="com.example.app"><application>
    <activity android:name=".Main" android:exported="true"><intent-filter>
      <action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter></activity>
    <activity-alias android:name=".Alias" android:targetActivity="com.example.app.Main"><intent-filter>
      <action android:name="android.intent.action.SEND"/>
    </intent-filter></activity-alias>
    <service android:name="Worker"/>
    <receiver android:name="com.other.lib.Push" android:exported="false"/>
  </application></manifest>`;

  it('resolves relative names and reads exported flags and launchers', () => {
    assert.deepEqual(manifestComponents(manifest, 'com.example.app').map((c) => [c.componentType, c.className, c.exported, c.launcher, c.intentActions]), [
      ['activity', 'com.example.app.Main', true, true, ['android.intent.action.MAIN', 'android.intent.action.SEND']],
      ['service', 'com.example.app.Worker', null, false, []],
      ['receiver', 'com.other.lib.Push', false, false, []],
    ]);
  });

  it('counts classes in the package or a component’s package as the app’s own', () => {
    const isApp = androidAppClassFilter({ normalized_result: { package_name: 'com.example.app', manifest: { text: manifest } } });
    assert.equal(isApp('com.example.app.Main'), true);
    assert.equal(isApp('com.other.lib.Push'), true);
    assert.equal(isApp('androidx.core.app.ActivityCompat'), false);
  });
});
