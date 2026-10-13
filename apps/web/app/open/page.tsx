import type { Metadata } from 'next';
import { OpenProject } from '../../components/OpenProject';

export const metadata: Metadata = { title: 'Open a project · REA for Web' };

export default function OpenPage() {
  return <OpenProject />;
}
