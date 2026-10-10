# 美术资源说明

- `study-room.jpg`：原创生成的牛顿时期书房场景底图，输出 800×1200 JPEG 以控制小程序包体；白屏保持空白，真实彩光只由实验模型绘制。
- `xiaomotuan-small.png`：原创生成的小墨团透明角色主姿态，640px 长边。首版通过轻微浮动动画表达待机，其他情绪由短对白与卡片图标表达。
- `mascot/xiaomotuan-front.png`、`mascot/xiaomotuan-turned.png`：按小墨团既有立绘生成的 3D 玩偶质感透明渲染。恢复原先更俏皮的不对称轮廓，只将暖炭灰身体轻轻提亮；琥珀大眼、摸脸动作和高对比青绿色披风保持不变。两张均为 495×512 RGBA PNG，245,761 与 223,888 bytes；总计 469,649 bytes（约 459 KiB）。组件点按时短暂切换转身态，出错则回退到 `xiaomotuan-small.png`。
- 实验台器材、光路与光谱由程序绘制，便于根据模型状态实时变化。
- `audio/sfx-tap.mp3`：程序合成（点击反馈，单音 880Hz + 3.2kHz 噪声脉冲，~0.18s）。
- `audio/sfx-found.mp3`：程序合成（发现线索，C5–E5–G5–C6 上升琶音 + 钟琴音色，~0.70s）。
- `audio/sfx-hint.mp3`：程序合成（提示气泡，480Hz→220Hz 滑音，~0.30s）。
- `audio/sfx-success.mp3`：程序合成（记录成功，G4–C5–E5 琶音开场后叠 C 大三和弦持续，~0.65s）。
- `audio/ambient-bg.mp3`：Pixabay 配乐"Gentle Documentary Ambient"，作者 JorisVermeer，https://pixabay.com/music/ambient-gentle-documentary-ambient-495383/ ，按 Pixabay Content License 使用。原始 1:33 MP3 转为 32 kHz 单声道 48 kbps 版本，以控制小程序包体；应用中以较低音量循环播放。
- 4 个 sfx-*.mp3 均为本项目的衍生合成资源，无第三方版权负担；脚本在 `/tmp/synth_sfx.py` 可复现。
- 本项目不包含正式品牌商标、史实人物肖像或已完成的商业美术套件；生成素材属于原型视觉，可继续交由插画师统一精修。
