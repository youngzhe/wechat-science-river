const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultSave } = require('../miniprogram/core/chapter');
const { buildJourney, chapterDestination } = require('../miniprogram/core/journey');
const { sceneGeometry } = require('../miniprogram/core/optics-scene');

test('new save has honest empty discoveries and a study entry', () => {
  const save = createDefaultSave();
  const view = buildJourney(save);
  assert.equal(view.discoveries.length, 0);
  assert.equal(view.completedSteps, 0);
  assert.equal(chapterDestination(save), '/pages/study/index');
  assert.equal(view.atlas.filter(x => x.kind === 'knowledge' && x.unlocked).length, 0);
});
test('resume follows a valid local page, with old-save and completed fallbacks', () => {
  const save = createDefaultSave();
  save.observations = [{id:'one', evidenceKind:'E1', caption:'光谱', apparatusSnapshot:{mode:'dispersion'}}];
  assert.equal(chapterDestination(save), '/pages/lab/index');
  save.lastPage = 'pages/notebook/index';
  assert.equal(chapterDestination(save), '/pages/notebook/index');
  save.lastPage = 'https://bad.example';
  assert.equal(chapterDestination(save), '/pages/lab/index');
  save.completed = true;
  assert.equal(chapterDestination(save), '/pages/ending/index');
  assert.equal(buildJourney(save).atlas.find(x => x.id === 'spectrum').unlocked, true);
});
test('second prism keeps the selected color and visibly bends the outgoing ray', () => {
  const base = {mode:'selective_refraction', prism1InPath:true, prism1Angle:30, slitWidth:.12, selectedBand:'red', screenPosition:.82, blockedBands:[]};
  const before = sceneGeometry(base,320,175);
  const after = sceneGeometry({...base,prism2InPath:true},320,175);
  assert.equal(after.rays[0].band,'red');
  assert.equal(after.rays[0].points.length,4);
  assert.notEqual(after.rays[0].points.at(-1).y,before.rays[0].points.at(-1).y);
});
test('lens convergence is fixed while moving the screen changes the intercepted spots', () => {
  const base = {mode:'recombination',prism1InPath:true,prism1Angle:30,lensInPath:true,blockedBands:[],screenPosition:.62};
  const focused = sceneGeometry(base,320,175);
  const away = sceneGeometry({...base,screenPosition:.85},320,175);
  assert.equal(focused.focusX,away.focusX);
  assert.notEqual(focused.screenX,away.screenX);
  assert.ok(Math.abs(focused.rays[0].points.at(-1).y-focused.cy)<.01);
  assert.ok(Math.abs(away.rays[0].points.at(-1).y-away.cy)>10);
});
