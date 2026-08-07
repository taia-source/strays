/**
 * One cat, server-rendered as inline SVG.
 *
 * ══ WHY SVG AND NOT A DIV GRID ══
 *
 * openhood renders each creature as ONE `<div>` PER LIT PIXEL — 576 divs per creature. With a
 * colony on screen that is thousands of DOM nodes, and ARCHIVE.md records it as the mobile hazard
 * that drew nine complaints. This emits one `<rect>` per lit pixel inside a single `<svg>`, from a
 * SERVER component, so the client ships zero JavaScript for it.
 *
 * The COLONY MAP is a different problem — many cats at once — and uses `<canvas>` (see colony-map).
 * One portrait at a time is what SVG is right for.
 */
import { catGrid, catSvg, type CatState } from "@strays/cat";

export function CatPortrait({
  id,
  state = "hunting",
  size = 64,
  idle = true,
}: {
  readonly id: string;
  readonly state?: CatState;
  readonly size?: number;
  readonly idle?: boolean;
}) {
  const grid = catGrid(id, { state });
  // `catSvg` emits a viewBox and NO width/height — sizing is the caller's job, in CSS. That is
  // the right split: one sprite string serves every size, and scaling a viewBox is free.
  const svg = catSvg(grid, { state });
  return (
    <span
      className={idle ? "cat-idle" : undefined}
      /* Staggered per instance at mutually-prime-ish offsets so a colony never moves in lockstep.
         Derived from the id so it is stable across renders rather than random. */
      style={{
        animationDelay: `${(hashDelay(id) % 19) / 10}s`,
        display: "inline-block",
        width: size,
        height: size,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
      aria-label={`a stray, ${state}`}
      role="img"
    />
  );
}

/** FNV-1a, so the animation offset is deterministic. Math.random() is banned in rendering. */
function hashDelay(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
