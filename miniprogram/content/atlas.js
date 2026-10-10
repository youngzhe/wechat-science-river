const atlas = [
  { id: 'prism', kind: 'instrument', title: '棱镜', subtitle: '把光里的线索展开', object: 'prism', copy: '透明的三角玻璃能让不同颜色的光偏折不同程度。转动棱镜，观察白屏上的光带怎样变化。', action: '去试试棱镜', mode: 'dispersion' },
  { id: 'screen', kind: 'instrument', title: '白屏', subtitle: '让观察变得清楚', object: 'screen', copy: '白屏接住光束，把光路中的现象变成可以比较的光斑。改变白屏位置，看看颜色是分开还是重叠。', action: '移动白屏看看', mode: 'recombination' },
  { id: 'spectrum', kind: 'knowledge', title: '白光里的色带', subtitle: '光谱观察', evidence: 'E1', copy: '白光经过棱镜可以展开成连续色带。仅凭这一条观察，还不足以比较“棱镜添上颜色”和“白光含有颜色”两种解释。', action: '回看光谱实验', mode: 'dispersion' },
  { id: 'single-color', kind: 'knowledge', title: '方向变了，颜色留下来', subtitle: '单色再试', evidence: 'E2', copy: '在本章教学模型中，一条窄色带经过第二块棱镜，方向改变，颜色仍近似不变。这条证据可以帮助我们比较两种解释。', action: '再试一种颜色', mode: 'selective_refraction' },
  { id: 'transfer-band', kind: 'knowledge', title: '换一种颜色再验证', subtitle: '转移测试', evidence: 'E3', copy: '把窄色带从红色换成蓝或绿，方向同样改变，颜色仍近似不变。这说明"窄带保留颜色"不只对一种颜色成立。', action: '换一种颜色', mode: 'selective_refraction' },
  { id: 'recombine', kind: 'knowledge', title: '分开的光，重新相遇', subtitle: '完整光谱会聚', evidence: 'E4', copy: '完整光谱经过透镜，在合适位置重叠成近白色光斑。遮住一段色带，再对照光斑的变化。', action: '去寻找会聚点', mode: 'recombination' },
];
const regions = [
  { id: 'life', title: '生命的奇迹', subtitle: '生命与自然', copy: '从观察生命的细节出发，探索生命与环境的联系。这里的章节尚未开放。' },
  { id: 'space', title: '星空的密码', subtitle: '星空与宇宙', copy: '抬头看见的星光，藏着哪些可以用观察回答的问题？这里的章节尚未开放。' },
  { id: 'invention', title: '改变世界的发明', subtitle: '技术与工程', copy: '从一个问题到一种工具，探索发明背后的尝试与证据。这里的章节尚未开放。' },
];
module.exports = { atlas, regions };
