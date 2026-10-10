const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateOptics } = require('../miniprogram/core/optics.js');

const base = {
  mode: 'dispersion', prism1InPath: true, prism2InPath: false,
  lensInPath: false, screenPosition: 0.82, slitWidth: 1,
  selectedBand: null, blockedBands: [], prism1Angle: 30,
};

test('white light through first prism creates a continuous spectrum and E1', () => {
  const result = simulateOptics(base);
  assert.equal(result.resultKind, 'spectrum');
  assert.equal(result.evidenceKind, 'E1');
  assert.deepEqual(result.bands, ['red', 'orange', 'yellow', 'green', 'blue', 'violet']);
});

test('a narrow selected band changes direction but keeps its color through prism two', () => {
  const result = simulateOptics({ ...base, mode: 'selective_refraction', prism2InPath: true, slitWidth: 0.12, selectedBand: 'red' });
  assert.equal(result.resultKind, 'band_refracted');
  assert.equal(result.evidenceKind, 'E2');
  assert.equal(result.selectedBand, 'red');
});

test('misaligned or blocked light cannot create evidence', () => {
  const result = simulateOptics({ ...base, prism1Angle: 0, blockedBands: ['red'] });
  assert.equal(result.evidenceKind, null);
  assert.ok(['no_light_on_screen', 'other'].includes(result.resultKind));
});

test('lens recombination needs a complete spectrum and a correctly placed screen', () => {
  const complete = simulateOptics({ ...base, mode: 'recombination', prism1InPath: true, lensInPath: true, slitWidth: 1, screenPosition: 0.62 });
  const partial = simulateOptics({ ...base, mode: 'recombination', prism1InPath: true, lensInPath: true, slitWidth: 1, screenPosition: 0.62, blockedBands: ['blue'] });
  assert.equal(complete.resultKind, 'near_white_overlap');
  assert.equal(complete.evidenceKind, 'E4');
  assert.equal(partial.resultKind, 'partial_overlap');
  assert.notEqual(partial.evidenceKind, 'E4');
});

test('a screen before the second prism cannot record a refraction observation', () => {
  const result = simulateOptics({ ...base, mode:'selective_refraction', prism2InPath:true, slitWidth:.12, selectedBand:'red', screenPosition:.30 });
  assert.equal(result.evidenceKind,null);
  assert.equal(result.directionChanged,false);
  assert.match(result.message,/第二块棱镜前/);
});
