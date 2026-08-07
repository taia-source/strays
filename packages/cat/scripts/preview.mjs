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
 * `ART-DIRECTION.md` §5b makes the same demand of this sprite in as many words: "Rendered to PNG at
 * final size and LOOKED AT before it is called done." Reading the grid in a terminal does not
 * count, because a terminal cell is not square and the eye reads a tall glyph grid differently from
 * a square pixel grid — which is itself a way to ship a stretched sprite.
 *
 * ══ WHAT THE SHEET SHOWS, AND WHY THESE SIZES ══
 *
 * Twelve ids across four states, drawn at BOTH sizes the product actually uses:
 *
 *   - 32px — the COLONY MAP size. This is the size the sprite has to survive; §9 names "30 cats
 *     read as 30 identical smudges" as the second-likeliest way this whole product fails. If the
 *     ears and tail do not separate the cats HERE, the hash budget is wrong.
 *   - 96px — the DETAIL PORTRAIT size, where the shading, the neck break and the inner-ear wedge
 *     are actually visible and can be judged.
 *
 * Both are integer multiples of 16 (2x and 6x), so every grid pixel is a whole number of screen
 * pixels. A non-integer multiple resamples the sprite and every judgement made from the render
 * would be about the resampler rather than about the geometry.
 *
 * ══ WHY IT HANDS OFF TO PYTHON ══
 *
 * There is no `canvas` package in this workspace and adding a native dependency to look at a
 * sprite would be a poor trade. The grid is emitted as JSON and Pillow paints it — nearest
 * neighbour, no smoothing, which is what §8's anti-aliasing ban requires of the world anyway. The
 * NUMBERS come from `catGrid`; Python only fills rectangles.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { catGrid, GRID_H, GRID_W } from "../dist/grid.js";
import { PHOSPHOR_RAMP, STATE_ACCENT } from "../dist/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "preview.png");

/**
 * Twelve ids. Deliberately NOT `cat-1`..`cat-12`: sequential ids differing in one trailing
 * character are the WORST case for a hash budget, because a poor mix leaves neighbouring ids
 * looking alike. Half the set is sequential precisely to expose that, and half is unrelated words
 * so the sheet also shows the typical case.
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

/** oklch() is not something Pillow parses, so the ramp is converted to sRGB bytes here. */
function oklchToRgb(css) {
  const m = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(css);
  if (!m) throw new Error(`unparsed colour: ${css}`);
  const L = Number(m[1]);
  const C = Number(m[2]);
  const hDeg = Number(m[3]);
  const h = (hDeg * Math.PI) / 180;
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

const payload = {
  gridW: GRID_W,
  gridH: GRID_H,
  ramp: PHOSPHOR_RAMP.map(oklchToRgb),
  // The page ground, §3 `--soot`. The sheet is drawn on the real page colour because a sprite
  // judged against white is judged against a contrast it will never have.
  soot: oklchToRgb("oklch(0.14 0.014 145)"),
  states: STATES,
  ids: IDS,
  cells: [],
};

for (const state of STATES) {
  for (const id of IDS) {
    const accent = STATE_ACCENT[state];
    payload.cells.push({
      id,
      state,
      accent: accent === undefined ? null : oklchToRgb(accent),
      px: catGrid(id, { state }).map((p) => [p.x, p.y, p.step, p.accent === true ? 1 : 0]),
    });
  }
}

const dir = mkdtempSync(join(tmpdir(), "cat-preview-"));
const jsonPath = join(dir, "grid.json");
writeFileSync(jsonPath, JSON.stringify(payload));

const PY = `
import json, sys
from PIL import Image, ImageDraw

data = json.load(open(sys.argv[1]))
GW, GH = data["gridW"], data["gridH"]
ramp = [tuple(c) for c in data["ramp"]]
soot = tuple(data["soot"])
ids, states = data["ids"], data["states"]

# Two blocks: the 32px map size on top, the 96px portrait size below.
SCALES = [2, 6]
PAD = 8
LABEL_H = 14
COLS = len(ids)

def block_size(s):
    cw, ch = GW * s + PAD, GH * s + PAD
    return cw * COLS, ch * len(states) + LABEL_H

widths = [block_size(s)[0] for s in SCALES]
heights = [block_size(s)[1] for s in SCALES]
W = max(widths) + 2 * PAD
H = sum(heights) + 3 * PAD

img = Image.new("RGB", (W, H), soot)
d = ImageDraw.Draw(img)

# The noise floor colour for labels — --phos-ghost. Type on this sheet is a tool, not the design.
LABEL = (100, 120, 100)

by_key = {(c["id"], c["state"]): c for c in data["cells"]}

y0 = PAD
for s in SCALES:
    cw, ch = GW * s + PAD, GH * s + PAD
    d.text((PAD, y0), f"{GW*s}px  (scale {s}x)", fill=LABEL)
    y = y0 + LABEL_H
    for state in states:
        d.text((PAD, y + 1), state[:4], fill=LABEL)
        for ci, cid in enumerate(ids):
            cell = by_key[(cid, state)]
            ox = PAD + 30 + ci * cw
            for (px, py, step, acc) in cell["px"]:
                col = tuple(cell["accent"]) if (acc and cell["accent"]) else ramp[step]
                x1 = ox + px * s
                y1 = y + py * s
                d.rectangle([x1, y1, x1 + s - 1, y1 + s - 1], fill=col)
        y += ch
    y0 = y + PAD

img.save(sys.argv[2])
print(f"{W}x{H}")
`;

const pyPath = join(dir, "draw.py");
writeFileSync(pyPath, PY);
const size = execFileSync("python3", [pyPath, jsonPath, out], { encoding: "utf8" }).trim();
console.log(`preview -> ${out}  (${size})`);
