const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultSave, dispatchChapterEvent } = require('../miniprogram/core/chapter.js');
const { captureObservation, linkEvidence } = require('../miniprogram/core/notebook.js');
const { simulateOptics } = require('../miniprogram/core/optics.js');

function observe(save) {
  const result = simulateOptics(save.apparatus);
  return { ...captureObservation(save, result), result };
}

test('chapter path from first spectrum to transfer keeps the evidence chain usable', () => {
  let save = dispatchChapterEvent(createDefaultSave(), { type: 'select_hypothesis', hypothesis: 'prism_creates_colors' });
  save = { ...save, apparatus: { ...save.apparatus, prism1InPath: true } };
  let captured = observe(save); save = captured.save;
  assert.equal(captured.result.evidenceKind, 'E1');
  save = linkEvidence(save, captured.observation.id, 'prism_creates_colors', 'compatible');
  save = linkEvidence(save, captured.observation.id, 'white_contains_colors', 'compatible');

  save.apparatus = { ...save.apparatus, mode: 'selective_refraction', slitWidth: .12, selectedBand: 'red', prism2InPath: true };
  captured = observe(save); save = captured.save;
  assert.equal(captured.result.evidenceKind, 'E2');
  save = linkEvidence(save, captured.observation.id, 'white_contains_colors', 'supports_comparison');

  save.apparatus = { ...save.apparatus, selectedBand: 'blue' };
  captured = observe(save); save = captured.save;
  assert.equal(captured.result.evidenceKind, 'E3');

  save.apparatus = { ...save.apparatus, mode: 'recombination', lensInPath: true, screenPosition: .62, blockedBands: [] };
  captured = observe(save); save = captured.save;
  assert.equal(captured.result.evidenceKind, 'E4');

  save = dispatchChapterEvent(save, { type: 'transfer_prediction', prediction: 'same_color' });
  save.apparatus = { ...save.apparatus, mode: 'selective_refraction', selectedBand: 'green', prism2InPath: true, lensInPath: false };
  captured = observe(save); save = captured.save;
  assert.equal(captured.result.evidenceKind, 'E3');
  assert.ok(save.completedMilestones.includes('transfer_observation'));
});
