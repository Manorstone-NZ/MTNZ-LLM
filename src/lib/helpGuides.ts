export interface HelpGuideDefinition {
  id: string;
  title: string;
  description: string;
  relativeDocPath: string;
}

const GUIDE_DEFINITIONS: ReadonlyArray<HelpGuideDefinition> = [
  {
    id: 'overview',
    title: 'Help Overview',
    description: 'Entry point and quick navigation for all help content.',
    relativeDocPath: 'docs/guides/README.md',
  },
  {
    id: 'adding-documents',
    title: 'Adding Documents',
    description: 'Operator guide for uploading and processing documents.',
    relativeDocPath: 'docs/guides/adding-documents.md',
  },
  {
    id: 'pipeline-internals',
    title: 'Ingestion Pipeline Internals',
    description: 'Developer reference for ingestion rules and processing stages.',
    relativeDocPath: 'docs/guides/ingestion-pipeline-internals.md',
  },
  {
    id: 'upload-implementation',
    title: 'Upload Implementation',
    description: 'Feature-level technical notes for upload architecture and behavior.',
    relativeDocPath: 'docs/guides/document-upload-implementation.md',
  },
];

export function listHelpGuides(): ReadonlyArray<HelpGuideDefinition> {
  return GUIDE_DEFINITIONS;
}

export function resolveHelpGuideById(id?: string): HelpGuideDefinition {
  if (!id) return GUIDE_DEFINITIONS[0];
  return GUIDE_DEFINITIONS.find((guide) => guide.id === id) ?? GUIDE_DEFINITIONS[0];
}

export function findHelpGuideByDocPath(docPath: string): HelpGuideDefinition | undefined {
  return GUIDE_DEFINITIONS.find((guide) => guide.relativeDocPath === docPath);
}
