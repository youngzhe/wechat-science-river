# 世界首页与器材联动 Implementation Plan

> **For agentic workers:** Use native execution in this session. Follow the authorized selected design.

**Goal:** 把世界首页四个导航接到本地内容，修复器材与画面的联动。
**Architecture:** 原生首页以四个本地视图切换；journey 模块映射存档为发现、图鉴、旅程与继续路径。独立光路几何与绘制模块供实验台调用。
**Tech Stack:** 微信原生 WXML/WXSS/JavaScript、Canvas2D、本地图片与音频。
**Spec:** ../specs/2026-10-10-world-home-design.md

## Global Constraints
- 用户已选择地图融合稿与木质导航，保留现有进度。
- 无服务器、登录、网络素材或新依赖。
- 未开放领域可查看预告，不提供假章节入口。

## Review Focus
- 全新存档有明确开始动作和空状态。
- 老存档缺 lastPage 时按有效进度恢复。
- 多次进出首页不堆叠页面，动画遮罩能关闭。
- 选色后加第二棱镜能看到同色折转。
- 移动屏幕不移动透镜的固定会聚点。

## Tasks
- [ ] 建立光路与继续路径的回归检查，证明旧画面联动缺口。
- [ ] 生成/落盘地图与木质素材，首页四个本地视图和章节过渡。
- [ ] 提取光路绘图，隐藏当前实验无关按钮，接入准确状态反馈。
- [ ] 核对离线依赖、回归检查、模拟器主流程与设计显示，更新资源说明。
