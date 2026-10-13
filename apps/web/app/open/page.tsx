import type { Metadata } from 'next';
import { OpenProject } from '../../components/OpenProject';

export const metadata: Metadata = { title: 'Open a project · REA Studio' };

export default function OpenPage() {
  return <OpenProject />;
}
