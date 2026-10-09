function clone(value) { return JSON.parse(JSON.stringify(value)); }

function captureObservation(save, result) {
  const next = clone(save);
  const order = next.observations.length + 1;
  const observation = {
    id: `obs-${Date.now()}-${order}`,
    order,
    apparatusSnapshot: clone(save.apparatus),
    selectedBand: result.selectedBand || null,
    resultKind: result.resultKind,
    evidenceKind: result.evidenceKind || null,
    caption: result.message,
    assisted: !!save.assistedSinceLastObservation,
  };
  next.observations.push(observation);
  next.assistedSinceLastObservation = false;
  if (observation.evidenceKind && !next.completedMilestones.includes(observation.evidenceKind)) next.completedMilestones.push(observation.evidenceKind);
  if (observation.evidenceKind === 'E1') next.stage = 'compare';
  if (observation.evidenceKind === 'E2' || observation.evidenceKind === 'E3') next.stage = 'revise';
  if (observation.evidenceKind === 'E4') next.stage = 'transfer';
  if (next.transferPrediction && observation.evidenceKind === 'E3') {
    if (!next.completedMilestones.includes('transfer_observation')) next.completedMilestones.push('transfer_observation');
  }
  return { save: next, observation };
}

function linkEvidence(save, observationId, hypothesis, relation) {
  const next = clone(save);
  const observation = next.observations.find((item) => item.id === observationId);
  if (!observation) return next;
  next.evidenceLinks = next.evidenceLinks.filter((link) => !(link.observationId === observationId && link.hypothesis === hypothesis));
  next.evidenceLinks.push({ observationId, hypothesis, relation });
  if (!next.completedMilestones.includes('linked_evidence')) next.completedMilestones.push('linked_evidence');
  return next;
}

module.exports = { captureObservation, linkEvidence };
