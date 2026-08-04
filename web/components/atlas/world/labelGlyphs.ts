"use client";

import { useEffect, useState } from "react";
import * as THREE from "three";

/**
 * In-scene label glyphs. DOM text composites in SDR and clamps at white, so
 * the map labels' visible glyphs are rasterized here to CanvasTextures on
 * sprites INSIDE the WebGPU canvas — multiplying the sprite color by hdrBoost
 * pushes the white fill past 1.0 into the display's EDR headroom, exactly as
 * the beacons do (and as the selection Ring already proves works with a stock
 * SpriteMaterial). On SDR canvases boost is 1.0 and the glyph renders exactly
 * like the old DOM text. The DOM copy of each label survives only as an
 * invisible hit-area / measurement box (see .map-label--ghost).
 *
 * The drawing replicates the .map-label look: white fill over a 3px black
 * stroke (stroke first = paint-order: stroke fill), one tight dark shadow for
 * separation and one faint white halo to keep the glyph forward.
 */

export interface LabelStyle {
  /** CSS font-size the glyph should occupy on screen */
  fontPx: number;
  /** letter-spacing in em (Tailwind tracking-[Nem]) */
  trackingEm?: number;
  italic?: boolean;
  /** wrap lane in CSS px; omit for a single line */
  maxWidth?: number;
}

export interface LabelGlyph {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  /** rendered box in CSS px (includes stroke/shadow padding) */
  w: number;
  h: number;
}

/* ---- display font ------------------------------------------------------- */

/** A hidden span carrying the real label styling, so both the font resolution
 *  and the line breaking come from the browser rather than from canvas
 *  approximations of it. */
function withProbe<T>(style: LabelStyle, fn: (probe: HTMLSpanElement) => T): T {
  const host = document.querySelector(".atlas-app") ?? document.body;
  const probe = document.createElement("span");
  probe.className = "map-label font-display";
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;" +
    `font-size:${style.fontPx}px;letter-spacing:${style.trackingEm ?? 0}em;` +
    `font-style:${style.italic ? "italic" : "normal"};`;
  host.appendChild(probe);
  try {
    return fn(probe);
  } finally {
    probe.remove();
  }
}

/** Canvas font shorthand matching the DOM label (weight and style included —
 *  Fraunces is variable, so guessing "400" would measure the wrong face). */
function canvasFont(probe: HTMLSpanElement, pxSize: number): string {
  const cs = getComputedStyle(probe);
  const family = cs.fontFamily || "Georgia, serif";
  return `${cs.fontStyle || "normal"} ${cs.fontWeight || "400"} ${pxSize}px ${family}`;
}

/** supersample factor: keeps a constant-screen-size sprite crisp */
function superSample(): number {
  return Math.min(window.devicePixelRatio || 1, 2) * 2;
}

/**
 * Lay the text out in the probe and read back the line boxes the BROWSER
 * produced, rather than re-deriving them from canvas metrics. Measuring the
 * breaks myself kept collapsing wrapped summit names onto one line: canvas
 * runs narrower than layout against a variable font with optical sizing, and
 * these labels are truncated to 34-38 chars, which lands them right at the
 * edge of the lane where a few pixels decide the break. Mirroring the browser
 * reproduces the old DOM wrapping by construction.
 */
function layoutLines(
  text: string,
  style: LabelStyle,
): { lines: string[]; width: number; font: string } {
  return withProbe(style, (probe) => {
    if (style.maxWidth) {
      probe.style.whiteSpace = "normal";
      probe.style.display = "inline-block";
      probe.style.maxWidth = `${style.maxWidth}px`;
    }
    probe.textContent = text;
    const font = canvasFont(probe, style.fontPx * superSample());
    const node = probe.firstChild;
    if (!node) return { lines: [text], width: 0, font };

    const range = document.createRange();
    const lines: string[] = [];
    let cur = "";
    let top: number | null = null;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      // a space collapsed at a line break has no box — it belongs to neither
      // line and is trimmed away below
      if (r.width || r.height) {
        if (top !== null && r.top - top > 0.5) {
          lines.push(cur.trim());
          cur = "";
        }
        top = r.top;
      }
      cur += text[i];
    }
    if (cur.trim()) lines.push(cur.trim());

    return {
      lines: lines.length ? lines : [text],
      width: probe.getBoundingClientRect().width,
      font,
    };
  });
}

