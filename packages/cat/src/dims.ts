/**
 * THE GRID'S DIMENSIONS, in their own module.
 *
 * Extracted so `profile.ts` can bound its geometry against the grid without importing `grid.ts`,
 * which imports `profile.ts` — a cycle that TypeScript permits and that produces a genuinely
 * confusing class of runtime bug when a module-level constant is read before its defining module has
 * finished evaluating.
 *
 * Two constants in a leaf module is a cheap price for a dependency graph that is a tree.
 */

/**
 * THE NATIVE GRID. Every cat is authored at this resolution and never at another.
 *
 * 24x24, matching openhood's unicorn exactly. Square, so the same sprite sits in a map slot, a
 * detail portrait and a roster chip without any of them cropping it; a whole multiple of the 3px
 * quantum; and it halves cleanly to a 12px map dot.
 */
export const GRID_W = 24;
export const GRID_H = 24;
