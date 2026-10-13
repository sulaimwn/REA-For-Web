import type { StudioNodeKind } from '@rea-studio/schema';
import { KIND_META, type KindFamily } from '../lib/project';

/** The shape-and-color mark for a node kind (see KindFamily). Decorative: the kind is always also written out. */
export function KindGlyph({ kind, family }: { kind?: StudioNodeKind; family?: KindFamily }) {
  const f = family ?? (kind ? KIND_META[kind].family : 'code');
  return <span className={`glyph glyph--${f}`} aria-hidden="true" />;
}
