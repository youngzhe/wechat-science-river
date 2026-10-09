const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultSave, dispatchChapterEvent } = require('../miniprogram/core/chapter.js');
const { captureObservation, linkEvidence } = require('../miniprogram/core/notebook.js');
const { loadSave, writeSave, resetSave, SAVE_KEY } = require('../miniprogram/core/save.js');
const { hints } = require('../miniprogram/content/chapter1.js');

function memoryStorage() {
  const data = {};
  return { data, getStorageSync: (key) => data[key], setStorageSync: (key, value) => { data[key] = value; } };
}

test('first hypothesis is preserved when the current hypothesis changes', () => {
  let save = dispatchChapterEvent(createDefaultSave(), { type: 'select_hypothesis', hypothesis: 'prism_creates_colors' });
  save = dispatchChapterEvent(save, { type: 'select_hypothesis', hypothesis: 'white_contains_colors' });
  assert.equal(save.initialHypothesis, 'prism_creates_colors');
  assert.equal(save.currentHypothesis, 'white_contains_colors');
});

test('captured observation is immutable after later apparatus movement', () => {
  const save = createDefaultSave(); save.apparatus.prism1Angle = 35;
  const { save: recorded, observation } = captureObservation(save, { resultKind: 'spectrum', evidenceKind: 'E1', message: '连续色带', selectedBand: null });
  recorded.apparatus.prism1Angle = 20;
  assert.equal(observation.apparatusSnapshot.prism1Angle, 35);
});

test('E1 can be linked as compatible with both initial explanations', () => {
  let save = createDefaultSave();
  const { save: afterCapture, observation } = captureObservation(save, { resultKind: 'spectrum', evidenceKind: 'E1', message: '连续色带' });
  save = linkEvidence(afterCapture, observation.id, 'prism_creates_colors', 'compatible');
  save = linkEvidence(save, observation.id, 'white_contains_colors', 'compatible');
  assert.equal(save.evidenceLinks.length, 2);
  assert.ok(save.evidenceLinks.every((link) => link.relation === 'compatible'));
});

test('unknown save schema falls back safely and reset clears progress', () => {
  const storage = memoryStorage();
  storage.data[SAVE_KEY] = { schemaVersion: 999, stage: 'broken' };
  assert.equal(loadSave(storage).stage, 'intro');
  writeSave(storage, dispatchChapterEvent(createDefaultSave(), { type: 'inspect', objectId: 'window' }));
  assert.equal(loadSave(storage).inspectedObjects.length, 1);
  assert.equal(resetSave(storage).inspectedObjects.length, 0);
});

test('hint use is recorded on the next snapshot and then resets for an independent attempt', () => {
  let save = dispatchChapterEvent(createDefaultSave(), { type: 'request_hint', blocker: 'investigate' });
  const first = captureObservation(save, { resultKind: 'spectrum', evidenceKind: 'E1', message: '带帮助的观察' });
  assert.equal(first.observation.assisted, true);
  assert.equal(first.save.assistedSinceLastObservation, false);
  const second = captureObservation(first.save, { resultKind: 'spectrum', evidenceKind: 'E1', message: '独立观察' });
  assert.equal(second.observation.assisted, false);
});

test('all eight chapter blockers expose four voluntary hint levels', () => {
  assert.equal(Object.keys(hints).length, 8);
  for (const blocker of Object.keys(hints)) assert.equal(hints[blocker].length, 4, blocker);
});
