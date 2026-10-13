'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DemoEntry } from '../lib/project';
import { Explorer } from './Explorer';

/** Hand-written samples (`tiny-*`) have answer keys; the rest are real apps. */
const GROUPS: { label: string; test: (d: DemoEntry) => boolean }[] = [
  { label: 'Samples with known answers', test: (d) => d.slug.startsWith('tiny-') },
  { label: 'Real apps', test: (d) => !d.slug.startsWith('tiny-') },
];

/** The landing page's live explorer: the real thing, switchable between demos. */
export function LandingDemo({ demos }: { demos: DemoEntry[] }) {
  const [slug, setSlug] = useState(demos[0]?.slug);
  const demo = demos.find((d) => d.slug === slug) ?? demos[0];
  if (!demo) return null;
  return (
    <>
      <section className="specimen" aria-label="Live explorer">
        <div className="specimen__bar">
          <div className="specimen__groups">
            {GROUPS.map((g) => {
              const members = demos.filter(g.test);
              if (members.length === 0) return null;
              return (
                <div key={g.label} className="specimen__group">
                  <span className="specimen__group-label">{g.label}</span>
                  <div className="tabs" role="tablist" aria-label={g.label}>
                    {members.map((d) => (
                      <button key={d.slug} type="button" role="tab" aria-selected={d.slug === demo.slug} className={`tab ${d.slug === demo.slug ? 'tab--on' : ''}`} onClick={() => setSlug(d.slug)}>
                        {d.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <Link className="specimen__open" href={`/explore/${demo.slug}`}>
            Open full screen
          </Link>
        </div>
        <div className="specimen__frame">
          <Explorer key={demo.slug} demo={demo} embedded />
        </div>
      </section>
      <p className="specimen__caption">
        This is the explorer itself, running on REA’s output for {demo.title}. Click a part to see its evidence; double-click to
        see what it connects to.
      </p>
    </>
  );
}
