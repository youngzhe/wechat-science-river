const { loadSave } = require('../../core/save');
const sound = require('../../core/sound');
Page({
  data: { continueLabel: '开始探索', muted: false },
  onShow() {
    const save = loadSave(wx);
    this.setData({ continueLabel: save.completed ? '查看发现档案' : save.observations.length || save.inspectedObjects.length ? '继续上次探索' : '开始探索', completed: save.completed, muted: sound.isMuted() });
  },
  startChapter() {
    sound.startBgm();
    sound.play('tap');
    wx.navigateTo({ url: this.data.completed ? '/pages/ending/index' : '/pages/study/index' });
  },
  toggleSound() { this.setData({ muted: sound.toggleMuted() }); },
});
