# 科学长河第一章小程序实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本目录交付可导入微信开发者工具的原生小程序原型，能从开场完成牛顿光学章节的调查、实验、证据推理和结案。

**Architecture:** 原生小程序页面采用 2.5D 沉浸式呈现：原创书房空间场景、缓慢视差推近、光路发光动画、器材阴影和小墨团浮动；实验的棱镜/透镜/连续光谱由 Canvas 2D 按实时器材状态绘制，保证物理模型可控。纯 JavaScript 光学模型计算结果，章节状态控制器推进流程；本地仓库保存版本化进度和不可变观察快照。首版不使用实时 3D 引擎/可自由旋转 3D 场景，以控制素材、性能和兼容成本。

**Tech Stack:** 微信小程序原生框架、JavaScript、WXML/WXSS、Canvas 2D、本地 Storage API；2.5D 运动由 WXSS/Canvas 完成，不引入服务端、登录、实时 AI、支付或广告。

**Spec:** `/Users/yangzhe/Downloads/科学长河_小程序产品与第一章实施规格_v1.md`

## Global Constraints

- 竖屏微信小程序，视觉采用 2.5D 景深与镜头动效；普通小程序与小游戏的注册发布路径需区分。
- 章节实验采用教学模型：白光经棱镜产生连续光谱；足够窄色带再次折射仍保持近似颜色；完整光谱由透镜会聚到合适屏位置呈近白光。
- E1 不区分 H1/H2；E2/E3/E4 仅在物理条件有效时生成。
- 初始猜想保留；快照深复制；本地存档有 schemaVersion。
- 四层提示由玩家主动逐层请求，错误猜想或预测不锁死通关。
- 科学史事实、教学简化和虚构情节明确区分；不伪造牛顿原话或精确地点。
- 美术为原创温暖手绘风；任何占位资源需有明确标记。
- 不实现多人、广告、支付、强制登录或实时 AI 对话。

## Review Focus

- 器材未对准、被遮挡、光束未到屏幕：光路结果不得误判为成功；由光学模型测试覆盖。
- 任意棱镜角度或器材顺序：不能产生违反教学模型的颜色；由光学模型边界测试覆盖。
- 已保存观察后移动器材：旧快照不得改变；由存档/快照测试覆盖。
- 从 H1、未决定、提示辅助或迁移预测错误开始：仍可完成主线；由章节流程测试覆盖。
- 窄屏、底部安全区和提示/笔记往返：主操作仍可触达且实验状态恢复；由开发者工具手动检查覆盖。

## Planned File Structure

- `miniprogram/`：原生小程序入口、页面、组件与静态资源。
- `miniprogram/core/optics.js`：纯函数光学模型和教学结果。
- `miniprogram/core/chapter.js`：章节事件、阶段推进和里程碑。
- `miniprogram/core/notebook.js`：观察快照、证据关联、猜想更新。
- `miniprogram/core/save.js`：版本化本地读写、恢复和重置。
- `miniprogram/content/chapter1.js`：对白、物件线索、提示层级、档案来源。
- `miniprogram/pages/`：入口长河、书房、实验台、笔记、结案页。
- `miniprogram/assets/`：绘图生成的书房背景、角色/角色表情和可复用装饰素材。
- `tests/`：纯逻辑模块自动化测试。
- `README.md`：微信开发者工具导入、运行、素材说明、已知限制和缺失资源。
- `docs/superpowers/plans/2026-10-09-science-river-mini-program.md`：本计划。

## Tasks

### Task 1: 建立可导入的小程序骨架

**Files:** Create root `project.config.json` and `miniprogram/app.json`, `app.js`, `app.wxss`, `sitemap.json`, `README.md`。

- [x] 配置章节页面路由、竖屏布局、基础色板和本地预览项目配置；AppID 留作开发者配置项，不伪造正式账号信息。
- [x] 编写导入说明，说明原生小程序路线、模拟器启动方式、测试 AppID/无 AppID 模式和真机限制。
- [x] 确认目录配置满足微信开发者工具项目结构要求。

### Task 2: 实现光学模型与测试

**Files:** Create `miniprogram/core/optics.js`, `tests/optics.test.cjs`.

**Interfaces:** `simulateOptics(state)`；结果含 resultKind、bands、selectedBand、evidenceKind、message、lightOnScreen、directionChanged、pathOffset。

