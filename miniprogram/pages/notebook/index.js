const { loadSave, writeSave } = require('../../core/save');
const { dispatchChapterEvent } = require('../../core/chapter');
const { linkEvidence } = require('../../core/notebook');
const { hypotheses } = require('../../content/chapter1');
const hypothesisText = {
  prism_creates_colors: '棱镜让白光产生颜色',
  white_contains_colors: '白光本来包含不同颜色',
  undecided: '暂时还不确定',
};
const modes = { dispersion: '展开光谱', selective_refraction: '选色实验', recombination: '光谱会聚' };
const bands = { red: '红', orange: '橙', yellow: '黄', green: '绿', blue: '蓝', violet: '紫' };
Page({
  data: { hypotheses, observations: [], selectedId: null, selectedObservation: null, initialText: '还没有猜想', currentText: '还没有猜想', currentHypothesis: null, hasE4: false, hasTransferObservation: false, transferPrediction: null, canConclude: false },
  onLoad(options) { if (options.observation) this.setData({ selectedId: options.observation }); },
  onShow() { const save = loadSave(wx); save.lastPage = 'pages/notebook/index'; writeSave(wx, save); this.refresh(); },
  refresh() {
    const save = loadSave(wx);
    const selectedObservation = save.observations.find((item) => item.id === this.data.selectedId) || save.observations[save.observations.length - 1] || null;
    const hasE4 = save.observations.some((item) => item.evidenceKind === 'E4');
    const hasTransferObservation = save.completedMilestones.includes('transfer_observation');
    const hasE23 = save.observations.some((item) => item.evidenceKind === 'E2' || item.evidenceKind === 'E3');
    const hasE2 = save.observations.some((item) => item.evidenceKind === 'E2');
    const linkedKeyEvidence = save.evidenceLinks.some((link) => ['E2', 'E3'].includes((save.observations.find((o) => o.id === link.observationId) || {}).evidenceKind));
    const canConclude = hasE2 && hasE23 && hasE4 && hasTransferObservation && linkedKeyEvidence;
    this.setData({ observations: save.observations.map((o) => ({ ...o, modeLabel: modes[o.apparatusSnapshot.mode] || '实验', selectedBandName: o.selectedBand ? `${bands[o.selectedBand] || ''}色` : '完整光谱' })), selectedId: selectedObservation && selectedObservation.id, selectedObservation, initialText: hypothesisText[save.initialHypothesis] || '还没有猜想', currentText: hypothesisText[save.currentHypothesis] || '还没有猜想', currentHypothesis: save.currentHypothesis, hasE4, hasTransferObservation, transferPrediction: save.transferPrediction, canConclude });
  },
  selectObservation(e) {
    const id = e.currentTarget.dataset.id;
    const selectedObservation = loadSave(wx).observations.find((item) => item.id === id) || null;
    this.setData({ selectedId: id, selectedObservation });
  },
  reviseHypothesis(e) {
    const save = dispatchChapterEvent(loadSave(wx), { type: 'select_hypothesis', hypothesis: e.currentTarget.dataset.id });
    writeSave(wx, save); this.refresh();
  },
  linkHypothesis(e) {
    const save = loadSave(wx); const observation = this.data.selectedObservation;
    if (!observation) return;
    const relation = observation.evidenceKind === 'E1' ? 'compatible' : 'supports_comparison';
    writeSave(wx, linkEvidence(save, observation.id, e.currentTarget.dataset.id, relation));
    wx.showToast({ title: relation === 'compatible' ? '已标记：都能解释' : '证据已关联', icon: 'success' });
    this.refresh();
  },
  setPrediction(e) {
    const save = dispatchChapterEvent(loadSave(wx), { type: 'transfer_prediction', prediction: e.currentTarget.dataset.value });
    writeSave(wx, save); this.refresh();
  },
  startTransfer() {
    if (!this.data.transferPrediction) { wx.showToast({ title: '先选一个预测', icon: 'none' }); return; }
    const save = loadSave(wx);
    save.apparatus = { ...save.apparatus, mode: 'selective_refraction', prism1InPath: true, prism1Angle: 30, prism2InPath: false, lensInPath: false, slitWidth: 0.12, selectedBand: save.apparatus.selectedBand === 'blue' ? 'green' : 'blue', screenPosition: 0.82, blockedBands: [] };
    save.stage = 'transfer'; writeSave(wx, save);
    wx.navigateTo({ url: '/pages/lab/index' });
  },
  conclude() {
    const save = dispatchChapterEvent(loadSave(wx), { type: 'complete' }); writeSave(wx, save);
    wx.navigateTo({ url: '/pages/ending/index' });
  },
  modeName(mode) { return modes[mode] || '实验'; },
  bandName(band) { return bands[band] || ''; },
  backToLab() {
    const pages = getCurrentPages();
    if (pages.length > 1 && pages[pages.length - 2].route === 'pages/lab/index') wx.navigateBack({ delta: 1 });
    else wx.navigateTo({ url: '/pages/lab/index' });
  },
});
