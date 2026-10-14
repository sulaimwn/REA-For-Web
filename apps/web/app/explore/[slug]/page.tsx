import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Explorer } from '../../../components/Explorer';
import { loadDemos } from '../../../lib/demos';
import { SITE_NAME, shareMetadata } from '../../../lib/site';

type Params = { slug: string };

// Only the demos known at build time exist; unknown slugs 404 without rendering on the server.
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return loadDemos().map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const demo = loadDemos().find((d) => d.slug === slug);
  const title = demo ? `${demo.title} · ${SITE_NAME}` : SITE_NAME;
  return { title, ...shareMetadata(title) };
}

export default async function ExplorePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const demo = loadDemos().find((d) => d.slug === slug);
  if (!demo) notFound();
  return <Explorer key={demo.slug} demo={demo} />;
}
