# STRAYS — ART DIRECTION

Written **before** the first component, per `/build-ui`. This file governs **execution**.
`DESIGN.md` governs the **proposition**. Collapsing the two is the recorded reason written concepts
came out strong while rendered pages came out median, so they stay separate.

Everything left unstated regresses to the median — models infer unspecified requirements only
**41.1%** of the time. So the negative space is written down here, and **§8, the ban list, is the
most load-bearing section in the file.**

---

## 1. The cell claimed

> ## ⚠ MEASURED AT SHIP TIME: THREE OF THESE SIX DID NOT SHIP
>
> This section was written before the first component, which is the method and it stays. But the
> coordinates below are a CLAIM, and re-measuring the shipped source settled it against them:
>
> | Axis | Claimed here | **Measured in the build** |
> |---|---|---|
> | Navigation | map | **scroll · 5r** — the colony is a CSS grid of portraits, not a canvas map |
> | Density | dense-instrument | **moderate** |
> | Palette | phosphor | **phosphor** ✓ one hue at 145, verified by opening the page |
> | Motion | idle-world | **ambient · 2kf** — a cat bob and a tail flick; there is no world yet |
> | Type | mono-only | **mono-only** ✓ one local mono for every glyph including figures |
> | Input | pointer-agnostic | **click** — nothing beyond links and buttons was built |
>
> `ARCHIVE.md` row 11 records the measured values and footnote 13 explains the gap. The two that
> hold are both firsts, so the row still clears the rejection rule — but `map` and `idle-world`
> were derived at length below and **never rendered**, and reading this section as a description
> of the product would be reading an intention as a fact.
>
> The lesson, stated where the next reader will hit it: **an art direction is a claim about a page,
> and only the page can settle it.** Re-measure the six coordinates from shipped source before
> writing the archive row.

From `~/work/taia/ARCHIVE.md`, 10 occupied rows. STRAYS claims:

```
map-routed · dense-instrument · phosphor-on-soot · idle-world · mono-only · pointer-agnostic
```

**Four axes have never been claimed by ANY project**, and the other two are claimed by exactly one
each. Distance from every occupied row:

| Axis | Value claimed | Prior occupancy | New? |
|---|---|---|---|
| Navigation | **map** | 9/10 scroll-routed, 1 no-scroll HUD (unitick). `map` listed as never-used | **YES — first ever** |
| Density | dense-instrument | unitick only | shared with 1 |
| Palette | **phosphor** | listed as never-used. 7 light, 3 dark, none phosphor | **YES — first ever** |
| Motion | **idle-world** | listed as never-used. none/minimal/ambient/state-gated seen | **YES — first ever** |
| Type voice | **mono-only** | listed as never-used. bitmap (unitick), local (parquet) | **YES — first ever** |
| Input | **pointer-agnostic** | 9/10 click, 1 hover-gated, 1 press-and-hold | **YES — first ever** |

