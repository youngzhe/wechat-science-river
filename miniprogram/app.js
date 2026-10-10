const sound = require('./core/sound');

App({
  globalData: { muted: false },
  onLaunch() {
    sound.init();
    // 优先使用新 API；老基础库回退到 getSystemInfoSync
    let info = {};
    if (wx.getWindowInfo) {
      info = { windowWidth: wx.getWindowInfo().windowWidth, screenHeight: wx.getWindowInfo().screenHeight, safeArea: wx.getWindowInfo().safeArea };
    } else {
      info = wx.getSystemInfoSync();
    }
    this.globalData.windowWidth = info.windowWidth;
    this.globalData.safeAreaBottom = info.screenHeight - (info.safeArea ? info.safeArea.bottom : info.screenHeight);

    // 开发期全局错误钩子：把 wx.onError / onUnhandledRejection 暴露到 console
    // 生产构建里可在 IDE 调试器看到，线上版本由 mp 后台采集
    if (wx.onError) {
      wx.onError((err) => {
        if (typeof console !== 'undefined') console.error('[app] onError', err);
      });
    }
    if (wx.onUnhandledRejection) {
      wx.onUnhandledRejection && wx.onUnhandledRejection((res) => {
        if (typeof console !== 'undefined') console.error('[app] unhandledRejection', res && res.reason, res && res.promise);
      });
    }
  },
});
