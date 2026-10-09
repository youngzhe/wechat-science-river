const { loadSave, writeSave } = require('../../core/save');
const { simulateOptics, BAND_NAMES } = require('../../core/optics');
const { captureObservation, linkEvidence } = require('../../core/notebook');
const { dispatchChapterEvent } = require('../../core/chapter');
const { hints } = require('../../content/chapter1');
const sound = require('../../core/sound');
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

Page({
  data: {
    modes, bandOptions, apparatus: {}, result: {}, observationCount: 0, modeHint: '', stageLabel: '可随时撤回和重试',
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
  onShow() { this._canvas = null; this.refresh(); this.setData({ muted: sound.isMuted() }); setTimeout(() => this.drawScene(), 60); },
  onUnload() { this._canvas = null; if (this._drawTimer) { clearTimeout(this._drawTimer); this._drawTimer = null; } },
  refresh() {
    const save = loadSave(wx);
    const apparatus = save.apparatus;
    const result = simulateOptics(apparatus);
    const modeHint = apparatus.mode === 'dispersion' ? '第一轮 · 让白光穿过棱镜' : apparatus.mode === 'selective_refraction' ? '第二轮 · 选一种窄色带再试' : '补充观察 · 让完整光谱重新会聚';
    const stageLabel = result.evidenceKind ? `已观察到 ${result.evidenceKind}` : '试一试不同摆法';
    this.setData({ apparatus, result, observationCount: save.observations.length, modeHint, stageLabel, blocked: apparatus.blockedBands.length > 0, slitNarrow: apparatus.slitWidth < 0.3 });
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
    this.patchApp({ mode });
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
    this.setData({ apparatus, result: simulateOptics(apparatus), slitNarrow: apparatus.slitWidth < 0.3 });
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
    this.setData({ apparatus, result: simulateOptics(apparatus) });
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
    if (result.evidenceKind === 'E4' && !save.completedMilestones.includes('E4')) save.completedMilestones.push('E4');
    writeSave(wx, save);
    sound.play(result.evidenceKind ? 'success' : 'tap');
    this.setData({ observationCount: save.observations.length, result, stageLabel: result.evidenceKind ? `已记录 ${result.evidenceKind}` : '已记录一次尝试' });
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
  paintScene(ctx, w, h) {
      const a = this.data.apparatus; const result = this.data.result;
      ctx.fillStyle = '#f1e9d8'; ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w * .42, h * .48, 3, w * .45, h * .5, w * .62);
      glow.addColorStop(0, '#fffdf5'); glow.addColorStop(1, '#e8dfcb'); ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      const cy = h * .52; const prismX = w * .38; const screenX = w * (.18 + a.screenPosition * .82);
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#fffdf5'; ctx.lineWidth = 6; ctx.shadowColor = '#fff'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(w * .06, cy); ctx.lineTo(prismX, cy); ctx.stroke(); ctx.shadowBlur = 0;
      if (a.prism1InPath) {
        ctx.save(); ctx.translate(prismX, cy); ctx.rotate((a.prism1Angle - 30) * Math.PI / 180);
        ctx.beginPath(); ctx.moveTo(-16, 24); ctx.lineTo(0, -26); ctx.lineTo(18, 24); ctx.closePath();
        ctx.fillStyle = 'rgba(135,197,202,.36)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#527f88'; ctx.stroke(); ctx.restore();
        if (result.lightOnScreen && a.mode === 'selective_refraction' && a.selectedBand && a.slitWidth < .3) {
          const col = bandOptions.find((b) => b.id === a.selectedBand).color;
          ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.shadowColor = col; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.moveTo(prismX + 18, cy); ctx.lineTo(screenX - (a.prism2InPath ? w * .2 : 0), cy - 12 + result.pathOffset); ctx.stroke(); ctx.shadowBlur = 0;
          if (a.prism2InPath) {
            const x = screenX - w * .2;
            ctx.beginPath(); ctx.moveTo(x, cy - 26); ctx.lineTo(x - 12, cy + 8); ctx.lineTo(x + 12, cy + 8); ctx.closePath(); ctx.fillStyle = 'rgba(135,197,202,.45)'; ctx.fill(); ctx.strokeStyle = '#527f88'; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x + 12, cy - 2 + result.pathOffset); ctx.lineTo(screenX, cy - 30 + result.pathOffset); ctx.stroke();
          }
        } else if (result.lightOnScreen) {
          const colors = ['#d95f50','#e99047','#e4c65a','#6aa779','#5d89b6','#8879a8'];
          const drawColors = result.bands.map((band) => ({ band, color: bandOptions.find((b) => b.id === band).color }));
          if (a.mode === 'recombination' && a.lensInPath) {
            const xLens = w * .58;
            colors.forEach((col, i) => { const y = cy - 45 + i * 18; if (a.blockedBands.includes(bandOptions[i].id)) return; ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(prismX + 18, y); ctx.lineTo(xLens, y); ctx.lineTo(screenX, cy); ctx.stroke(); });
            ctx.beginPath(); ctx.ellipse(xLens, cy, 5, 26, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(137,194,200,.55)'; ctx.fill(); ctx.strokeStyle = '#557c84'; ctx.stroke();
          } else if (a.mode === 'dispersion' || !a.selectedBand || a.slitWidth > .25) {
            const spectrum = ctx.createLinearGradient(0, cy - 50, 0, cy + 50);
            [[0,'#d95f50'],[.18,'#e99047'],[.36,'#e4c65a'],[.54,'#6aa779'],[.72,'#5d89b6'],[1,'#8879a8']].forEach(([stop,color]) => spectrum.addColorStop(stop,color));
            ctx.beginPath(); ctx.moveTo(prismX + 18, cy - 3); ctx.lineTo(screenX, cy - 52 + result.pathOffset); ctx.lineTo(screenX, cy + 52 + result.pathOffset); ctx.closePath();
            ctx.fillStyle = spectrum; ctx.globalAlpha = .78; ctx.shadowColor = '#f8dba6'; ctx.shadowBlur = 8; ctx.fill(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
          } else {
            drawColors.forEach(({ band, color }) => { const i = bandOptions.findIndex((b) => b.id === band); const y = cy - 48 + i * 19 + result.pathOffset; if (a.blockedBands.includes(band)) return; ctx.strokeStyle = color; ctx.lineWidth = 3.6; ctx.beginPath(); ctx.moveTo(prismX + 18, cy); ctx.lineTo(screenX, y); ctx.stroke(); });
          }
        }
      }
      if (a.mode === 'recombination' && a.lensInPath && !a.prism1InPath && result.lightOnScreen) {
        const xLens = w * .58; ctx.beginPath(); ctx.ellipse(xLens, cy, 5, 26, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(137,194,200,.55)'; ctx.fill();
      }
      ctx.fillStyle = '#fffdf7'; ctx.fillRect(screenX, cy - 62, 12, 124); ctx.strokeStyle = '#7f725c'; ctx.lineWidth = 2; ctx.strokeRect(screenX, cy - 62, 12, 124);
      if (result.resultKind === 'spectrum') {
        const screenSpectrum = ctx.createLinearGradient(0, cy - 50, 0, cy + 50);
        [[0,'#d95f50'],[.18,'#e99047'],[.36,'#e4c65a'],[.54,'#6aa779'],[.72,'#5d89b6'],[1,'#8879a8']].forEach(([stop,color]) => screenSpectrum.addColorStop(stop,color));
        ctx.fillStyle = screenSpectrum; ctx.globalAlpha = .76; ctx.fillRect(screenX + 2, cy - 50, 8, 100); ctx.globalAlpha = 1;
      } else if (result.resultKind === 'partial_overlap') {
        result.bands.forEach((band) => { const i = bandOptions.findIndex((b) => b.id === band); ctx.fillStyle = bandOptions[i].color; ctx.globalAlpha = .62; ctx.fillRect(screenX + 2, cy - 48 + i * 18, 8, 15); }); ctx.globalAlpha = 1;
      }
      if (result.resultKind === 'near_white_overlap') { ctx.fillStyle = '#fff8dc'; ctx.shadowColor = '#fff6cf'; ctx.shadowBlur = 20; ctx.beginPath(); ctx.ellipse(screenX + 7, cy, 13, 12, 0, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; }
      if (a.mode === 'selective_refraction' && !a.prism2InPath && a.selectedBand && result.lightOnScreen) { const x = screenX - w * .2; ctx.fillStyle = '#4a6266'; ctx.fillRect(x - 2, cy - 30, 4, 60); }
  },
});
