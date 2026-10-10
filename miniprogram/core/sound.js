// 全局声音管理：背景音乐（循环）+ 短音效池，静音状态持久化
// 每个 SFX 用独立的文件 + 音色，避免重复感
const MUTE_KEY = 'sr_muted';
const app = () => getApp();
const SFX_FILES = {
  tap: 'sfx-tap.mp3',
  found: 'sfx-found.mp3',
  hint: 'sfx-hint.mp3',
  success: 'sfx-success.mp3',
};

let bgm = null;
const sfxPool = {};
const log = (...args) => {
  // 录音 + 真机上 console 通常不可见，但 IDE 里能看；保持精简
  if (typeof console !== 'undefined') console.log('[sound]', ...args);
};

function muted() { return app() && app().globalData && app().globalData.muted; }

function ensureBgm() {
  if (bgm) return bgm;
  bgm = wx.createInnerAudioContext({ useWebAudioImplement: false });
  bgm.src = '/assets/audio/ambient-bg.mp3';
  bgm.loop = true;
  bgm.volume = 0.22;
  bgm.onError((err) => log('bgm error', err && err.errMsg || err));
  return bgm;
}

// 把当前页面的所有 audio 全部关掉并清空 pool。
// 在页面 onUnload 时调用，避免多个 SFX 句柄一直占资源。
function destroy() {
  if (bgm) {
    try { bgm.stop(); } catch (e) {}
    try { bgm.destroy(); } catch (e) {}
    bgm = null;
  }
  Object.keys(sfxPool).forEach((name) => {
    const ctx = sfxPool[name];
    if (!ctx) return;
    try { ctx.stop(); } catch (e) {}
    try { ctx.destroy(); } catch (e) {}
    delete sfxPool[name];
  });
}

module.exports = {
  // 在 app.onLaunch 里调用：恢复静音设置
  init() {
    try {
      const stored = wx.getStorageSync(MUTE_KEY);
      if (stored !== '') app().globalData.muted = !!stored;
    } catch (e) { log('mute storage read failed', e); }
  },

  // 页面顶部声音开关调用；返回切换后的静音状态
  toggleMuted() {
    const next = !muted();
    app().globalData.muted = next;
    try { wx.setStorageSync(MUTE_KEY, next); } catch (e) { log('mute write failed', e); }
    if (next) { if (bgm) try { bgm.pause(); } catch (e) {} }
    else { this.startBgm(); this.play('tap'); }
    return next;
  },

  isMuted() { return !!muted(); },

  // 背景音乐：从任意用户首次交互调用（满足小程序自动播放限制）
  startBgm() {
    if (muted()) return;
    const ctx = ensureBgm();
    if (!ctx.paused) return;
    try { ctx.play(); } catch (e) { log('bgm play failed', e); }
  },

  stopBgm() {
    if (bgm) try { bgm.pause(); } catch (e) {}
  },

  // 短音效：tap / found / hint / success
  play(name) {
    if (muted()) return;
    const filename = SFX_FILES[name];
    if (!filename) { log('unknown sfx name', name); return; }
    let ctx = sfxPool[name];
    if (!ctx) {
      ctx = wx.createInnerAudioContext({ useWebAudioImplement: true });
      ctx.src = `/assets/audio/${filename}`;
      ctx.volume = 0.65;
      ctx.onError((err) => log(`sfx(${name}) error`, err && err.errMsg || err));
      sfxPool[name] = ctx;
    }
    try {
      ctx.stop();
      ctx.seek(0);
      ctx.play();
    } catch (e) { log(`sfx(${name}) play threw`, e); }
  },

  // 页面销毁时释放所有 audio 句柄
  destroy,
};
