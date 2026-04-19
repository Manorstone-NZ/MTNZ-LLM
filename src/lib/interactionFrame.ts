import type { CitedChunk } from './types';

export interface InteractionOperatingFrame {
  sourceOfTruth: string[];
  decisionEngine: string[];
  executionLayer: string[];
  integrationMechanism: string[];
  triggerEvents: string[];
  dataObjects: string[];
  failurePoints: string[];
  fallbackPaths: string[];
}

function uniqueTop(values: string[], limit = 4): string[] {
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (deduped.includes(trimmed)) continue;
    deduped.push(trimmed);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function collectMatches(corpus: string, regex: RegExp): string[] {
  const out: string[] = [];
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const source = new RegExp(regex.source, flags);
  for (const match of corpus.matchAll(source)) {
    if (match[0]) out.push(match[0]);
  }
  return out;
}

export function buildInteractionOperatingFrame(
  chunks: Array<CitedChunk & { content: string }>,
): InteractionOperatingFrame {
  const corpus = chunks
    .map((chunk) => `${chunk.section_title ?? ''}\n${chunk.content_preview}\n${chunk.content}`)
    .join('\n\n');

  const sourceOfTruth = uniqueTop([
    ...collectMatches(corpus, /source of truth|master list|canonical|reference table|register|authoritative/gi),
    ...collectMatches(corpus, /MADCAP|SAP|ODS|TITAN|LIMS/gi),
  ]);

  const decisionEngine = uniqueTop([
    ...collectMatches(corpus, /decision|determines?|rules? engine|selection logic|validation logic|routing logic/gi),
    ...collectMatches(corpus, /MADCAP|middleware|WSO2|service/gi),
  ]);

  const executionLayer = uniqueTop([
    ...collectMatches(corpus, /execute|execution|robot|sorter|instrument|analy[sz]er|result entry/gi),
    ...collectMatches(corpus, /CombiFoss|BactoScan|colony counter|analy[sz]er|sorter/gi),
  ]);

  const integrationMechanism = uniqueTop([
    ...collectMatches(corpus, /web service|api|automatic result entry|import|export|file transfer|csv|middleware|interface|connection/gi),
  ]);

  const triggerEvents = uniqueTop([
    ...collectMatches(corpus, /when\s+[^\n\.]{3,90}|on\s+[^\n\.]{3,90}|after\s+[^\n\.]{3,90}/gi),
    ...collectMatches(corpus, /sample receipt|result completion|release|submission|confirmation/gi),
  ]);

  const dataObjects = uniqueTop([
    ...collectMatches(corpus, /result(?:s)?|test code(?:s)?|test type(?:s)?|identifier(?:s)?|selection(?:s)?|status|report(?:s)?|submission/gi),
  ]);

  const failurePoints = uniqueTop([
    ...collectMatches(corpus, /fail(?:s|ure)?|reject(?:s|ed)?|hold|retry|error|timeout|invalid|missing\s+configuration/gi),
  ]);

  const fallbackPaths = uniqueTop([
    ...collectMatches(corpus, /manual\s+entry|manual\s+override|fallback|alternative\s+path|if\s+.*\s+fails?,?\s+.*manual/gi),
  ]);

  return {
    sourceOfTruth,
    decisionEngine,
    executionLayer,
    integrationMechanism,
    triggerEvents,
    dataObjects,
    failurePoints,
    fallbackPaths,
  };
}

export function formatInteractionOperatingFrame(frame: InteractionOperatingFrame): string {
  const listOrUnknown = (items: string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- not clearly evidenced';

  return `## Interaction Operating Frame

### sourceOfTruth
${listOrUnknown(frame.sourceOfTruth)}

### decisionEngine
${listOrUnknown(frame.decisionEngine)}

### executionLayer
${listOrUnknown(frame.executionLayer)}

### integrationMechanism
${listOrUnknown(frame.integrationMechanism)}

### triggerEvents
${listOrUnknown(frame.triggerEvents)}

### dataObjects
${listOrUnknown(frame.dataObjects)}

### failurePoints
${listOrUnknown(frame.failurePoints)}

### fallbackPaths
${listOrUnknown(frame.fallbackPaths)}`;
}