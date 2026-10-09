const { loadSave } = require('../../core/save');
const { archive } = require('../../content/chapter1');
const sound = require('../../core/sound');
const names = {
  prism_creates_colors: '棱镜让白光产生颜色',
  white_contains_colors: '白光本来包含不同颜色',
  undecided: '暂时还不确定',
};
Page({
  data: { archive, initialText: '', currentText: '', evidenceSummary: '', observations: [] },
  onShow() {
    const save = loadSave(wx);
    const keyEvidence = save.observations.filter((o) => o.evidenceKind).map((o) => o.evidenceKind);
    this.setData({ initialText: names[save.initialHypothesis] || '没有预设答案，先收集线索', currentText: names[save.currentHypothesis] || '继续观察，再形成自己的解释', evidenceSummary: [...new Set(keyEvidence)].join(' · ') || '还没有关键观察', observations: save.observations });
    sound.play('success');
  },
  copySource(e) {
    wx.setClipboardData({ data: e.currentTarget.dataset.url, success: () => wx.showToast({ title: '来源链接已复制', icon: 'success' }) });
  },
  backHome() { sound.play('tap'); wx.reLaunch({ url: '/pages/home/index' }); },
});
