import test from 'node:test';
import assert from 'node:assert/strict';

import type { ExtractedSection, NormalisedSection } from './types';
import { classifySections } from './normalise/classify';
import { applyShortContentPolicy, recoverValueableBrokenStructureFragments } from './normalise/cleanup';
import { classifyBoilerplateTag } from './normalise/boilerplate';

test('short procedural fragments are retained', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Procedure',
      content: 'Procedure',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: '1. Open MADCAP and select the correct result listing report.',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
  ];

  const tuned = applyShortContentPolicy(sections);
  assert.equal(tuned[1].retrieval_excluded, false);
});

test('short compact equipment bullet lists are retained', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Equipment',
      content: 'Equipment',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: '• Barcode Scanner\n• Envirofreeze\n• Polybin Chilly Bins',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
  ];

  const tuned = applyShortContentPolicy(sections);
  assert.equal(tuned[1].retrieval_excluded, false);
});

test('useful table references are retained', () => {
  const extracted: ExtractedSection[] = [
    {
      title: 'Result Codes',
      content: 'Code,Description,Unit\nA1,Calibration check,mg/L\nB2,Protein estimate,%',
      type: 'table',
    },
  ];

  const classified = classifySections(extracted, 'Reference table test');
  assert.equal(classified[0].retrieval_excluded, false);
  assert.equal((classified[0].normalisation_reason as Record<string, unknown>).exclusion_tag, 'table_reference');
});

test('meaningless numeric table noise is excluded', () => {
  const extracted: ExtractedSection[] = [
    {
      title: 'Raw grid',
      content: '1,2,3,4\n5,6,7,8\n9,10,11,12',
      type: 'table',
    },
  ];

  const classified = classifySections(extracted, 'Noise table test');
  assert.equal(classified[0].retrieval_excluded, true);
  assert.equal((classified[0].normalisation_reason as Record<string, unknown>).exclusion_tag, 'table_noise');
});

test('ocr garbage fragments are excluded', () => {
  const extracted: ExtractedSection[] = [
    {
      title: null,
      content: '� � � ??? O0O0lIlI xxxx',
      type: 'paragraph',
    },
  ];

  const classified = classifySections(extracted, 'OCR noise test');
  assert.equal(classified[0].retrieval_excluded, true);
  assert.equal((classified[0].normalisation_reason as Record<string, unknown>).exclusion_tag, 'ocr_garbage');
});

test('footer marker chunks with procedural body are retained', () => {
  const extracted: ExtractedSection[] = [
    {
      title: null,
      content:
        'CONTROLLED COPY IF THIS LINE IS GREEN\nVersion 22/ Jun 2022 Sample Selection Page 4 of 32\nSelect Milk Testing and click on launch. The following screen will appear below.',
      type: 'paragraph',
    },
  ];

  const classified = classifySections(extracted, 'Mixed footer content test');
  assert.equal(classified[0].retrieval_excluded, false);
  assert.equal(classified[0].section_type, 'instruction_block');
  assert.equal((classified[0].normalisation_reason as Record<string, unknown>).exclusion_tag, 'broken_structure');
});

test('duplicate boilerplate signature remains mapped to duplicate_boilerplate', () => {
  const tag = classifyBoilerplateTag('Wear PPE and wash hands before processing samples.');
  assert.equal(tag, 'duplicate_boilerplate');
});

// ===== Pass 2 Tuning Tests =====

test('[pass2] equipment specification fragments with broken_structure tag are recovered', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Specifications',
      content: 'Specifications',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: 'Model: LC-2030C, Range: 0–200°C, Resolution: 0.1°C, Voltage: 110–240V',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: true,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: {
        excluded: true,
        reason: 'broken_structure',
        exclusion_tag: 'broken_structure',
      },
    },
  ];

  const recovered = recoverValueableBrokenStructureFragments(sections);
  assert.equal(recovered[1].retrieval_excluded, false);
  assert.equal((recovered[1].normalisation_reason as Record<string, unknown>).retained_pass2, true);
});

test('[pass2] calibration range fragments are retained even with short_fragment_noise tag', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Calibration',
      content: 'Calibration',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: 'Calibration range: 0.0–50.0 mg/L with certified standard reference material',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: true,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: {
        excluded: true,
        reason: 'short_fragment_noise',
        exclusion_tag: 'short_fragment_noise',
      },
    },
  ];

  const recovered = recoverValueableBrokenStructureFragments(sections);
  assert.equal(recovered[1].retrieval_excluded, false);
});

test('[pass2] safety warning fragments with equipment context are recovered', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Safety',
      content: 'Safety',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: 'WARNING: Never exceed maximum temperature of 95°C on this equipment.',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: true,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: {
        excluded: true,
        reason: 'broken_structure',
        exclusion_tag: 'broken_structure',
      },
    },
  ];

  const recovered = recoverValueableBrokenStructureFragments(sections);
  assert.equal(recovered[1].retrieval_excluded, false);
});

test('[pass2] expanded equipment bullet list retention (8-word items)', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Equipment Required',
      content: 'Equipment Required',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: '• Calibrated pH meter with temperature compensation function\n• Sterile sample container made from polypropylene\n• Reference buffer solutions at pH 4 6 and 10',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
  ];

  const tuned = applyShortContentPolicy(sections);
  assert.equal(tuned[1].retrieval_excluded, false);
});

test('[pass2] true noise fragments remain excluded even after recovery attempt', () => {
  const sections: NormalisedSection[] = [
    {
      title: 'Junk',
      content: 'Junk',
      type: 'heading',
      section_type: 'heading',
      section_type_confidence: 0.95,
      retrieval_excluded: false,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: null,
    },
    {
      title: null,
      content: 'xyz abc 123',
      type: 'paragraph',
      section_type: 'paragraph',
      section_type_confidence: 0.5,
      retrieval_excluded: true,
      retrieval_downranked: false,
      is_boilerplate: false,
      boilerplate_hash: null,
      normalisation_reason: {
        excluded: true,
        reason: 'broken_structure',
        exclusion_tag: 'broken_structure',
      },
    },
  ];

  const recovered = recoverValueableBrokenStructureFragments(sections);
  assert.equal(recovered[1].retrieval_excluded, true);
});
