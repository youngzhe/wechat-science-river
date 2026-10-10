const { loadSave, writeSave } = require('../../core/save');
const { simulateOptics, FOCUS_RANGE } = require('../../core/optics');
const { captureObservation, linkEvidence } = require('../../core/notebook');
const { dispatchChapterEvent } = require('../../core/chapter');
const { hints } = require('../../content/chapter1');
const sound = require('../../core/sound');
const { paintOpticsScene } = require('../../core/optics-scene');
const modes = [
  { id: 'dispersion', label: '展开光谱' },
  { id: 'selective_refraction', label: '单色再试' },
  { id: 'recombination', label: '合回白光' },
];
const bandOptions = [
  { id: 'red', label: '红', color: '#d95f50' }, { id: 'orange', label: '橙', color: '#e99047' },
  { id: 'yellow', label: '黄', color: '#e4c65a' }, { id: 'green', label: '绿', color: '#6aa779' },
  { id: 'blue', label: '蓝', color: '#5d89b6' }, { id: 'violet', label: '紫', color: '#8879a8' },
];
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function getInstruction(apparatus, result) {
  if (apparatus.prism1InPath && (apparatus.prism1Angle < 18 || apparatus.prism1Angle > 48)) return { step: '调整光路', title: '把棱镜角度调回有效范围', detail: '用角度两侧的按钮微调，让光线正确穿过棱镜。', target: 'angle' };
  if (apparatus.prism1InPath && !result.lightOnScreen) return { step: '接住光束', title: '移动白屏，让光落在屏上', detail: '左右拖动画面中的白屏，观察光路的变化。', target: 'screen' };
  if (apparatus.mode === 'dispersion') {
    if (!apparatus.prism1InPath) return { step: '第 1 步', title: '把第一块棱镜放进光路', detail: '观察白光经过棱镜后，白屏上留下了什么。', target: 'prism1' };
    if (apparatus.prism1Angle < 18 || apparatus.prism1Angle > 48) return { step: '第 1 步', title: '把棱镜角度调回有效范围', detail: '用角度两侧的按钮微调，再观察白屏。', target: 'angle' };
    if (!result.lightOnScreen) return { step: '第 2 步', title: '移动白屏接住光束', detail: '拖动画面中的白屏，或使用下方滑杆。', target: 'screen' };
    return { step: '观察结果', title: '白屏上出现了什么？', detail: '先描述你看到的色带，再点“记下这次观察”。', target: 'capture' };
  }
  if (apparatus.mode === 'selective_refraction') {
    if (!apparatus.prism1InPath) return { step: '第 1 步', title: '先把第一块棱镜放进光路', detail: '形成光谱后，再从中选一种颜色。', target: 'prism1' };
    if (!apparatus.selectedBand || apparatus.slitWidth > 0.25) return { step: '第 2 步', title: '选一种颜色作为窄色带', detail: '点选下方任意色带；选中后会自动调窄。', target: 'band' };
    if (!apparatus.prism2InPath) return { step: '第 3 步', title: '让窄色带经过第二块棱镜', detail: '留意颜色和前进方向分别发生了什么变化。', target: 'prism2' };
    if (!result.directionChanged) return { step: '第 4 步', title: '把白屏移到第二块棱镜后', detail: '向右移动白屏，接住折转后的窄色带。', target: 'screen' };
    return { step: '观察结果', title: '颜色变了，还是方向变了？', detail: '比较光带前后的颜色与方向，然后记下观察。', target: 'capture' };
  }
  if (!apparatus.prism1InPath) return { step: '第 1 步', title: '先让第一块棱镜展开白光', detail: '完整光谱出现后，再尝试让不同颜色重新会聚。', target: 'prism1' };
  if (!apparatus.lensInPath) return { step: '第 2 步', title: '把透镜放到完整光谱的光路上', detail: '观察透镜能否让分开的颜色重新聚在一起。', target: 'lens' };
  if (apparatus.screenPosition < FOCUS_RANGE[0] || apparatus.screenPosition > FOCUS_RANGE[1]) return { step: '第 3 步', title: '移动白屏寻找会聚位置', detail: '向图中“会聚处”移动白屏，或微调下方滑杆。', target: 'screen' };
  if (apparatus.blockedBands.length) return { step: '对照观察', title: '少一段颜色，光斑有什么不同？', detail: '比较被挡色带前后，点“恢复被挡色带”再观察。', target: 'block' };
  return { step: '观察结果', title: '光斑接近白色了吗？', detail: '记录完整光谱会聚后的观察，再比较挡住一段色带时的变化。', target: 'capture' };
}

