import { readFile } from 'fs/promises';
import { join } from 'path';
import HelpViewer from '@/components/help/HelpViewer';
import { listHelpGuides, resolveHelpGuideById } from '@/lib/helpGuides';

interface HelpPageProps {
  searchParams?: Promise<{ guide?: string }>;
}

export default async function HelpPage({ searchParams }: HelpPageProps) {
  const params = (await searchParams) ?? {};
  const guides = listHelpGuides();
  const selectedGuide = resolveHelpGuideById(params.guide);

  const absolutePath = join(process.cwd(), selectedGuide.relativeDocPath);
  const content = await readFile(absolutePath, 'utf8');

  return (
    <HelpViewer
      guides={guides}
      selectedGuideId={selectedGuide.id}
      content={content}
    />
  );
}
