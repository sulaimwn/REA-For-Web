'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DemoEntry } from '../lib/project';
import { Explorer } from './Explorer';

/** The landing page's live explorer: the real thing, switchable between demos. */
export function LandingDemo({ demos }: { demos: DemoEntry[] }) {
  const [slug, setSlug] = useState(demos[0]?.slug);
  const demo = demos.find((d) => d.slug === slug) ?? demos[0];
  if (!demo) return null;
  return (
    <>
      <section className="specimen" aria-label="Live explorer">
        <div className="specimen__bar">
          <div className="tabs" role="tablist" aria-label="Demo app">
            {demos.map((d) => (
              <button key={d.slug} type="button" role="tab" aria-selected={d.slug === demo.slug} className={`tab ${d.slug === demo.slug ? 'tab--on' : ''}`} onClick={() => setSlug(d.slug)}>
                {d.title}
              </button>
            ))}
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
