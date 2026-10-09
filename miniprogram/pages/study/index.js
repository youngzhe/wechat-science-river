const { loadSave, writeSave } = require('../../core/save');
const { dispatchChapterEvent } = require('../../core/chapter');
const { objects, hypotheses, hints } = require('../../content/chapter1');
const sound = require('../../core/sound');
Page({
  data: {
    hypotheses,
    inspected: {}, activeClue: null, dialogue: '这本笔记少了一条结论。先看看书房里，哪些东西能帮我们弄清彩光从哪里来？',
    allInspected: false, currentHypothesis: null, observationCount: 0, progressDots: [false, false, false, false],
    introOpen: false, dialogueHidden: false,
    showHint: false, hintLevel: 1, hintText: '', guidedObjects: false, muted: false,
  },
  onShow() {
    const save = loadSave(wx);
    const inspected = {};
    save.inspectedObjects.forEach((id) => { inspected[id] = true; });
    this.setData({ inspected, allInspected: Object.keys(objects).every((id) => inspected[id]), currentHypothesis: save.currentHypothesis, observationCount: save.observations.length, progressDots: Object.keys(objects).map((id) => !!inspected[id]), introOpen: save.stage === 'intro' && !save.inspectedObjects.length, muted: sound.isMuted() });
  },
  enterRoom() {
    const save = dispatchChapterEvent(loadSave(wx), { type: 'set_stage', stage: 'investigate' });
    writeSave(wx, save); this.setData({ introOpen: false });
    sound.play('tap');
  },
  inspect(event) {
    const id = event.currentTarget.dataset.object;
    let save = loadSave(wx);
    save = dispatchChapterEvent(save, { type: 'inspect', objectId: id });
    writeSave(wx, save);
    sound.play('found');
    this.setData({ inspected: { ...this.data.inspected, [id]: true }, activeClue: objects[id], dialogue: this.data.inspected[id] ? '这条线索可以再看一遍。看看其他物件能不能补上缺口。' : `我也看见了。${objects[id].title}，记下来！` });
    const allInspected = Object.keys(objects).every((key) => this.data.inspected[key] || key === id);
    this.setData({ allInspected, progressDots: Object.keys(objects).map((key) => !!this.data.inspected[key] || key === id) });
  },
  closeClue() { this.setData({ activeClue: null }); },
  hideDialogue() { this.setData({ dialogueHidden: true }); },
  showDialogue() { this.setData({ dialogueHidden: false }); },
  chooseHypothesis(event) {
    const hypothesis = event.currentTarget.dataset.id;
    const save = dispatchChapterEvent(loadSave(wx), { type: 'select_hypothesis', hypothesis });
    writeSave(wx, save);
    sound.play('tap');
    const line = hypothesis === 'undecided' ? '不确定也可以，我们就去找能比较两种想法的证据。' : '我先把你的想法记在旁边。观察结果也许会让我们一起修改它。';
    this.setData({ currentHypothesis: hypothesis, dialogue: line });
  },
  startLab() { sound.play('tap'); wx.navigateTo({ url: '/pages/lab/index' }); },
  openNotebook() { sound.play('tap'); wx.navigateTo({ url: '/pages/notebook/index' }); },
  toggleSound() { this.setData({ muted: sound.toggleMuted() }); },
  requestHint() {
    const blocker = 'investigate';
    const save = dispatchChapterEvent(loadSave(wx), { type: 'request_hint', blocker });
    const record = save.hintsByBlocker[blocker] || { highestLevel: 0 };
    const hintLevel = Math.min(record.highestLevel + 1, 4);
    save.hintsByBlocker[blocker] = { highestLevel: hintLevel };
    writeSave(wx, save);
    sound.play('hint');
    this.setData({ showHint: true, hintLevel, hintText: hints[blocker][hintLevel - 1], guidedObjects: hintLevel === 4 || this.data.guidedObjects });
  },
  deeperHint() {
    const save = loadSave(wx); const blocker = 'investigate';
    const record = save.hintsByBlocker[blocker] || { highestLevel: 1 };
    const hintLevel = Math.min(record.highestLevel + 1, 4);
    save.hintsByBlocker[blocker] = { highestLevel: hintLevel };
    writeSave(wx, save);
    sound.play('hint');
    this.setData({ hintLevel, hintText: hints[blocker][hintLevel - 1], guidedObjects: hintLevel === 4 || this.data.guidedObjects });
  },
  closeHint() { this.setData({ showHint: false }); },
  stopTap() {},
});