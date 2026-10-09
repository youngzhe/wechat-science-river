// 全局声音管理：背景音乐（循环）+ 短音效池，静音状态持久化
const MUTE_KEY = 'sr_muted';
const app = () => getApp();

let bgm = null;
const sfxPool = {};

function muted() { return app() && app().globalData && app().globalData.muted; }

function ensureBgm() {
  if (bgm) return bgm;
  bgm = wx.createInnerAudioContext({ useWebAudioImplement: false });
  bgm.src = '/assets/audio/bgm.wav';
  bgm.loop = true;
  bgm.volume = 0.4;
  bgm.onError(() => {});
  return bgm;
}

module.exports = {
  // 在 app.onLaunch 里调用：恢复静音设置
  init() {
    try {
      const stored = wx.getStorageSync(MUTE_KEY);
      if (stored !== '') app().globalData.muted = !!stored;
    } catch (e) { /* 存储不可用时保持默认 */ }
  },

  // 页面顶部声音开关调用；返回切换后的静音状态
  toggleMuted() {
    const next = !muted();
    app().globalData.muted = next;
    try { wx.setStorageSync(MUTE_KEY, next); } catch (e) {}
    if (next) { if (bgm) bgm.pause(); }
    else { this.startBgm(); this.play('tap'); }
    return next;
  },

  isMuted() { return !!muted(); },

  // 背景音乐：从任意用户首次交互调用（满足小程序自动播放限制）
  startBgm() {
    if (muted()) return;
    const ctx = ensureBgm();
    if (!ctx.paused) return;
    try { ctx.play(); } catch (e) { /* 静默失败 */ }
  },

  // 短音效：tap / found / success / hint
  play(name) {
    if (muted()) return;
    let ctx = sfxPool[name];
    if (!ctx) {
      ctx = wx.createInnerAudioContext({ useWebAudioImplement: true });
      ctx.src = `/assets/audio/sfx-${name}.wav`;
      ctx.volume = 0.65;
      ctx.onError(() => {});
      sfxPool[name] = ctx;
    }
    try {
      ctx.stop();
      ctx.seek(0);
      ctx.play();
    } catch (e) { /* 静默失败，不打断交互 */ }
  },
};
