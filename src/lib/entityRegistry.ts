import type { ScoredChunk } from './types';

export interface RegistrySystem {
  canonical: string;
  aliases: string[];
  broad?: boolean;
}

const REGISTRY_SYSTEMS: RegistrySystem[] = [
  { canonical: 'MADCAP', aliases: ['madcap'] },
  { canonical: 'TITAN', aliases: ['titan'] },
  { canonical: 'ODS', aliases: ['ods'] },
  { canonical: 'SAP B1', aliases: ['sap b1', 'sap business one'] },
  { canonical: 'SAP', aliases: ['sap'] },
  { canonical: 'WSO2', aliases: ['wso2'] },
  { canonical: 'Qlik', aliases: ['qlik'] },
  { canonical: 'CombiFoss', aliases: ['combifoss'] },
  { canonical: 'BactoScan', aliases: ['bactoscan'] },
  { canonical: 'Sorter', aliases: ['sorter', 'sorting robot'] },
  { canonical: 'Analyser', aliases: ['analyser', 'analyzer', 'instrument'] },
  { canonical: 'Reporting', aliases: ['reporting', 'report', 'export'], broad: true },
  { canonical: 'Billing', aliases: ['billing', 'invoice', 'invoicing'], broad: true },
  { canonical: 'Analytics', aliases: ['analytics', 'data platform', 'warehouse', 'bi'], broad: true },
];

const CANONICAL_SOURCE_PATTERNS: Array<{ pattern: RegExp; boost: number }> = [
  { pattern: /madcap test type list/i, boost: 1.16 },
  { pattern: /manual directory/i, boost: 1.1 },
  { pattern: /result release manual/i, boost: 1.12 },
  { pattern: /reference|register|mapping|matrix|appendix/i, boost: 1.08 },
  { pattern: /titan .*manual|titan manual/i, boost: 1.08 },
];

const MASTER_CANDIDATE_TERMS = [
  'master list',
  'register',
  'reference table',
  'mapping matrix',
  'code list',
];

export function getRegistrySystems(): RegistrySystem[] {
  return REGISTRY_SYSTEMS;
}

export function extractRegistrySystemMentions(input: string): string[] {
  const lower = input.toLowerCase();
  const found: Array<{ canonical: string; index: number }> = [];

  for (const system of REGISTRY_SYSTEMS) {
    for (const alias of system.aliases) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`\\b${escapedAlias}\\b`, 'i').exec(lower);
      const index = match?.index ?? -1;
      if (index >= 0) {
        found.push({ canonical: system.canonical, index });
        break;
      }
    }
  }

  found.sort((a, b) => a.index - b.index);

  const broadCanonical = new Set(REGISTRY_SYSTEMS.filter((s) => s.broad).map((s) => s.canonical));
  const unique: string[] = [];
  for (const hit of found) {
    if (!unique.includes(hit.canonical)) unique.push(hit.canonical);
  }

  const hasSapB1 = unique.includes('SAP B1');
  const normalized = unique.filter((item) => !(hasSapB1 && item === 'SAP'));
  const specific = normalized.filter((item) => !broadCanonical.has(item));
  if (specific.length >= 2) {
    return specific;
  }
  return normalized;
}

export function buildRegistryQueryExpansion(input: string): string {
  const systems = extractRegistrySystemMentions(input);
  const aliasesForMentioned = REGISTRY_SYSTEMS
    .filter((system) => systems.includes(system.canonical))
    .flatMap((system) => system.aliases)
    .slice(0, 8)
    .join(' ');

  const lower = input.toLowerCase();
  const domainHints: string[] = [];

  if (/\bit\/?ot\b|integration|interface|middleware|api/.test(lower)) {
    domainHints.push('integration flow interface middleware api web service file exchange');
  }
  if (/report|export/.test(lower)) {
    domainHints.push('reporting export transmission release output format');
  }
  if (/bill|invoice|sap/.test(lower)) {
    domainHints.push('billing invoice downstream sap finance result release');
  }
  if (/analytics|data platform|warehouse|qlik|ods/.test(lower)) {
    domainHints.push('analytics data platform ods qlik warehouse downstream');
  }

  const registryHints = [...MASTER_CANDIDATE_TERMS, aliasesForMentioned, ...domainHints]
    .filter((item) => item.trim().length > 0)
    .join(' ')
    .trim();

  return registryHints.length > 0 ? `${input} ${registryHints}`.trim() : input;
}

export function extractRegistryInteractionPair(input: string): { systemA: string; systemB: string } | undefined {
  const systems = extractRegistrySystemMentions(input);
  if (systems.length >= 2) {
    return { systemA: systems[0], systemB: systems[1] };
  }
  return undefined;
}

export function getRegistrySourceBoost(question: string, chunk: Pick<ScoredChunk, 'doc_title' | 'source_type'>): number {
  const qLower = question.toLowerCase();
  const title = chunk.doc_title ?? '';

  let boost = 1.0;
  for (const entry of CANONICAL_SOURCE_PATTERNS) {
    if (entry.pattern.test(title)) {
      boost = Math.max(boost, entry.boost);
    }
  }

  if (/canonical|master|register|mapping|code|list|lookup/.test(qLower) && chunk.source_type === 'xlsx') {
    boost = Math.max(boost, 1.14);
  }

  if (/interaction|integrat|flow|interface|report|export|billing|analytics/.test(qLower) && /manual|procedure/i.test(title)) {
    boost = Math.max(boost, 1.06);
  }

  return boost;
}
