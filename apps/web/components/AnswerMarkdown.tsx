'use client';

// Renders an Ask answer: paragraphs, lists, **bold**, `code`, and [text](node:id) links.
// Builds React elements (no HTML injection). Only node: links are clickable; other
// links render as their text, since answers come from a model.
import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, onNode: (id: string) => void, known: (id: string) => boolean): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      const id = href?.startsWith('node:') ? href.slice(5) : null;
      if (id && known(id)) {
        return (
          <button key={i} type="button" className="link answer__node" onClick={() => onNode(id)}>
            {label}
          </button>
        );
      }
      return <span key={i}>{label}</span>;
    }
    return part;
  });
}

export function AnswerMarkdown({ text, onNode, known }: { text: string; onNode: (id: string) => void; known: (id: string) => boolean }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item, onNode, known)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? '');
      continue;
    }
    flush();
    if (line.trim() === '') continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(heading ? <h5 key={blocks.length}>{inline(heading[1] ?? '', onNode, known)}</h5> : <p key={blocks.length}>{inline(line, onNode, known)}</p>);
  }
  flush();
  return <div className="answer">{blocks}</div>;
}
