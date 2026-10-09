const SCHEMA_VERSION = 1;
const CHAPTER_ID = 'newton-white-light';

function createDefaultSave() {
  return {
    schemaVersion: SCHEMA_VERSION,
    chapterId: CHAPTER_ID,
    stage: 'intro',
    initialHypothesis: null,
    currentHypothesis: null,
    inspectedObjects: [],
    apparatus: {
      mode: 'dispersion', prism1InPath: false, prism1Angle: 30,
      slitPosition: 0.5, slitWidth: 1, selectedBand: null,
      prism2InPath: false, lensInPath: false, screenPosition: 0.82,
      blockedBands: [],
    },
    observations: [],
    evidenceLinks: [],
    hintsByBlocker: {},
    completedMilestones: [],
    companionEventsSeen: [],
    transferPrediction: null,
    assistedSinceLastObservation: false,
    completed: false,
    updatedAt: Date.now(),
  };
}

function dispatchChapterEvent(save, event) {
  const next = JSON.parse(JSON.stringify(save));
  if (event.type === 'inspect' && !next.inspectedObjects.includes(event.objectId)) next.inspectedObjects.push(event.objectId);
  if (event.type === 'select_hypothesis') {
    if (!next.initialHypothesis) next.initialHypothesis = event.hypothesis;
    next.currentHypothesis = event.hypothesis;
    next.stage = 'investigate';
  }
  if (event.type === 'set_stage') next.stage = event.stage;
  if (event.type === 'link_evidence' && !next.completedMilestones.includes('linked_evidence')) next.completedMilestones.push('linked_evidence');
  if (event.type === 'transfer_prediction') next.transferPrediction = event.prediction;
  if (event.type === 'request_hint') next.assistedSinceLastObservation = true;
  if (event.type === 'complete') { next.completed = true; next.stage = 'conclusion'; }
  next.updatedAt = Date.now();
  return next;
}

module.exports = { SCHEMA_VERSION, CHAPTER_ID, createDefaultSave, dispatchChapterEvent };