Nearest neighbour is **unitick (#10)**, sharing exactly one axis (density). unitick is
`no-scroll HUD · high-chroma pink×green duotone · state-gated · bitmap · press-and-hold`; STRAYS is
`map · phosphor green mono · idle-world · mono-only · pointer-agnostic`. The 4+ match rejection rule
is cleared with a margin of five.

**Why these are not arbitrary.** Each falls out of the product rather than being picked for novelty:

- **map** — a colony is a *place* with a population. openhood's own postmortem found the opposite
  problem: *"The framing before the bestiary — a city of machines — described a place, and a place
  has no protagonist."* STRAYS inverts this deliberately: the protagonist is **your** cat, and the
  map exists so you can see it among others. Scroll would bury that.
- **idle-world** — the cats hunt whether or not you are watching. That is the entire product
  promise ("no single user interaction"), so the world must visibly continue when unattended. A
  page that freezes when idle contradicts the thing being sold.
- **pointer-agnostic** — the product is 1–2 clicks and then nothing. There is no interaction
  vocabulary to build, so the correct input model is "everything works with whatever you have,
  nothing requires precision."

---

## 2. The referent

Eight non-web referents proposed with each one's probability of being the typical answer for a
"pixel cat crypto trading" brief; **the top three discarded** per the far-and-rare rule.

| # | Referent | P(typical) | Verdict |
|---|---|---|---|
| 1 | Tamagotchi / virtual pet LCD | 0.34 | **DISCARDED — mode** |
| 2 | Arcade cabinet / 8-bit game | 0.21 | **DISCARDED — mode** |
| 3 | Bloomberg terminal | 0.14 | **DISCARDED — mode + on burned list** |
| 4 | Cat-colony TNR field logbook | 0.03 | *candidate* |
| 5 | **Night-vision wildlife camera trap** | **0.02** | **CHOSEN** |
| 6 | Harbour tide table | 0.02 | candidate |
| 7 | Sonar / hydrophone watch station | 0.04 | candidate |
| 8 | Victorian naturalist plate | 0.03 | candidate |

> ## THE REFERENT: A NIGHT-VISION WILDLIFE CAMERA TRAP
>
> Nobody is at the camera. It fires on motion, timestamps everything, and what it captures is
> whatever the animal did while unobserved.

This is the only referent in the list whose *operating principle* is the product's own thesis: **the
record is made by the animal's behaviour, not by an operator's attention.** #4 and #6 were close;
#5 wins because a logbook and a tide table are both *human* records, and this record is not.

### 2a. Its six operating rules — derived from how it WORKS, never its adjectives

**RULE 1 — MONOCHROME IS NOT A STYLE, IT IS A SENSOR LIMIT.** An IR sensor has no colour
information; the green is the phosphor of the display, not the colour of the animal. **So one hue
carries the entire page, and any second hue is an EVENT, not decoration.** This is the structural
answer to unitick's recorded "it is just a black page" failure, and it is why the palette is
phosphor rather than duotone.

**RULE 2 — EVERY FRAME IS STAMPED.** A trap that shows an animal without a timestamp is useless.
**Every number on this page carries when it was measured and from which block.** No figure floats
free of its provenance. This is the aesthetic form of the invented-data ban.

**RULE 3 — THE CAMERA DOES NOT FOLLOW. It has a fixed frame and things enter and leave it.** The
map does not pan to your cat, and nothing is centred on the user. You find your cat in the frame.
This is what makes it a colony rather than a dashboard.

**RULE 4 — EXPOSURE FALLS OFF WITH DISTANCE.** IR illuminators light the near field and lose the
far one. **Depth is carried by luminance alone** — near things are bright, far things sink into
noise. No scale cues, no perspective, no parallax. This gives the map its depth for free and is why
`--px` quantisation can stay flat.

**RULE 5 — NOISE IS THE SIGNAL'S FLOOR, AND IT IS ALWAYS PRESENT.** A perfectly clean IR frame is a
fake IR frame. The grain is not an overlay effect; it is what an under-lit sensor does. **It must
never sit on top of type** — sensor noise is in the image, and the UI chrome is not the image.

**RULE 6 — WHAT IT REFUSES: THE OPERATOR.** No crosshair, no reticle, no "targeting" language, no
scanning-beam sweep. Those are a *gun sight*, which is a different instrument with a different
politics. A camera trap is passive. **The cats hunt; the user does not.**

---

## 3. Palette — phosphor

One hue. Derived by fixing hue **145** (P1 phosphor green, measured against the CRT primary rather
than picked) and walking lightness and chroma until each surface pair separates at ≥3:1 and body
text clears 7:1.

```css
--soot        oklch(0.14 0.014 145)   /* the page. near-black, faint green cast, never #000 */
--soot-hi     oklch(0.19 0.020 145)   /* raised surface */
--soot-line   oklch(0.25 0.026 145)   /* separator */
--phos        oklch(0.90 0.055 145)   /* primary type. NEAR-white-green, never #fff */
--phos-dim    oklch(0.63 0.045 145)   /* secondary type */
--phos-ghost  oklch(0.40 0.030 145)   /* tertiary, the noise floor */
```

**The structural tier**, taken directly from unitick's recorded fix for "it barely reads as
[brand] ... it is a black page". Same hue, low chroma, so it can never be mistaken for an event:

```css
--rail  oklch(0.34 0.075 145)   /* a visible structural edge */
--band  oklch(0.24 0.045 145)   /* surface behind content */
--wash  oklch(0.19 0.028 145)   /* faintest tint — panels, chips */
```

**The two event hues, and they are the ONLY chroma on the page:**

```css
--fed    oklch(0.78 0.170 85)    /* AMBER. the cat ate — a closed winning trade */
--starve oklch(0.60 0.200 25)    /* EMBER RED. the cat is starving / a loss */
```

**One hue means exactly one thing.** `--fed` is never used for "good" generally, never for a CTA,
never for a border. `--starve` is never used for an error toast or a destructive button. This is
openhood's measured nine-hues-is-no-hue defect and unitick's `SPCX·HALT` bug (a *halted* lane drawn
in knockout pink, reading as "this one died" when a halt is the opposite). Both are on record; both
are avoided by the same discipline.

**Green is NOT profit here, and that is deliberate.** Green is the *sensor*. A green number means
"measured", not "up". This kills the green=good/red=bad convention that unitick also banned, and it
is forced by Rule 1 rather than being a taste.

Contrast: `--phos` on `--soot` = **14.1:1**. Neither end is pure — maximum contrast triggers
halation for readers with astigmatism (Bodega's measured finding).

**Light theme:** the whole palette inverts, and **all three structural tokens and both event hues
invert with it.** unitick shipped two separate bugs here, both invisible to automated checking: a
tier left at dark values rendered near-black type on a near-black rail (*"a contrast checker never
fails on a surface with no text on it"*), and a first inversion left every surface within 4%
lightness of the paper (*"the TYPE was always legible — it is the surfaces that were
indistinguishable"*). The palette is therefore restated **three times** — media query,
`[data-theme=dark]`, `[data-theme=light]` — because an override that sets only half the tokens
leaves the rest inherited.

---

## 4. Type — mono-only

**One family, every glyph on the page.** Not a display face plus a mono for figures — *only* the
mono. This is the axis no project has claimed, and the referent forces it: a camera trap's OSD has
one character generator.

```
JetBrains Mono, self-hosted .woff2 via next/font/local, weights 400 + 700
fallback: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace
```

**Self-hosted, never a CDN `@import`.** float declared `"Geist"`/`"Instrument Serif"` in CSS and
never imported them — they silently fell back, and ARCHIVE.md records it as a real defect.

**Why mono-only is safe here where it would not be elsewhere:** parquet's measured finding is that a
pixel font where `8` misreads as `6` on a dollar amount is a defect. That finding bans a *bitmap*
face on figures. JetBrains Mono is a legibility-first mono with a slashed zero and disambiguated
`1lI`/`0O`, so the same rule that forbids Silkscreen on a balance permits this. **The pixel identity
of this product lives in the CAT and the MAP, not in the type** — which is also what keeps it
distant from parquet (#7, local pixel font) and unitick (#10, bitmap).

Scale is **integer-pinned at both ends, no `clamp()` interpolation** — a mono grid wants whole
pixels:

```
mobile   --t-hero 28  --t-body 13  --t-micro 11  --t-figure 15  --t-figure-lg 22
≥900px   --t-hero 52  --t-body 15  --t-micro 12  --t-figure 18  --t-figure-lg 34
```

`font-variant-numeric: tabular-nums` on every figure. `border-radius: 0` globally.

---

## 5. The world — the map, and how a cat is drawn

### 5a. Rendering: `<canvas>`, not DOM

openhood renders each creature as **one `<div>` per lit pixel** — 576 divs per creature. With a
colony on screen that is thousands of nodes and it is the recorded mobile hazard (ARCHIVE `7j`).
**The colony map is a single canvas.** Individual cat portraits (one at a time, e.g. on a detail
panel) may use the SVG `<rect>` sprite path, which is server-rendered with zero client JS.

Quantum: `const q = Math.max(1, Math.round(2 * dpr))`, every draw snapped `Math.round(x/q)*q`.
DPR capped resolution-aware — `cssWidth < 700 ? 1.5 : 2` (a DPR-3 phone quadruples fill for no
visible gain). `canvas.width` set as an **attribute**, not only a style: at dpr=1 the correct and
incorrect forms are byte-identical, so the bug is invisible on a 1× monitor and appears on every
phone.

### 5b. The cat — 16×16, derived from the id

Method inherited from `openhood/apps/web/lib/creature-grid.ts`; **artwork is not.**

- **Hash:** FNV-1a 32-bit, offset `2166136261`, prime `16777619`, `Math.imul` mandatory.
- **Per-axis salting:** each trait is `fnv1a(\`${id}:${SALT.trait}\`)` so features are decorrelated
  rather than sliced from one integer. **`Math.random()` is banned in rendering.**
- **Grid: 16×16.** unitick's measured floor is 12×12 for a face; openhood used 24×24 for a creature
  with a horn and mane. A cat needs ears and a tail but no mane, and 16 keeps a colony of them
  cheap. **Rendered to PNG at final size and LOOKED AT** before it is called done.
- **Parts:** `head`, `muzzle`, `eye`, `body`, `leg`, **`ear`** (two triangles, inner surface shading
  darker), **`tail`** (a hash-swept curve). `hornNormal` and `maneNormal` are **deleted**.
- **Hash budget biased toward ear angle and tail curl** — those carry the silhouette identity for a
  cat that a horn carried for a unicorn.

**The three silhouette rules, from unitick's recorded NEEDLE failure** (v1 *"read as a white blob"*):

1. **An appendage must MEET the body.** Ears and tail connect with no gap, or they read as dust.
2. **A shaded separator between head and body**, or the silhouette is an amoeba with no neck.
3. **Legs are 2px wide, paired with a visible gap.** Four 1px verticals read as a fringe.

### 5c. Shading and the lit page

Per-part surface normal → Lambert → **6-step ramp** → **4×4 Bayer dither** (`bayer4`/`quantise`
from the mechanism kit, strength 1.0). Six steps, not eight: a flat-lit animal has less tonal range
than a shaded sphere.

The map's IR falloff (Rule 4) is a **quarter-resolution offscreen glow plate**, computed once per
resize and blitted with `imageSmoothingEnabled = false`. Per-pixel dither over a full viewport is
~5M ops/frame; at quarter res it is ~324k, and nearest-neighbour upscaling makes the dither pattern
*bigger*, which is more pixel-art, not less. **A CSS `radial-gradient` is banned for this** — it
dies under forced-colours, where `background-image` is stripped to `none`.

### 5d. Motion — idle-world

The world moves whether or not anyone is watching, because that is the product.

- **Cat idle:** CSS `steps(2)` keyframes on `transform` only, one shared `--cat-dur`, **staggered
  `animationDelay` per instance at mutually-prime-ish offsets** so the colony never moves in
  lockstep. No rAF per sprite. `will-change` deliberately absent — it promotes a layer permanently
  and on a page with this many sprites costs more memory than the jank it saves.
- **Ambient periods use `incommensurate()`** — ratios `[1, 1.3247, 1.7549, ...]`. Motion built on
  2s/4s/8s loops looks mechanical because everything realigns every 8 seconds and the eye catches
  it.
- **Damping is `damp(v, retain, dt) = v * retain**(dt*60)`, never `v *= 0.94`** — the naive form
  ties physics to frame rate and teleports after a tab switch.
- **Two-rate nested chase** (R&H6900's measured lesson): a global rate plus a per-entity rate.
  *"One rate is a transition; two rates is a behaviour."*
- **`prefers-reduced-motion` suppresses all of it** and the world renders in its settled state.

---

## 6. Layout

`html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }` on the app;
**`100svh`**, which is the correct primitive — `vh` is defined as `lvh` by CSS Values 4, by
specification rather than as an iOS defect.

**The five grid failures unitick recorded, all of which passed automated checks:**

1. **Floor the track that must not vanish** — `minmax(0,1fr) auto` collapsed a hero to **0px** while
   its content painted on top of the neighbouring row. Nothing overflowed, so every check passed.
   Only the screenshot showed it.
2. **Declare BOTH `grid-template-rows` and `-columns`.** Undeclared tracks put children in implicit
   `auto` tracks inside a fixed-height parent, and they render on top of each other.
3. **Never cap with a percentage** in an indefinite container — it resolves to zero and the element
   disappears entirely. Floor with a **fixed length** instead.
4. **A floor on a non-scrolling `auto` track over-subscribes the grid.** Floors are only safe on a
   track whose container scrolls internally.
5. **Watch specificity:** a media-query-scoped compound selector out-specifies a later plain-class
   rule — a descending-specificity trap.

Plus: **`margin-inline: auto` centres a BOX; `text-align: center` centres TYPE.** Different
properties, different problems, and the first does not imply the second.

**Budget the words before the boxes.** unitick's no-scroll HUD failed at 390×844 not because of
track arithmetic but because **154px of explanatory prose sat in a 402px column**. Two rounds of
grid surgery failed before anyone counted the words. The tempting fix — `display: none` on help text
— would have hidden a risk disclosure, trading a layout defect for a disclosure defect.

**Screenshots at 320 / 390 / 768 / 1440, every session, described in prose.** openhood took **zero**
mobile captures and drew **nine** mobile complaints; the one session that shot 320/390/480/767 is
where the complaints stopped. **A predicate passing is not a page being good.**

---

## 7. The signature interaction

**Adoption is the only interaction in the product, so it is the one that gets the craft.**

Following R&H6900's measured pattern — *the animation is a gate in the state machine, not
decoration* — funding resolves two independent booleans: the transaction confirming, and the cat's
arrival animation completing. The cat does not appear until both are true.

R&H6900 recorded the failure that makes this work: they first gated on **counting settled
particles**, and it never fired reliably because the orbit target moves every frame. They replaced
it with a threshold on the global ease and left the dead counter in with a `void` to document the
rejection. **We gate on the eased value, never on a per-entity settle count.**

After that: **zero required interactions, forever.** Everything else on the page is a read.

---

## 8. THE BAN LIST

The most identity-defining section. Each entry is either derived from the referent or from a
measured failure in this corpus.

**From the referent:**
- **No crosshair, reticle, targeting language, or scanning-beam sweep.** A camera trap is passive;
  those belong to a gun sight (Rule 6).
- **No colour on an animal.** The IR sensor has none. Cats are drawn in the phosphor ramp only —
  their *state* may tint one or two pixels, their *identity* may not.
- **No panning or centring on the user's cat** (Rule 3). You find it in the frame.
- **No perspective, parallax, or depth cue other than luminance** (Rule 4).
- **No unstamped figure** (Rule 2). Every number carries when and from which block.
- **Noise never sits on type** (Rule 5).

**Inherited from measured failures, verbatim in force:**
- **No `Math.random()` in rendering.** Every axis is `fnv1a` on the id.
- **No glow on type.** A glow blurs the glyph edge and defeats automated contrast checking, and a
  number representing somebody's money must have measurable contrast.
- **No semantic hue meaning two things.** No accent-as-theme.
- **No `border-radius`. No blur. No drop shadows. No gradients-as-decoration.**
- **No easing libraries.** The mechanism kit is zero-dependency.
- **No anti-aliasing in the world.** `shape-rendering: crispEdges`, `image-rendering: pixelated`,
  `imageSmoothingEnabled = false`, `-webkit-font-smoothing: none`.
- **No `will-change`.**
- **No CSS `radial-gradient` for the glow** — stripped to `none` under forced-colours.
- **No faux-bold on a single-weight face** (`h1..h4, strong, b { font-weight: 400 }` where it
  applies).
- **No invented data — including GEOMETRY.** unitick sized every teaching bracket from
  `fnv1a(symbol)` — a hash of the ticker — and drew it solid, in the hue reserved for a live
  position, on top of a genuine price trace. Two passes had tuned those brackets *by looking at
  them*, which is exactly why neither caught it. **If a shape encodes a quantity, the quantity must
  be measured.**

**Refused specifically for this brief:**
- **The words yield, returns, investing, APY, earn.** (inherited from unitick, and correct here for
  the same reason: this is not investing and must not be dressed as it)
- **Green = good, red = bad.** Green is the sensor (§3).
- **A cute cat used to soften a loss.** A starving cat is drawn starving. The mechanic is honest
  about losses or it is a lie with whiskers on it.

---

## 9. What would make this fail

Written down so it can be checked against later, per the corpus habit of recording the trap
alongside the rule.

**The likeliest failure is that "phosphor monochrome" renders as a black page with green text and
nothing else** — the exact defect unitick shipped and had to fix. The structural tier (§3) exists to
prevent it, and the check is: **open the page and count the distinguishable surfaces.** If fewer
than four, the tier is not doing its job. A contrast checker will not catch this, because the type
was always legible.

**The second likeliest is that the map is beautiful and unreadable** — you cannot find your own cat.
Rule 3 forbids centring on it, so the burden falls entirely on the identity of the sprite. If a
colony of 30 cats reads as 30 identical smudges at 390px, the hash budget is wrong and the fix is
silhouette (ear angle, tail curl), not colour.
