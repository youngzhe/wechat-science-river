# Xiaomotuan reference image analysis

Reference: `miniprogram/assets/xiaomotuan-small.png` (619 × 640 RGBA).

## Observed structure and silhouette

- One front-facing, full-body, stylized non-human mascot occupies nearly all of a square frame.
- The head and torso form one continuous pear/teardrop-like organic mass. The upper head is broad and narrows into a short neck; the lower torso is round and tapers toward two short feet.
- Two short rounded arms attach to the lateral upper torso. One arm bends upward toward the cheek; the other rests near the scarf.
- Two tall, leaf/flame-shaped tuft forms attach at the crown, with the larger form in front of the smaller one.
- A broad cloth scarf wraps across the upper torso. Its front band crosses the chest; two long tapered ends project from the rear/lateral region, one visibly extending outward beyond the torso.
- The face has two oversized amber eyes with dark pupils, bright highlights, and pale warm sclera; a small curved mouth and short curved brows sit above the scarf.

## Visible surface and color evidence

- Body/arms/legs: charcoal to warm dark brown albedo with mottled, rough, painterly surface; broad warm edge highlights are baked into the illustration, so exact PBR roughness is uncertain. Model as matte/satin soft soot, not metal.
- Eyes: amber-to-orange irises with dark pupils, pale sclera, and small high-value catchlights. Use a glossier finish than the body.
- Crown tufts: pale warm golden/cream with darker ochre edge shading.
- Scarf: blue-green/teal cloth with visible weave-like mottling and subdued gold/gray shadow marks. User direction for the 3D iteration: keep the cute proportions from the preferred illustration and increase scarf/body color contrast; use a more saturated, brighter teal while keeping the body charcoal.
- Transparent background. Dark and light outline fringe appears in a few edge pixels; do not reproduce it as geometry or render halo.

## Identity features to preserve

1. Round chibi silhouette with oversized head/eyes and compact body.
2. Two uneven flame/leaf crown tufts.
3. Amber eyes with large pupils and friendly expression.
4. Coal-charcoal warm textured body.
5. Stronger, more vivid teal scarf wrapping the chest and extending behind the body.

## Inference and uncertainty

- The image exposes only the front. Back-of-head, rear torso, tuft attachment from behind, scarf knot, scarf underside, and rear limb attachments are hidden/undetermined. These must be labeled stylized invention and kept simple.
- Scarf fabric is inferred from its folds and weave-like surface; exact textile and physically based material values cannot be measured from this image.
- The tuft may be fire/smoke or leaf-like forms; model as soft flame/leaf silhouettes without implying literal fire emission.
- The user refers to two visual variants and prefers the cuter one with stronger scarf contrast. Only one character file is present in this project; preserve its proportions and apply the explicit higher-contrast scarf direction.