- [x] 先写测试：未穿过器材、光路被挡、屏幕未接光、连续光谱、窄色带二次折射仍为该颜色、全谱透镜会聚、缺失色带为 partial_overlap。
- [x] 运行测试确认失败，再实现纯函数模型；模型明确为教学简化，不模拟真实波长色散精度。
- [x] 验证所有不成立的摆法都返回无效/其他结果，不误发 E2/E4。

### Task 3: 实现章节状态、笔记和本地存档

**Files:** Create `miniprogram/core/chapter.js`, `notebook.js`, `save.js`, matching `tests/*.test.cjs`.

**Interfaces:** `dispatchChapterEvent(save,event)`、`captureObservation(save,result)`、`linkEvidence(save,observationId,hypothesis,relation)`、`loadSave(storage)`、`writeSave(storage,save)`。

- [x] 测试初始猜想不可覆盖、E1 对 H1/H2 均兼容、E2/E3/E4 由模型结果判定、观察快照深复制、schemaVersion 恢复与未知版本回退。
- [x] 测试主动提示层级记录、辅助完成路径和迁移猜错仍能结案。
- [x] 按事件更新阶段和 milestones；避免依赖动画时间判断科学正确性。

### Task 4: 制作原创 2.5D 美术资源

**Files:** Create assets under `miniprogram/assets/` and add `miniprogram/assets/ASSET_NOTES.md`。

- [x] 生成温暖明亮的绘本书房空间场景，构图留出上下安全 UI 区，图中不生成文字。
- [x] 生成透明背景小墨团主姿态素材，保持轮廓与色板统一；其他情绪用短对白和轻微待机动画表达。
- [x] 棱镜、窄缝、透镜、白屏和光谱用 Canvas/矢量绘制，确保光束可按模型实时变化。
- [x] 为场景加入克制的缓慢推近、尘埃微动和器材反馈动效；动效不承载科学判断。
- [x] 检查素材透明边缘、清晰度、文件尺寸并记录哪些是正式生成素材、哪些仍是程序绘制原型。

### Task 5: 完成主线页面与交互

**Files:** Create `miniprogram/pages/home/`, `study/`, `lab/`, `notebook/`, `ending/` 页面及必要组件。

- [x] 入口显示科学长河、当前章节和未开放预告节点，支持开始/继续。
- [x] 书房物件可检查、留下线索标记；初始猜想可选 H1/H2/暂不确定。
- [x] 实验台可选点放置器材、调整棱镜角度/挡板/屏/透镜，显示实时光路；提供记录、撤回、重置、帮助。
- [x] 页面切换与关键发现加入短镜头推近/景深转场，用户可快速跳过，不阻塞实验操作。
- [x] 笔记支持 E1-E4 快照关联解释、初始猜想与当前猜想并列；提示和笔记关闭后恢复实验配置。
- [x] 结案呈现最初猜想、观察与证据、当前认识、牛顿档案和事实/简化/虚构说明。
- [x] 所有关键操作至少 48rpx 点击区域；对话依据实际 band 和模型结果生成，不固定说红光。

### Task 6: 四层提示、反馈和内容复核标注

**Files:** Create/update `miniprogram/content/chapter1.js`, hint/dialog components。

- [x] 为规格列出的八类卡点提供 L1-L4；L4 主动触发并保留另一色带的独立尝试。
- [x] 反馈分别表达器材未对准与证据不足，不因错误猜想、错误预测或用提示扣分。
- [x] 内容档案标明史实、教学模型和虚构；《光学》1704 年出版信息只在通关档案出现。

### Task 7: 集成检查与交付说明

**Files:** Update `README.md`; add any small integration fixes.

- [x] 运行所有核心逻辑自动化测试及 JavaScript 语法/项目配置检查。
- [x] 若微信开发者工具可用，检查新存档完整通关、续玩恢复、窄屏布局、无效光路反馈和笔记/提示往返；未提供工具时在 README 中明确说明。
- [x] README 汇总导入步骤、操作方法、实现范围、验证结果、素材说明和仍需资源（AppID/真机审核/内容审核）。

## Execution Order

Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。界面可使用生成素材；核心物理模型先于实验交互，以保持显示和证据由同一结果驱动。