/** Flips once when document.fonts settles, so glyphs re-rasterize with the
 *  real display font instead of the serif fallback's metrics. */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(
    () => typeof document !== "undefined" && document.fonts?.status === "loaded",
  );
  useEffect(() => {
    if (ready || !document.fonts) return;
    let alive = true;
    document.fonts.ready.then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [ready]);
  return ready;
}

/* ---- rasterization ------------------------------------------------------ */

/** stroke half-width + shadow radius, in CSS px, around the text box */
const PAD = 10;
const LINE_HEIGHT = 1.35;

export function makeLabelGlyph(text: string, style: LabelStyle): LabelGlyph {
  const { fontPx, trackingEm = 0, italic = false } = style;
  const ss = superSample();
  const { lines, width: domWidth, font } = layoutLines(text, style);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const setup = () => {
    ctx.font = font;
    // an unparseable shorthand leaves the context on 10px sans-serif, which
    // would silently render every label as a tiny scaled-up smudge
    if (!ctx.font.includes(`${fontPx * ss}px`))
      ctx.font = `${italic ? "italic " : ""}${fontPx * ss}px Georgia, serif`;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
      `${trackingEm * fontPx * ss}px`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
  };
  setup();

  const lineH = fontPx * LINE_HEIGHT * ss;
  // the canvas may still draw a hair wider than the DOM measured; size the
  // texture to whichever is larger so no glyph is clipped
  let textW = domWidth * ss;
  for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
  canvas.width = Math.ceil(textW + PAD * 2 * ss);
  canvas.height = Math.ceil(lines.length * lineH + PAD * 2 * ss);
  setup(); // resizing reset the context state

  const cx = canvas.width / 2;
  const y0 = PAD * ss + lineH / 2;
  const at = (fn: (line: string, x: number, y: number) => void) =>
    lines.forEach((l, i) => fn(l, cx, y0 + i * lineH));

  // outline behind the fill, with the tight dark separation shadow
  ctx.strokeStyle = "rgba(0,0,0,0.88)";
  ctx.lineWidth = 3 * ss;
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 6 * ss;
  at((l, x, y) => ctx.strokeText(l, x, y));

  // white fill with the faint halo that keeps the glyph forward. ONE pass:
  // filling twice stacked alpha on the antialiased edges and made the glyph
  // heavier than the DOM text it replaces, which HDR then amplified.
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(255,255,255,0.4)";
  ctx.shadowBlur = 3 * ss;
  at((l, x, y) => ctx.fillText(l, x, y));

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false, // labels float over terrain, like the DOM ones did
    opacity: 0,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 20; // over the selection rings (10)
  sprite.frustumCulled = false;

  return { sprite, material, texture, w: canvas.width / ss, h: canvas.height / ss };
}

export function disposeLabelGlyph(g: LabelGlyph): void {
  g.material.dispose();
  g.texture.dispose();
}

/**
 * Label luminance from the canvas' hdrBoost. The gain applies only to the
 * headroom ABOVE 1.0, so an SDR canvas (boost 1) always lands on exactly 1
 * and the glyph can never blow out there.
 *
 * Text wants FAR less overshoot than the beacons, for two compounding
 * reasons: a glyph holds its peak value across every pixel of every stroke
 * while a beacon's peak lives in a small core with a falloff around it, and
 * the glyph is white, whose luminance is roughly triple that of a saturated
 * cluster hue at the same component value. So a label matched to the beacon
 * multiplier reads several times brighter than the beacons it sits among.
 * At the stock boost of 2.2 this lands on ~1.25 — a visible lift into the
 * headroom without the glare.
 */
const HDR_TEXT_GAIN = 0.2;
export function labelBoost(hdrBoost: number): number {
  return 1 + Math.max(hdrBoost - 1, 0) * HDR_TEXT_GAIN;
}

/** Scale the sprite so the glyph occupies its CSS-pixel box on screen,
 *  whatever the camera distance (mirrors drei Html sizing). */
export function scaleLabelGlyph(
  g: LabelGlyph,
  camera: THREE.Camera,
  viewportHeightPx: number,
  dist: number,
): void {
  const cam = camera as THREE.PerspectiveCamera;
  const worldPerPx = cam.isPerspectiveCamera
    ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5)) / viewportHeightPx
    : 1 / ((camera as unknown as THREE.OrthographicCamera).zoom || 1);
  g.sprite.scale.set(g.w * worldPerPx, g.h * worldPerPx, 1);
}
