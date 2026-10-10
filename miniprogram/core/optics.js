const LAYOUT = { prism: .22, slit: .40, prism2: .52, lens: .50, screenOrigin: .18, screenTravel: .82, focusPosition: .62 };
const FOCUS_RANGE = [.58, .66];
const BANDS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet'];
const BAND_NAMES = { red: '红', orange: '橙', yellow: '黄', green: '绿', blue: '蓝', violet: '紫' };

function validAngle(angle) {
  return Number.isFinite(angle) && angle >= 18 && angle <= 48;
}

function simulateOptics(state) {
  const blocked = Array.isArray(state.blockedBands) ? state.blockedBands : [];
  const result = {
    resultKind: 'other', evidenceKind: null, bands: [], selectedBand: state.selectedBand || null,
    lightOnScreen: false, directionChanged: false, pathOffset: (state.prism1Angle - 30) * 1.5, message: '光路还没有形成可观察的结果。',
  };
  if (!state.prism1InPath || !validAngle(state.prism1Angle)) {
    result.resultKind = state.screenPosition < 0.12 ? 'no_light_on_screen' : 'other';
    result.message = '光线还没有正确穿过第一块棱镜。';
    return result;
  }
  if (state.screenPosition < 0.25 || state.screenPosition > 0.96) {
    result.resultKind = 'no_light_on_screen';
    result.message = '光束没有落到白屏上，试着调整屏幕位置。';
    return result;
  }

  if (state.mode === 'dispersion') {
    result.bands = BANDS.filter((band) => !blocked.includes(band));
    result.lightOnScreen = result.bands.length > 0;
    result.resultKind = result.bands.length === BANDS.length ? 'spectrum' : 'partial_overlap';
    result.evidenceKind = result.resultKind === 'spectrum' ? 'E1' : null;
    result.message = result.resultKind === 'spectrum'
      ? '白光在屏上展开成连续色带。这个现象仍符合两种解释。'
      : '屏上只接到部分色带；移动挡板看看完整光谱。';
    return result;
  }

  if (state.mode === 'selective_refraction') {
    if (!state.selectedBand || !BANDS.includes(state.selectedBand) || state.slitWidth > 0.25) {
      result.resultKind = 'spectrum';
      result.bands = BANDS.filter((band) => !blocked.includes(band));
      result.lightOnScreen = result.bands.length > 0;
      result.message = '先把窄缝对准一种颜色，再观察它经过第二块棱镜的变化。';
      return result;
    }
    if (state.prism2InPath && LAYOUT.screenOrigin + state.screenPosition * LAYOUT.screenTravel <= LAYOUT.prism2) {
      result.bands = [state.selectedBand]; result.lightOnScreen = !blocked.includes(state.selectedBand);
      result.message = '白屏还在第二块棱镜前，向右移动白屏，接住折转后的光束。';
      return result;
    }
    if (!state.prism2InPath) {
      result.bands = [state.selectedBand];
      result.lightOnScreen = !blocked.includes(state.selectedBand);
      result.message = '窄色带已经选出，把第二块棱镜放到光路上继续观察。';
      return result;
    }
    if (blocked.includes(state.selectedBand)) {
      result.resultKind = 'no_light_on_screen';
      result.message = '挡板遮住了选中的色带。';
      return result;
    }
    result.resultKind = 'band_refracted';
    result.bands = [state.selectedBand];
    result.lightOnScreen = true;
    result.directionChanged = true;
    result.evidenceKind = state.selectedBand === 'red' ? 'E2' : 'E3';
    result.message = `${BAND_NAMES[state.selectedBand]}色窄光带改变了方向，颜色仍保持近似不变。`;
    return result;
  }

  if (state.mode === 'recombination') {
    const complete = BANDS.every((band) => !blocked.includes(band));
    const focusedScreen = state.screenPosition >= FOCUS_RANGE[0] && state.screenPosition <= FOCUS_RANGE[1];
    if (state.lensInPath && complete && focusedScreen) {
      result.resultKind = 'near_white_overlap';
      result.bands = BANDS.slice();
      result.lightOnScreen = true;
      result.evidenceKind = 'E4';
      result.message = '完整色带经透镜会聚，在屏上重叠成近白色光斑。';
      return result;
    }
    result.resultKind = complete ? 'spectrum' : 'partial_overlap';
    result.bands = BANDS.filter((band) => !blocked.includes(band));
    result.lightOnScreen = result.bands.length > 0;
    result.message = !state.lensInPath
      ? '屏上仍能看见分开的色带；试着让完整光谱经过透镜。'
      : !complete ? '有一段色带被挡住，屏上的重叠色光不会是完整白光。' : '调整透镜和屏幕，让光谱在屏上会聚。';
    return result;
  }
  return result;
}

module.exports = { BANDS, BAND_NAMES, LAYOUT, FOCUS_RANGE, simulateOptics };
