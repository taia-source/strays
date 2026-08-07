/**
 * Contrast checking that does not rely on axe reaching a verdict.
 *
 * ══ The measurement that forced this to exist ══
 *
 * A prior project shipped with every primary button black-on-black for weeks. It passed
 * every test. So I ran axe 4.12.1 in a real Chromium against two deliberately broken
 * buttons — one solid `#000` on `#000`, one a black gradient with black text:
 *
 *   violations: []          ← ZERO. Not one.
 *   incomplete: [
 *     { "#solid", messageKey: "equalRatio"  },
 *     { "#grad",  messageKey: "bgGradient"  },
 *   ]
 *
 * **Both invisible.** A CI step that runs axe and checks `violations.length === 0`
 * passes a page whose buttons cannot be read at all.
 *
 * Two separate bail-outs, both confirmed in axe's own source:
 *
 *   - `bgGradient` — `/gradient/.test(backgroundImage)` makes axe give up on resolving
 *     the background. Gradient buttons are everywhere in crypto UI.
 *   - `equalRatio` — identical foreground and background is a 1:1 ratio that axe reports
 *     as indeterminate rather than as the total failure it obviously is.
 *
 * ══ So this module does two things ══
 *
 *   1. treats axe `incomplete` as **failure requiring review**, never as a pass
 *   2. computes the ratio itself from resolved colours, which works where axe declines
 *
 * Neither replaces axe — the other ~90 rules are valuable. This closes the specific hole
 * that let a real, obvious, weeks-long bug through.
 */

export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/** Parse `rgb()`, `rgba()` and `#rrggbb` as a browser reports them. */
export function parseColor(value: string): Rgb | undefined {
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  const hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value.trim());
  if (hex) {
    return {
      // The `?? "0"` fallbacks are unreachable and untestable: all three groups are
      // mandatory (no `?`, no `|`), so a successful match defines every one of them.
      // They exist only to satisfy noUncheckedIndexedAccess.
      r: Number.parseInt(hex[1] ?? "0", 16),
      g: Number.parseInt(hex[2] ?? "0", 16),
      b: Number.parseInt(hex[3] ?? "0", 16),
    };
  }
  return undefined;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Worst-case ratio against a gradient.
 *
 * Where axe gives up, we take every colour stop and use the WORST pairing. A gradient is
 * only readable if its least-readable point is readable.
 */
export function worstRatioAgainstStops(foreground: Rgb, stops: readonly Rgb[]): number {
  if (stops.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...stops.map((s) => contrastRatio(foreground, s)));
}

/** Extract colour stops from a `linear-gradient(...)` / `radial-gradient(...)` value. */
export function gradientStops(backgroundImage: string): Rgb[] {
  const stops: Rgb[] = [];
  for (const match of backgroundImage.matchAll(/rgba?\([^)]+\)|#[a-f\d]{6}\b/gi)) {
    const color = parseColor(match[0]);
    if (color) stops.push(color);
  }
  return stops;
}

/** WCAG 2 AA thresholds. Large text is >=24px, or >=18.66px bold. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

export function requiredRatio(fontSizePx: number, bold: boolean): number {
  const isLarge = fontSizePx >= 24 || (bold && fontSizePx >= 18.66);
  return isLarge ? AA_LARGE : AA_NORMAL;
}

export type ElementColors = {
  readonly selector: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly fontSizePx: number;
  readonly bold: boolean;
};

export type ContrastFinding = {
  readonly selector: string;
  readonly ratio: number;
  readonly required: number;
  readonly ok: boolean;
  /** Stated plainly, because "contrast violation" does not tell anyone what to change. */
  readonly detail: string;
};

/**
 * Judge one element from its resolved styles.
 *
 * Works precisely where axe returns `incomplete`: a gradient is scored against its worst
 * stop, and identical colours score 1.0 rather than "indeterminate".
 */
