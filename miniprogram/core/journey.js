const { atlas } = require('../content/atlas');
const ALLOWED_PAGES = ['pages/study/index', 'pages/lab/index', 'pages/notebook/index'];
function chapterDestination(save) {
  if (save.completed) return '/pages/ending/index';
  if (ALLOWED_PAGES.includes(save.lastPage)) return '/' + save.lastPage;
  return save.observations.length ? '/pages/lab/index' : '/pages/study/index';
}
function buildJourney(save) {
  const has = id => save.completedMilestones.includes(id) || save.observations.some(o => o.evidenceKind === id);
  const steps = [
    { title: '调查书房', detail: '认识器材，留下最初的猜想', done: save.inspectedObjects.length >= 4 && !!save.currentHypothesis },
    { title: '展开光谱', detail: '记录白光通过第一块棱镜的观察', done: has('E1') },
    { title: '单色再试', detail: '比较窄色带经过第二块棱镜的变化', done: has('E2') && has('E3') },
    { title: '让颜色相遇', detail: '用透镜寻找近白色光斑', done: has('E4') },
    { title: '预测与验证', detail: '换一种颜色，验证自己的预测', done: save.completedMilestones.includes('transfer_observation') },
    { title: '整理发现档案', detail: '关联证据，回顾想法怎样改变', done: save.completed },
  ];
  const firstPending = steps.findIndex(step => !step.done);
  steps.forEach((step, index) => { step.current = index === firstPending; step.number = index + 1; });
  const completedSteps = steps.filter(s => s.done).length;
  const seen = save.observations.length || save.inspectedObjects.length;
  return {
    steps, completedSteps, progress: Math.round(completedSteps / steps.length * 100),
    currentGoal: firstPending < 0 ? '这段发现之旅已完成，随时可以回顾' : steps[firstPending].detail,
    chapterStatus: save.completed ? '档案已完成' : seen ? '调查进行中' : '等待你的第一项发现',
    continueLabel: save.completed ? '查看发现档案' : seen ? '继续探索' : '开始探索',
    discoveries: save.observations.slice().reverse().map(o => ({ ...o, title: o.evidenceKind ? '发现 ' + o.evidenceKind : '一次探索尝试', modeLabel: {dispersion:'展开光谱',selective_refraction:'单色再试',recombination:'合回白光'}[o.apparatusSnapshot.mode] || '实验观察' })),
    atlas: atlas.map(item => ({ ...item, unlocked: item.kind === 'instrument' || has(item.evidence), status: item.kind === 'instrument' ? '器材手册' : has(item.evidence) ? '已点亮' : '待发现', lockHint: '记录对应实验观察后点亮' })),
  };
}
module.exports = { buildJourney, chapterDestination };
