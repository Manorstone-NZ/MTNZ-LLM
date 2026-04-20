/**
 * Reprocess residual cohort with pass 2 tuning logic via the ingest API.
 * 
 * This script selectively reprocesses the top 20 Partial docs identified in the
 * residual pass 2 analysis to apply the new tuning for equipment specs and broken
 * structure fragments.
 *
 * Usage:
 *   tsx scripts/reprocess-residual-pass2.ts [--run-number N]
 */

import * as fs from 'fs';
import * as path from 'path';

interface ResidualDocRef {
  id: string;
  title: string;
  source_path: string;
}

async function reprocessDocument(docId: string, title: string, baseUrl: string): Promise<boolean> {
  try {
    console.log(`[pass2-reprocess] → Reprocessing ${title}...`);

    const response = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reprocess_one',
        documentId: docId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[pass2-reprocess] ERROR: HTTP ${response.status} - ${errorText}`);
      return false;
    }

    // Stream the response to capture progress
    const reader = response.body?.getReader();
    if (!reader) {
      console.error('[pass2-reprocess] No response body');
      return false;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.status) {
              console.log(`  → ${data.status}`);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }

    console.log(`[pass2-reprocess] ✓ Completed ${title}`);
    return true;
  } catch (err) {
    console.error(`[pass2-reprocess] Exception reprocessing ${title}:`, err);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const runNumberIndex = args.indexOf('--run-number');
  const runNumber = runNumberIndex >= 0 ? parseInt(args[runNumberIndex + 1]) : 1;

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';

  console.log(`[pass2-reprocess] Pass 2 reprocessing run #${runNumber}`);
  console.log(`[pass2-reprocess] API base: ${baseUrl}`);

  // Load the residual analysis artifact to get the doc IDs to reprocess
  const analysisPath = 'docs/reports/2026-04-20-live-validation/residual-exclusion-analysis-pass2-before.json';
  if (!fs.existsSync(analysisPath)) {
    throw new Error(`Analysis artifact not found: ${analysisPath}`);
  }

  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
  const cohortDocs: ResidualDocRef[] = analysis.per_document.map((d: any) => ({
    id: d.id,
    title: d.title,
    source_path: d.source_path,
  }));

  console.log(`[pass2-reprocess] Loaded ${cohortDocs.length} docs from analysis artifact`);
  console.log('[pass2-reprocess] Starting reprocessing...\n');

  let successCount = 0;
  let failureCount = 0;

  for (const docRef of cohortDocs) {
    const success = await reprocessDocument(docRef.id, docRef.title, baseUrl);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
    // Small delay between docs to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('\n[pass2-reprocess] Summary:');
  console.log(`[pass2-reprocess] ✓ Successful: ${successCount}`);
  console.log(`[pass2-reprocess] ✗ Failed: ${failureCount}`);
  console.log(`[pass2-reprocess] Total: ${cohortDocs.length}`);

  if (failureCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[pass2-reprocess] Fatal error:', err);
  process.exit(1);
});
