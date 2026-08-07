/**
 * PREVIEW — render a sheet of cats to a real PNG so a human (or a model with eyes) can LOOK at it.
 *
 * ══ WHY THIS SCRIPT EXISTS AND IS NOT OPTIONAL ══
 *
 * unitick's NEEDLE v1 was a plausible-looking source grid that "read as a white blob" when it was
 * finally rendered at 96px. Three distinct geometry bugs — a floating horn, a fused head and body,
 * and legs that read as a fringe — had all passed review as ASCII in a source file. They were only
 * ever caught by rendering to a PNG and looking at it.
 *
 * openhood's own record says the same of its mascot: v1 "read as a white blob" and was caught only
 * by looking. And the entire reason this package was rebuilt at 24x24 is that its 16x16 predecessor
 * passed 35 tests and was still called "shit pixel-art mascots" on sight.
 *
 * `ART-DIRECTION.md` §5b makes the demand in as many words: "Rendered to PNG at final size and
 * LOOKED AT before it is called done." Reading the grid in a terminal does not count, because a
 * terminal cell is not square and the eye reads a tall glyph grid differently from a square pixel
 * grid — which is itself a way to ship a stretched sprite.
 *
 * ══ WHAT THE SHEETS SHOW ══
 *
 *   preview.png        — twelve ids x four states, at 32px (the COLONY MAP size) and 96px (the
 *                        DETAIL PORTRAIT size). The main judgement sheet.
 *   preview-poses.png  — every POSTURE and every IDLE FRAME, so the axes that only exist across
 *                        multiple renders can be judged at all. A frame axis is invisible on a
 *                        single-frame sheet by construction.
 *
 * 32px and 96px are both integer multiples of 24 (with 64px as 8/3 — see below), so every grid cell
 * is a whole number of screen pixels. A non-integer multiple resamples the sprite and every
 * judgement made from the render would be about the resampler rather than about the geometry. 64px
 * is requested in the brief and is NOT an integer multiple of 24, so it is drawn at scale 3 (72px)
 * — the nearest integer scale — and labelled honestly rather than resampled.
 *
 * ══ WHY IT HANDS OFF TO PYTHON ══
 *
 * There is no `canvas` package in this workspace and adding a native dependency to look at a sprite
 * would be a poor trade. The grid is emitted as JSON and Pillow paints it — nearest neighbour, no
 * smoothing, which is what §8's anti-aliasing ban requires of the world anyway. The NUMBERS come
 * from `catGrid`; Python only fills rectangles.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAT_FRAMES, catGrid, geometryFor, GRID_H, GRID_W } from "../dist/grid.js";
import { catRamp, STATE_ACCENT } from "../dist/render.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Twelve ids. Deliberately NOT `cat-1`..`cat-12`: sequential ids differing in one trailing character
 * are the WORST case for a hash budget, because a poor mix leaves neighbouring ids looking alike.
 * Half the set is sequential precisely to expose that, and half is unrelated words so the sheet also
 * shows the typical case.
 */
const IDS = [
  "stray-1",
  "stray-2",
  "stray-3",
  "stray-4",
  "0xf00d",
  "0xbeef",
  "mackerel",
  "tortoiseshell",
  "sixpence",
  "harbour",
  "gutter",
  "ledger",
];

const STATES = ["fed", "hunting", "starving", "dead"];