Page({
  data: {
    modes, bandOptions, apparatus: {}, result: {}, observationCount: 0, modeHint: '', stageLabel: '可随时撤回和重试', instruction: {},
    showHint: false, hintLevel: 1, hintText: '', blocked: false, slitNarrow: false, muted: false,
  },
  onLoad() {
    this.history = [];
    this.hintBlocker = 'first_spectrum';
    this._canvas = null;
    this._drawTimer = null;
    this._lastDrawAt = 0;
    this.refresh();
  },
  onShow() { const save = loadSave(wx); save.lastPage = 'pages/lab/index'; writeSave(wx, save); this._canvas = null; this.refresh(); this.setData({ muted: sound.isMuted() }); setTimeout(() => this.drawScene(), 60); },
  onUnload() { this._canvas = null; if (this._drawTimer) { clearTimeout(this._drawTimer); this._drawTimer = null; } sound.destroy(); },
  refresh() {
    const save = loadSave(wx);
    const apparatus = save.apparatus;
    const result = simulateOptics(apparatus);
    const modeHint = apparatus.mode === 'dispersion' ? '第一轮 · 让白光穿过棱镜' : apparatus.mode === 'selective_refraction' ? '第二轮 · 选一种窄色带再试' : '补充观察 · 让完整光谱重新会聚';
    const recorded = result.evidenceKind && save.observations.some(o => o.evidenceKind === result.evidenceKind);
    const stageLabel = result.evidenceKind ? (recorded ? `已记录 ${result.evidenceKind}` : `可记录 ${result.evidenceKind}`) : '试一试不同摆法';
    this.setData({ apparatus, result, observationCount: save.observations.length, modeHint, stageLabel, instruction: getInstruction(apparatus, result), blocked: apparatus.blockedBands.length > 0, slitNarrow: apparatus.slitWidth < 0.3 });
  },
  persist(apparatus) {
    let save = loadSave(wx);
    this.history.push(copy(save.apparatus));
    if (this.history.length > 8) this.history.shift();
    save.apparatus = copy(apparatus);
    writeSave(wx, save);
    this.refresh();
    setTimeout(() => this.drawScene(), 40);
  },
  patchApp(patch) { this.persist({ ...this.data.apparatus, ...patch }); },
  chooseMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.hintBlocker = mode === 'selective_refraction' ? 'select_band' : mode === 'recombination' ? 'recombination' : 'first_spectrum';
    sound.play('tap');
    this.patchApp({ mode, prism2InPath: mode === 'selective_refraction' && this.data.apparatus.prism2InPath, lensInPath: mode === 'recombination' && this.data.apparatus.lensInPath, blockedBands: [], slitWidth: mode === 'selective_refraction' ? this.data.apparatus.slitWidth : 1 });
  },
  togglePrism1() { sound.play('tap'); this.patchApp({ prism1InPath: !this.data.apparatus.prism1InPath }); },
  togglePrism2() { sound.play('tap'); this.patchApp({ prism2InPath: !this.data.apparatus.prism2InPath }); },
  toggleLens() { sound.play('tap'); this.patchApp({ lensInPath: !this.data.apparatus.lensInPath }); },
  angleDown() { sound.play('tap'); this.patchApp({ prism1Angle: Math.max(0, this.data.apparatus.prism1Angle - 5) }); },
  angleUp() { sound.play('tap'); this.patchApp({ prism1Angle: Math.min(60, this.data.apparatus.prism1Angle + 5) }); },
  toggleSlit() { sound.play('tap'); this.patchApp({ slitWidth: this.data.apparatus.slitWidth < 0.3 ? 1 : 0.12 }); },
  selectBand(e) { sound.play('tap'); this.patchApp({ selectedBand: e.currentTarget.dataset.band, slitWidth: 0.12 }); },
  toggleBlock() {
    const bands = this.data.apparatus.blockedBands;
    const blockedBands = bands.length ? [] : ['blue'];
    sound.play('tap');
    this.patchApp({ blockedBands });
  },
  moveScreen(e) { this.patchApp({ screenPosition: Number(e.detail.value) }); },
  previewScreen(e) {
    const apparatus = { ...this.data.apparatus, screenPosition: Number(e.detail.value) };
    const result = simulateOptics(apparatus);
    this.setData({ apparatus, result, instruction: getInstruction(apparatus, result), slitNarrow: apparatus.slitWidth < 0.3 });
    this.scheduleDraw();
  },
  scheduleDraw() {
    const now = Date.now();
    if (now - this._lastDrawAt < 60) {
      if (!this._drawTimer) {
        this._drawTimer = setTimeout(() => {
          this._drawTimer = null; this._lastDrawAt = Date.now(); this.drawScene();
        }, 60);
      }
      return;
    }
    this._lastDrawAt = now;
    this.drawScene();
  },
  screenTouchStart(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    this._drag = { startX: typeof t.clientX === 'number' ? t.clientX : t.x, start: this.data.apparatus.screenPosition, moved: false };
  },
  screenTouchMove(e) {
    if (!this._drag) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const x = typeof t.clientX === 'number' ? t.clientX : t.x;
    const width = (this._canvas && this._canvas.width) || 320;
    if (Math.abs(x - this._drag.startX) > 3) this._drag.moved = true;
    let next = this._drag.start + ((x - this._drag.startX) / width) * 0.9;
    next = Math.min(0.95, Math.max(0.1, Math.round(next * 20) / 20));
    const apparatus = { ...this.data.apparatus, screenPosition: next };
    const result = simulateOptics(apparatus);
    this.setData({ apparatus, result, instruction: getInstruction(apparatus, result) });
    this.scheduleDraw();
  },
  screenTouchEnd() {
    if (!this._drag) return;
    const moved = this._drag.moved;
    this._drag = null;
    if (moved) this.persist(this.data.apparatus);
  },
  capture() {
    const result = simulateOptics(this.data.apparatus);
    let save = loadSave(wx);
    const captured = captureObservation(save, result);
    save = captured.save;
    writeSave(wx, save);
    sound.play(result.evidenceKind ? 'success' : 'tap');
    this.setData({ observationCount: save.observations.length, result, stageLabel: result.evidenceKind ? `已记录 ${result.evidenceKind}` : '已记录一次尝试', instruction: { step: '继续观察', title: '这条记录保存在笔记里', detail: '试试调整一种器材，看看观察结果会不会改变。', target: '' } });
    this.drawScene();
    wx.showToast({ title: result.evidenceKind ? `记下 ${result.evidenceKind}` : '尝试已记入笔记', icon: 'success' });
  },
  undo() {
    if (!this.history.length) { wx.showToast({ title: '暂时没有可撤回的设置', icon: 'none' }); return; }
    const previous = this.history.pop();
    const save = loadSave(wx); save.apparatus = previous; writeSave(wx, save); this.refresh();
    setTimeout(() => this.drawScene(), 40);
  },
  resetLab() {
    const save = loadSave(wx);
    const reset = { ...save.apparatus, prism1InPath: false, prism1Angle: 30, prism2InPath: false, lensInPath: false, slitWidth: 1, selectedBand: null, screenPosition: 0.82, blockedBands: [] };
    this.persist(reset);
    wx.showToast({ title: '器材已复位，笔记仍然保留', icon: 'none' });
  },
  blocker() {
    const a = this.data.apparatus;
    if (!a.prism1InPath || a.prism1Angle < 18 || a.prism1Angle > 48) return 'first_spectrum';
    if (a.mode === 'selective_refraction' && a.slitWidth > 0.25) return 'select_band';
    if (a.mode === 'selective_refraction' && !a.prism2InPath) return 'second_prism';
    if (a.mode === 'recombination') return 'recombination';
    if (this.data.result.evidenceKind === 'E1') return 'compare_e1';
    if (this.data.result.evidenceKind === 'E2' || this.data.result.evidenceKind === 'E3') return 'link_evidence';
    return 'transfer';
  },
  requestHint() {
    this.hintBlocker = this.blocker();
    let save = dispatchChapterEvent(loadSave(wx), { type: 'request_hint', blocker: this.hintBlocker });
    const record = save.hintsByBlocker[this.hintBlocker] || { highestLevel: 0 };
    const hintLevel = Math.min(record.highestLevel + 1, 4);
    this.showHint = true;
    sound.play('hint');
    this.setData({ showHint: true, hintLevel, hintText: hints[this.hintBlocker][hintLevel - 1] });
    save.hintsByBlocker[this.hintBlocker] = { highestLevel: hintLevel };
    writeSave(wx, save);
    if (hintLevel === 4) this.applyGuidedSetup();
  },
  deeperHint() {
    const save = loadSave(wx);
    const record = save.hintsByBlocker[this.hintBlocker] || { highestLevel: 1 };
    const hintLevel = Math.min(record.highestLevel + 1, 4);
    sound.play('hint');
    save.hintsByBlocker[this.hintBlocker] = { highestLevel: hintLevel };
    writeSave(wx, save);
    this.setData({ hintLevel, hintText: hints[this.hintBlocker][hintLevel - 1] });
    if (hintLevel === 4) this.applyGuidedSetup();
  },
  applyGuidedSetup() {
    const save = loadSave(wx); const a = save.apparatus;
    if (this.hintBlocker === 'compare_e1') {
      const first = save.observations.find((item) => item.evidenceKind === 'E1');
      if (first) {
        let next = linkEvidence(save, first.id, 'prism_creates_colors', 'compatible');
        next = linkEvidence(next, first.id, 'white_contains_colors', 'compatible');
        writeSave(wx, next);
      }
      return;
    }
    if (this.hintBlocker === 'link_evidence') {
      const evidence = [...save.observations].reverse().find((item) => item.evidenceKind === 'E2' || item.evidenceKind === 'E3');
      if (evidence && save.currentHypothesis) writeSave(wx, linkEvidence(save, evidence.id, save.currentHypothesis, 'supports_comparison'));
      return;
    }
    const guided = { ...a, prism1InPath: true, prism1Angle: 30, blockedBands: [] };
    if (this.hintBlocker === 'first_spectrum') Object.assign(guided, { mode: 'dispersion' });
    if (this.hintBlocker === 'select_band' || this.hintBlocker === 'second_prism') Object.assign(guided, { mode: 'selective_refraction', slitWidth: .12, selectedBand: 'red', prism2InPath: true, lensInPath: false });
    if (this.hintBlocker === 'recombination') Object.assign(guided, { mode: 'recombination', lensInPath: true, screenPosition: .82 });
    if (this.hintBlocker === 'transfer') Object.assign(guided, { mode: 'selective_refraction', slitWidth: .12, selectedBand: a.selectedBand === 'blue' ? 'green' : 'blue', prism2InPath: true, lensInPath: false });
    this.patchApp(guided);
  },
  closeHint() { this.setData({ showHint: false }); },
  stopTap() {},
  toggleSound() { this.setData({ muted: sound.toggleMuted() }); },
  openNotebook() { sound.play('tap'); wx.navigateTo({ url: '/pages/notebook/index' }); },
  drawScene() {
    if (this._canvas && this._canvas.node) {
      const { node, width, height, dpr } = this._canvas;
      const ctx = node.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, node.width, node.height);
      ctx.scale(dpr, dpr);
      this.paintScene(ctx, width, height);
      return;
    }
    const query = wx.createSelectorQuery();
    query.select('#optics').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const { node, width, height } = res[0];
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio) || 1;
      node.width = width * dpr; node.height = height * dpr;
      this._canvas = { node, width, height, dpr };
      const ctx = node.getContext('2d'); ctx.scale(dpr, dpr);
      this.paintScene(ctx, width, height);
    });
  },
  paintScene(ctx, w, h) { paintOpticsScene(ctx, w, h, this.data.apparatus); },
});
