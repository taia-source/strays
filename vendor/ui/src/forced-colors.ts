/**
 * Where heavy visual effects silently disappear.
 *
 * ══ What forced colours does ══
 *
 * Windows High Contrast Mode — and any OS-level forced-colours setting — replaces the
 * page's palette with a small system one. That much is well known. The part that breaks
 * ambitious UIs is what it *removes*, per the CSS specification:
 *
 *   box-shadow        → none
 *   text-shadow       → none
 *   background-image  → none   (non-`url()` values only — gradients die, images survive)
 *
 * Verified on this machine rather than taken from the spec:
 *
 *   #shadowonly  border:none  shadow:none  bgImage:none            ← invisible
 *   #bordered    border:solid shadow:none  bgImage:none            ← still visible
 *   #grad        border:none  shadow:none  bgImage:none            ← flat, unreadable
 *   #urlbg       border:none  shadow:none  bgImage:url("data:…")   ← survives
 *
 * ══ Why this matters for the styles this repo supports ══
 *
 * Modern design leans on exactly the properties forced colours strips. A button whose only
 * boundary is a `box-shadow` becomes an invisible rectangle. A gradient call-to-action
 * becomes flat and unreadable. Neither fails any other check: the DOM is unchanged, the
 * text is present, contrast passes against the *forced* background, and layout is intact.
 *
 * The user affected is, by definition, one who turned on a high-contrast accessibility
 * setting — so the failure lands precisely on the people least able to work around it.
 *
 * ══ WebKit reports the media query and forces nothing ══
 *
 * This is the finding that decides the module's shape. Measured on Playwright 1.62 with
 * `emulateMedia({ forcedColors: 'active' })`:
 *
 *   chromium  mq:true   shadow:"none"                       bg:"none"
 *   firefox   mq:true   shadow:"none"                       bg:"none"
 *   webkit    mq:true   shadow:"rgb(0,0,0) 0px 0px 4px 0px" bg:"linear-gradient(rgb("
 *
 * **WebKit answers `true` to `(forced-colors: active)` while applying none of the
 * forcing.** A suite that ran this check there would pass every time and prove nothing —
 * the worst kind of green. {@link assessForcedColors} therefore requires the engine to be
 * named and refuses to render a verdict on WebKit, rather than reporting a vacuous pass.
 */

/** One element as it computes under forced colours. */
export type ForcedColorsObservation = {
  readonly selector: string;
  /** Computed `border-style`. `"none"` means no border survived. */
  readonly borderStyle: string;
  /** Computed `box-shadow`. Forced to `"none"` by a conforming engine. */
  readonly boxShadow: string;
  /** Computed `background-image`. Gradients become `"none"`; `url()` survives. */
  readonly backgroundImage: string;
  /** Computed `forced-color-adjust`, if set. */
  readonly forcedColorAdjust?: string | undefined;
  /** Whether the element carries text or is interactive — a spacer vanishing is fine. */
  readonly meaningful: boolean;
  /** Rendered size, so a zero-area element is not reported. */
  readonly width: number;
  readonly height: number;
};

/**
 * The same page observed twice: forcing off, then on.
 *
 * ══ Why one pass is not enough ══
 *
 * The first version of this module reported `gradient-lost` for any element whose
 * `background-image` computed to `none` under forcing. Run against a real page, that
 * fired on a plain bordered button that never had a gradient — because on almost every
 * page, almost every element has no background image at all.
 *
 * A comparison makes it exact. Measured on the same page with forcing off then on:
 *
 *   #grad   bgImage: linear-gradient(rgb(255,…)  →  none    ← a real loss
 *   #plain  bgImage: none                        →  none    ← never had one
 *
 * Only a value that *changed* is a loss. The `before` pass costs one extra page render
 * and removes an entire class of false positive, which is the trade every check in this
 * package makes.
 */
export type ForcedColorsPair = {
  /** Rendered WITHOUT forcing — what the design intends. */
  readonly before: readonly ForcedColorsObservation[];
  /** Rendered WITH `forced-colors: active`. */
  readonly after: readonly ForcedColorsObservation[];
};

export type ForcedColorsDefect =
  | "boundary-vanished"
  | "gradient-lost"
  | "forced-color-adjust-abuse";

export type ForcedColorsFinding = {
  readonly kind: ForcedColorsDefect;
  readonly selector: string;
  readonly detail: string;
  readonly severity: "high" | "medium";
};

/**
 * Engines that actually apply forced colours.
 *
 * WebKit is excluded deliberately and on evidence — see the module docstring. Playwright's
 * WebKit flips the preference so the media query answers `true`, but nothing downstream
 * honours it.
 */
export const FORCING_ENGINES: ReadonlySet<string> = new Set(["chromium", "firefox"]);

export type ForcedColorsResult =
  | { readonly supported: false; readonly engine: string; readonly reason: string }
  | {
      readonly supported: true;
      readonly ok: boolean;
      readonly findings: readonly ForcedColorsFinding[];
    };

/**
 * Judge a page rendered under `forced-colors: active`.
 *
 * Takes the engine name and **refuses to answer for WebKit**. Returning "ok" there would
 * be a vacuous pass: the media query is true, the forcing never happened, so every element
 * keeps its shadows and gradients and no finding can ever be produced.
 */
