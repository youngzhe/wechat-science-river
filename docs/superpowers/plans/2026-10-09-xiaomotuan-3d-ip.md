# 小墨团 3D IP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, stylized 3D source model of 小墨团, render a small set of transparent angles, and integrate those renders into the mini-program with the original 2D art as a fallback.

**Architecture:** Use `img2threejs` to author and quality-gate a procedural Three.js model in project-owned source assets, then render transparent stills offline. A shared native mini-program mascot component selects the front or turned render and falls back to the existing PNG if a frame fails; no Three.js runtime or GLB ships in the mini-program.

**Tech Stack:** Existing native WeChat Mini Program (JavaScript/WXML/WXSS), `img2threejs` procedural Three.js pipeline, offline transparent PNG renders.

**Spec:** `docs/superpowers/specs/2026-10-09-xiaomotuan-3d-ip-design.md`

## Global Constraints

- Preserve the established coal-gray rounded body, amber eyes, crown tuft, and teal scarf.
- Treat side and back surfaces as stylized invention because the reference is a single front image.
- Keep 3D reconstruction source and repeatable render instructions outside `miniprogram/`; only required PNGs go under the mini-program root.
- Do not add Three.js/WebGL to the mini-program runtime; retain `xiaomotuan-small.png` as fallback.
- Keep the scope to a small set of polished angles and a tap-to-turn interaction; no free 360-degree viewer, rig, voice, or full expression system.
- If `img2threejs` reports a hard stop or a required stage cannot be verified, preserve the current 2D asset and report the blocker rather than skipping the gate.

## Review Focus

- **Single-view ambiguity:** hidden back and scarf construction can diverge from the existing IP; verify front/side/back review renders and document inferred details.
- **Transparent render edges:** alpha halos, floor clipping, and shadows can look like cutout defects on dark and light UI; inspect renders over both backgrounds.
- **Asset weight:** multiple texture-heavy PNGs can grow the first package; measure all added PNGs and reduce render size/compression before adding frames.
- **Shared component fallback:** a missing or failed angle must recover to the original PNG without leaving a blank role slot.
- **Touch and layout:** tapping the avatar must not block adjacent text/buttons or shift safe-area layouts on the home, study, and ending pages.

---

### Task 1: Create and quality-gate the reusable character model

**Files:**
- Create: `assets-src/xiaomotuan-3d/.img2threejs/state.json`
- Create: `assets-src/xiaomotuan-3d/assessment.json`
- Create: `assets-src/xiaomotuan-3d/xiaomotuan-sculpt-spec.json`
- Create: `assets-src/xiaomotuan-3d/src/createXiaomotuanModel.ts`
- Create: `assets-src/xiaomotuan-3d/evidence/` (stage renders, contact sheets, and gate reports)
- Reference: `miniprogram/assets/xiaomotuan-small.png`

**Interfaces:**
- Produces a deterministic Three.js `Group` factory named `createXiaomotuanModel()` and a quality-gated stylized character source model for offline rendering.
- All state transitions and required validation commands follow the installed `img2threejs/SKILL.md`; the source reference remains the mini-program PNG.

- [ ] **Step 1: Analyze and probe the reference image**

Run the skill's mandatory image analysis and metadata probe against `miniprogram/assets/xiaomotuan-small.png`. Record identity-defining features (silhouette, eyes, tuft, scarf, feet/arms), visible material cues, and hidden-view uncertainty in `assessment.json`.

- [ ] **Step 2: Initialize the local quality-gate state and pre-spec assessment**

Run `python3 <img2threejs>/forge/state.py init --state assets-src/xiaomotuan-3d/.img2threejs/state.json --reference miniprogram/assets/xiaomotuan-small.png --profile character --spec assets-src/xiaomotuan-3d/xiaomotuan-sculpt-spec.json`, then use `forge/next.py` before each required action. Run the installed pre-spec and local-spec-search commands from the skill. Use the character route because the mascot has a clear character silhouette (head, face, arms, and feet); record it as a non-human chibi with stylized proportions rather than imposing human anatomy.

- [ ] **Step 3: Author and strict-validate the sculpt specification**

Define a rounded soft body, short limbs, large inset amber eyes, small curved mouth, top tuft, and separate scarf with readable trailing ends. Set a real-time-asset triangle budget, transparent render requirement, front/three-quarter/profile/rear review views, and the quality contract. Run normal and strict-quality validators; resolve every blocking finding before code generation.

- [ ] **Step 4: Build the model in locked passes**

Follow the skill's `orchestrate_passes.py status`/`generate_threejs_factory.py`/review loop for blockout, structure, form, material, lighting, interaction, and optimization. Keep geometry and material decisions in `xiaomotuan-sculpt-spec.json`; use warm charcoal roughness, amber eye gloss, and muted teal cloth. Every pass requires a render, deterministic gates, a comparison sheet inspected against the source, and a recorded pass decision before continuing.

