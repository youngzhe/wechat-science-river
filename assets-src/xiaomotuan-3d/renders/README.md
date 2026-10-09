# 小墨团 3D 风格渲染资源

小程序使用透明预渲染 PNG，不在微信运行时执行 Three.js。当前有正面主姿态和三分之四转身姿态，原尺寸生成稿保存在 `source/`；轻量导出在 `miniprogram/assets/mascot/`。

## 视觉约束

- 以 `miniprogram/assets/xiaomotuan-small.png` 为唯一角色参考，保留圆润两头身、琥珀大眼、双叶火苗冠、摸脸动作和小脚。
- 保留原先较俏皮的不对称头身轮廓；身体维持暖炭灰，仅轻轻提亮至约 `#493B33`，不要把头部改成规整大圆球。围巾为明显更亮、更饱和的青绿色，两个飘带末端清晰分开。
- 用柔和影棚主光、补光和轮廓光；透明底并保留轻微脚下接触影。
- 不加入环境、文字、道具、额外肢体或新配饰。

## 导出规格

生成稿在 1024px 方形画布；小程序导出缩放至 512px 长边（实际 495×512），以 255 色 RGB 自适应调色并保留原始 alpha，PNG optimize。当前保形轻提亮版导出分别为 245,761 bytes 和 223,888 bytes，总计 469,649 bytes（约 459 KiB）。

透明边缘已合成到浅色 `evidence/render-review/xiaomotuan-front-light.jpg` 和深色 `evidence/render-review/xiaomotuan-turned-dark.jpg` 检查，未见剪裁或明显白边。每张 3D 风格图像加载失败时，组件回退到既有 `xiaomotuan-small.png`。

生成提示的核心语句：

> Polished 3D collectible-toy interpretation of the same tiny soot spirit Xiaomotuan; preserve the canonical reference's cute chibi silhouette, oversized amber eyes, two uneven cream flame/leaf tufts, raised paw touching cheek, rounded feet and gentle smile. Use a vivid saturated teal scarf clearly brighter than the charcoal body, with two distinct flowing tails and tactile cloth folds. Transparent studio cutout, soft key/fill/rim lighting, centered full-body, subtle contained contact shadow, no props, text, border or watermark.

图像生成是非确定性的；后续迭代以两张原尺寸稿为基础，并遵守以上角色约束。若要可编辑网格或自由旋转视角，仍需继续完成 `xiaomotuan-sculpt-spec.json` 对应的 procedural Three.js 构建与完整质量门。