export function assessForcedColors(input: {
  readonly engine: string;
  readonly observations: ForcedColorsPair;
}): ForcedColorsResult {
  const { engine } = input;
  const { before, after } = input.observations;
  // Indexed by selector so each element is compared against its own prior state.
  const priorBySelector = new Map(before.map((o) => [o.selector, o]));

  if (!FORCING_ENGINES.has(engine)) {
    return {
      supported: false,
      engine,
      reason:
        `${engine} reports (forced-colors: active) as true but applies none of the forcing — ` +
        "measured: box-shadow and gradients survive intact where Chromium and Firefox strip " +
        "both to none. A verdict here would be a vacuous pass, so none is given. Run this " +
        "check on Chromium or Firefox",
    };
  }

  const findings: ForcedColorsFinding[] = [];

  for (const o of after) {
    // A zero-area element cannot lose a visible boundary.
    if (o.width <= 0 || o.height <= 0) continue;
    const prior = priorBySelector.get(o.selector);

    /**
     * The strongest signal: an element whose entire visual boundary is gone.
     *
     * Measured discriminator — `#shadowonly` came back `border:none shadow:none` and is an
     * invisible box, while `#bordered` kept `border:solid` and stays visible. A component
     * whose only edge was a shadow has no edge at all here.
     *
     * Restricted to `meaningful` elements: a decorative spacer losing its shadow is not a
     * defect, and reporting every such div would bury the real findings.
     */
    const lostItsBoundary =
      o.borderStyle === "none" &&
      o.boxShadow === "none" &&
      // It must have HAD a boundary. An element that never had one is a plain container,
      // not a component whose edge disappeared.
      prior !== undefined &&
      prior.boxShadow !== "none" &&
      prior.borderStyle === "none";

    if (o.meaningful && lostItsBoundary) {
      findings.push({
        kind: "boundary-vanished",
        selector: o.selector,
        severity: "high",
        detail:
          `relied on a box-shadow for its only visible boundary (${prior.boxShadow}), and ` +
          "forced colours sets box-shadow to none per spec — so it becomes an invisible " +
          "rectangle. Give it a real border; `border: 1px solid transparent` is enough, " +
          "since forced colours substitutes a system colour for a transparent border",
      });
    }

    /**
     * A gradient background is replaced by `none`, leaving whatever `background-color`
     * sits underneath — frequently nothing. `url()` images survive, verified, so only the
     * generated kind is reported.
     */
    if (
      o.meaningful &&
      o.backgroundImage === "none" &&
      // Only a background that was actually THERE and is now gone. Without this, the rule
      // fires on every element on the page — measured, it flagged a plain bordered button
      // that never had a gradient.
      prior !== undefined &&
      prior.backgroundImage !== "none"
    ) {
      findings.push({
        kind: "gradient-lost",
        selector: o.selector,
        severity: "medium",
        detail:
          `had a generated background (${prior.backgroundImage.slice(0, 60)}) that forced ` +
          "colours strips to none — gradients are removed by spec while url() images survive, " +
          "verified. If this element relied on it for shape or emphasis it is now flat. Set a " +
          "background-color as well so something remains",
      });
    }

    /**
     * `forced-color-adjust: none` opts an element out entirely, which is legitimate for a
     * colour swatch or a photograph and an accessibility failure everywhere else — it is
     * the developer overriding a user's explicit accessibility setting.
     */
    if (o.forcedColorAdjust === "none") {
      findings.push({
        kind: "forced-color-adjust-abuse",
        selector: o.selector,
        severity: "medium",
        detail:
          "sets forced-color-adjust: none, opting out of the user's forced-colours setting. " +
          "That is correct for a colour swatch or a photograph, where the actual colours ARE " +
          "the content — and an accessibility failure anywhere else, because it overrides a " +
          "setting the user deliberately turned on. Note Safari does not support this " +
          "property at all, so it is not a portable escape hatch",
      });
    }
  }

  return { supported: true, ok: findings.every((f) => f.severity !== "high"), findings };
}

/**
 * Collect computed styles under forced colours.
 *
 * Must be evaluated on a page created with `emulateMedia({ forcedColors: 'active' })`, and
 * on Chromium or Firefox — see {@link FORCING_ENGINES}.
 *
 * Self-contained: Playwright's string-form `evaluate` cannot close over module scope.
 */
export const COLLECT_FORCED_COLORS_SCRIPT = `(() => {
  const name = (e) => e.id ? '#' + e.id
    : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\\s+/)[0] : '');

  // Only elements a user could see or act on. A decorative spacer losing its shadow is
  // not a defect, and reporting every div would bury the real findings.
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

  const meaningful = (e) => {
    if (INTERACTIVE.has(e.tagName)) return true;
    if (e.getAttribute('role')) return true;
    if (e.hasAttribute('tabindex')) return true;
    // Owns visible text directly, rather than merely containing a child that does.
    return [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  };

  return [...document.querySelectorAll('*')]
    .filter((e) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        selector: name(e),
        borderStyle: s.borderStyle,
        boxShadow: s.boxShadow,
        backgroundImage: s.backgroundImage,
        forcedColorAdjust: s.forcedColorAdjust,
        meaningful: meaningful(e),
        width: r.width,
        height: r.height,
      };
    });
})()`;

export function formatForcedColors(result: ForcedColorsResult): string {
  if (!result.supported) {
    return `forced colours NOT CHECKED on ${result.engine} — ${result.reason}`;
  }

  if (result.findings.length === 0) {
    return "forced colours OK — every meaningful element keeps a visible boundary";
  }

  const rank = { high: 0, medium: 1 } as const;
  const sorted = [...result.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return [
    result.ok
      ? `forced colours OK with ${result.findings.length} warning(s):`
      : `FORCED COLOURS BROKEN — ${result.findings.length} finding(s):`,
    ...sorted.map(
      (f) => `  ${f.severity === "high" ? "✗" : "!"} [${f.kind}] ${f.selector}\n    ${f.detail}`,
    ),
    "",
    "  These elements are invisible to someone using a high-contrast setting — a user who",
    "  turned on an accessibility feature and is least able to work around the result.",
  ].join("\n");
}