export function checkElement(el: ElementColors): ContrastFinding {
  const fg = parseColor(el.color);
  const required = requiredRatio(el.fontSizePx, el.bold);

  if (!fg) {
    return {
      selector: el.selector,
      ratio: 0,
      required,
      ok: false,
      detail: `could not resolve the text colour "${el.color}" — treated as a failure rather than skipped`,
    };
  }

  const stops =
    el.backgroundImage && el.backgroundImage !== "none" ? gradientStops(el.backgroundImage) : [];

  if (stops.length > 0) {
    const ratio = worstRatioAgainstStops(fg, stops);
    return {
      selector: el.selector,
      ratio,
      required,
      ok: ratio >= required,
      detail:
        ratio >= required
          ? `${ratio.toFixed(2)}:1 at its worst gradient stop (needs ${required}:1)`
          : `${ratio.toFixed(2)}:1 at its worst gradient stop, below ${required}:1 — axe reports this as "incomplete" and never flags it`,
    };
  }

  const bg = parseColor(el.backgroundColor);
  if (!bg) {
    return {
      selector: el.selector,
      ratio: 0,
      required,
      ok: false,
      detail: `could not resolve the background "${el.backgroundColor}" — treated as a failure rather than skipped`,
    };
  }

  const ratio = contrastRatio(fg, bg);
  return {
    selector: el.selector,
    ratio,
    required,
    ok: ratio >= required,
    detail:
      ratio >= required
        ? `${ratio.toFixed(2)}:1 (needs ${required}:1)`
        : ratio < 1.05
          ? `${ratio.toFixed(2)}:1 — the text and background are the same colour, so it is invisible. axe reports this as "equalRatio" and never flags it`
          : `${ratio.toFixed(2)}:1, below the ${required}:1 required`,
  };
}

/** Browser-side script collecting resolved styles for every interactive element. */
export const COLLECT_COLORS_SCRIPT = `(() => {
  const out = [];
  const nodes = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"]');
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;   // invisible, not a contrast issue
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;

    // Walk up for a real background: a transparent element inherits its ancestor's.
    let bgColor = s.backgroundColor;
    let node = el.parentElement;
    while (node && (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent')) {
      bgColor = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }

    out.push({
      selector: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
      color: s.color,
      backgroundColor: bgColor,
      backgroundImage: s.backgroundImage,
      fontSizePx: Number.parseFloat(s.fontSize),
      bold: Number.parseInt(s.fontWeight, 10) >= 700,
    });
  }
  return out;
})()`;

export type AxeResultLike = {
  readonly violations?: ReadonlyArray<{
    readonly id: string;
    readonly nodes: ReadonlyArray<{ readonly target: readonly string[] }>;
  }>;
  readonly incomplete?: ReadonlyArray<{
    readonly id: string;
    readonly nodes: ReadonlyArray<{ readonly target: readonly string[] }>;
  }>;
};

export type A11yResult = {
  readonly ok: boolean;
  readonly violations: readonly string[];
  /** Non-verdicts. Treated as failures — this is the whole point of the module. */
  readonly unresolved: readonly string[];
  readonly contrast: readonly ContrastFinding[];
};

/**
 * Combine axe with our own measurement.
 *
 * **`incomplete` counts as failure.** Measured: two black-on-black buttons produced zero
 * violations and two incompletes. Treating `incomplete` as a pass is what let that ship.
 */
export function assessA11y(options: {
  readonly axe?: AxeResultLike;
  readonly elements?: readonly ElementColors[];
}): A11yResult {
  const violations = (options.axe?.violations ?? []).flatMap((v) =>
    v.nodes.map((n) => `${v.id} — ${n.target.join(" ")}`),
  );
  const unresolved = (options.axe?.incomplete ?? []).flatMap((v) =>
    v.nodes.map((n) => `${v.id} — ${n.target.join(" ")} (axe could not decide; not a pass)`),
  );
  const contrast = (options.elements ?? []).map(checkElement);
  const failed = contrast.filter((c) => !c.ok);

  return {
    ok: violations.length === 0 && unresolved.length === 0 && failed.length === 0,
    violations,
    unresolved,
    contrast,
  };
}

export function formatA11y(result: A11yResult): string {
  if (result.ok)
    return `accessibility passed (${result.contrast.length} interactive elements measured)`;

  const lines: string[] = ["ACCESSIBILITY FAILED:"];

  if (result.violations.length > 0) {
    lines.push(`  axe violations (${result.violations.length}):`);
    lines.push(...result.violations.map((v) => `    ✗ ${v}`));
  }
  if (result.unresolved.length > 0) {
    lines.push(`  axe could not decide (${result.unresolved.length}) — NOT a pass:`);
    lines.push(...result.unresolved.map((v) => `    ? ${v}`));
  }
  const failed = result.contrast.filter((c) => !c.ok);
  if (failed.length > 0) {
    lines.push(`  measured contrast failures (${failed.length}):`);
    lines.push(...failed.map((c) => `    ✗ ${c.selector}: ${c.detail}`));
  }
  return lines.join("\n");
}
