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
  },
});