/** oklch() is not something Pillow parses, so any oklch in the palette is converted to sRGB here. */
function oklchToRgb(css) {
  const m = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(css);
  if (!m) throw new Error(`unparsed colour: ${css}`);
  const L = Number(m[1]);
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab -> LMS' -> LMS -> linear sRGB. The standard matrices, written out.
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const mm = m_ ** 3;
  const s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
  const enc = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/** `catRamp` emits `#rrggbb` for pigmented cats; the fallback ramp may emit oklch. */
function toRgb(css) {
  if (css.startsWith("#")) {
    const n = Number.parseInt(css.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return oklchToRgb(css);
}

// The page ground, §3 `--soot`. The sheets are drawn on the real page colour because a sprite judged
// against white is judged against a contrast it will never have.
const SOOT = oklchToRgb("oklch(0.14 0.014 145)");

function cellFor(id, state, frame) {
  const accent = STATE_ACCENT[state];
  const ramp = catRamp(id, state).map(toRgb);
  return {
    id,
    state,
    frame,
    coat: geometryFor(id).coat,
    ramp,
    accent: accent === undefined ? null : oklchToRgb(accent),
    px: catGrid(id, { state, frame }).map((p) => [p.x, p.y, p.step, p.accent === true ? 1 : 0]),
  };
}

/** SHEET 1 — the main judgement sheet: every id x every state, at map size and portrait size. */
const main = {
  gridW: GRID_W,
  gridH: GRID_H,
  soot: SOOT,
  rows: STATES,
  cols: IDS,
  scales: [
    [2, "48px (2x) — colony map"],
    [3, "72px (3x) — mid"],
    [4, "96px (4x) — detail portrait"],
  ],
  cells: [],
};
for (const state of STATES) {
  for (const id of IDS) main.cells.push(cellFor(id, state, 0));
}

/**
 * SHEET 2 — the axes that only exist ACROSS renders.
 *
 * An IDLE FRAME axis is invisible on a single-frame sheet by construction: you cannot see that a
 * tail flicked by looking at one picture of a tail. The ids here are chosen — one per COAT PATTERN —
 * rather than taken from the head of `IDS`, because the whole point is coverage of the axis, and a
 * hash-ordered sample of twelve ids can easily contain no `tortie` at all.
 *
 * The POSTURE axis this sheet used to cover no longer exists. Front-on, a sitting cat and a standing
 * cat differ by about one row of leg, so the four postures were four nearly-identical sprites; the
 * budget they were spending went to head width, cheek fluff and three more pigments. Coat pattern is
 * what replaced them as the axis that most needs deliberate coverage.
 */
const COAT_IDS = (() => {
  const want = ["solid", "tabby", "patched", "tortie"];
  const found = new Map();
  // A deterministic scan over a wide id space, so the sheet covers every coat without any id being
  // hand-picked to flatter the render.
  for (let i = 0; i < 4000 && found.size < want.length; i++) {
    const id = `stray-${i}`;
    const c = geometryFor(id).coat;
    if (want.includes(c) && !found.has(c)) found.set(c, id);
  }
  return want.map((c) => found.get(c) ?? "stray-1");
})();

const poses = {
  gridW: GRID_W,
  gridH: GRID_H,
  soot: SOOT,
  rows: Array.from({ length: CAT_FRAMES }, (_, f) => `frame ${f}`),
  cols: COAT_IDS.map((id) => `${geometryFor(id).coat}`),
  scales: [[5, "120px (5x) — coat patterns across idle frames"]],
  cells: [],
};
for (let frame = 0; frame < CAT_FRAMES; frame++) {
  // `fed` rather than `hunting`: the states override the ear angle, and a sheet meant to show the
  // frame axis should not have a state fighting it.
  for (const id of COAT_IDS) poses.cells.push(cellFor(id, "fed", frame));
}

const PY = `
import json, sys
from PIL import Image, ImageDraw

data = json.load(open(sys.argv[1]))
GW, GH = data["gridW"], data["gridH"]
soot = tuple(data["soot"])
rows, cols = data["rows"], data["cols"]
PAD, LABEL_H, GUTTER = 8, 16, 34

def block_h(s):
    return (GH * s + PAD) * len(rows) + LABEL_H

W = max((GW * s + PAD) * len(cols) for s, _ in data["scales"]) + 2 * PAD + GUTTER
H = sum(block_h(s) for s, _ in data["scales"]) + PAD * (len(data["scales"]) + 1)

img = Image.new("RGB", (W, H), soot)
d = ImageDraw.Draw(img)
LABEL = (110, 130, 108)

cells = data["cells"]
y0 = PAD
for s, title in data["scales"]:
    cw, ch = GW * s + PAD, GH * s + PAD
    d.text((PAD, y0), title, fill=LABEL)
    y = y0 + LABEL_H
    for ri, rname in enumerate(rows):
        d.text((PAD, y + 2), str(rname)[:6], fill=LABEL)
        for ci in range(len(cols)):
            cell = cells[ri * len(cols) + ci]
            ramp = [tuple(c) for c in cell["ramp"]]
            ox = PAD + GUTTER + ci * cw
            for (px, py, step, acc) in cell["px"]:
                col = tuple(cell["accent"]) if (acc and cell["accent"]) else ramp[step]
                x1, y1 = ox + px * s, y + py * s
                d.rectangle([x1, y1, x1 + s - 1, y1 + s - 1], fill=col)
        y += ch
    y0 = y + PAD

img.save(sys.argv[2])
print(f"{W}x{H}")
`;

const dir = mkdtempSync(join(tmpdir(), "cat-preview-"));
const pyPath = join(dir, "draw.py");
writeFileSync(pyPath, PY);

for (const [payload, name] of [
  [main, "preview.png"],
  [poses, "preview-poses.png"],
]) {
  const jsonPath = join(dir, `${name}.json`);
  writeFileSync(jsonPath, JSON.stringify(payload));
  const out = join(here, "..", name);
  const size = execFileSync("python3", [pyPath, jsonPath, out], { encoding: "utf8" }).trim();
  console.log(`preview -> ${out}  (${size})`);
}