- [ ] **Step 5: Verify multiple angles and character silhouette**

Capture front, three-quarter, side, and rear views. Run the skill's applicable deterministic geometry and turntable gates, inspect the comparison sheet, and record inferred back-of-head/body/scarf details as stylized additions. Stop and refine the active pass if the front identity or off-axis silhouette is wrong.

- [ ] **Step 6: Record the gated source-model deliverable**

Run the skill's final pass/state checks. Save review history and all evidence under `assets-src/xiaomotuan-3d/evidence/`; do not begin application integration if the required model gates have not passed.

### Task 2: Render and budget transparent character angles

**Files:**
- Create: `assets-src/xiaomotuan-3d/render/README.md`
- Create: `miniprogram/assets/mascot/xiaomotuan-front.png`
- Create: `miniprogram/assets/mascot/xiaomotuan-turned.png`
- Create: `miniprogram/assets/mascot/xiaomotuan-rear.png` (only if used by interaction)
- Modify: `miniprogram/assets/ASSET_NOTES.md`

**Interfaces:**
- `xiaomotuan-front.png` is the primary transparent front render.
- `xiaomotuan-turned.png` is a readable three-quarter/look-back render used on tap.
- The rear render is optional and must not be packaged unless a UI state uses it.

- [ ] **Step 1: Write a repeatable offline render recipe**

Document how to instantiate `createXiaomotuanModel()` with the fixed orthographic camera, transparent background, soft key/fill/rim lights, output framing, and the two required angles. Store camera and lighting values with the render recipe so regenerated art is consistent.

- [x] **Step 2: Render transparent PNGs and inspect alpha edges**

Render front and turned views at a bounded resolution appropriate for the current 206rpx hero display. Inspect each over both a light and dark checker/background for halos, clipping, lost scarf silhouette, grounding, and shadow softness. Refine and rerender if any defect is visible.

- [x] **Step 3: Measure package weight and tune output**

Measure the total bytes for packaged mascot frames. Keep the added role frames at or below 500 KB where feasible by reducing render dimensions and optimizing PNG palette/alpha. If the quality floor cannot fit that budget, keep only the front and one turned image or use the original 2D file for the compact dialogue slot. Record actual dimensions, byte sizes, and fallback behavior in `ASSET_NOTES.md`.

### Task 3: Add one shared native mascot component with fallback

**Files:**
- Create: `miniprogram/components/mascot/index.js`
- Create: `miniprogram/components/mascot/index.json`
- Create: `miniprogram/components/mascot/index.wxml`
- Create: `miniprogram/components/mascot/index.wxss`

**Interfaces:**
- Component properties: `compact` (Boolean, default `false`) and `interactive` (Boolean, default `true`).
- Component behavior: show the front render initially; on tap, show the turned render for 900 ms, then return to front; if either render raises an image error, show `/assets/xiaomotuan-small.png`.
- The component exposes no model or renderer runtime API to pages.

- [x] **Step 1: Implement the shared mascot component**

Use a single `<image>` with accessible name/role, common idle bob, `compact` sizing, tap-to-turn timer, and `binderror` fallback. Clear the timer in component detach to prevent a stale callback. Keep image paths centralized in `index.js`.

### Task 4: Replace page-specific mascot images and verify integration

**Files:**
- Modify: `miniprogram/pages/home/index.json`
- Modify: `miniprogram/pages/home/index.wxml`
- Modify: `miniprogram/pages/home/index.wxss`
- Modify: `miniprogram/pages/study/index.json`
- Modify: `miniprogram/pages/study/index.wxml`
- Modify: `miniprogram/pages/study/index.wxss`
- Modify: `miniprogram/pages/ending/index.json`
- Modify: `miniprogram/pages/ending/index.wxml`
- Modify: `miniprogram/pages/ending/index.wxss`

**Interfaces:**
- All three pages register the same `/components/mascot/index` component.
- Home and ending use default hero sizing; study dialogue and intro use `compact` sizing.

- [x] **Step 1: Register and mount the shared component**

Replace page-specific mascot `<image>` nodes with the shared component, preserving the existing placements, z-order, safe-area layout, and 2D fallback in component logic. Do not change story copy or experiment flow.

- [x] **Step 2: Verify project integration and page behavior**

In WeChat DevTools if available, inspect home/study/ending, tap behavior, compact layout, safe areas, and image fallback. Record the result in the README; if DevTools is unavailable, report that limitation without claiming simulator verification. Preserve the project's existing test files without adding a new automated test suite for this visual integration.
