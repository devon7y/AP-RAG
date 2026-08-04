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

let familyCache: string | null = null;

/** Resolve the atlas display font (--font-display via next/font) for canvas. */
function displayFontFamily(): string {
  if (familyCache) return familyCache;
  const host = document.querySelector(".atlas-app") ?? document.body;
  const probe = document.createElement("span");
  probe.className = "font-display";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  host.appendChild(probe);
  const fam = getComputedStyle(probe).fontFamily || "Georgia, serif";
  probe.remove();
  familyCache = fam;
  return fam;
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
  const { fontPx, trackingEm = 0, italic = false, maxWidth } = style;
  // supersample over DPR so the constant-screen-size sprite stays crisp
  const ss = Math.min(window.devicePixelRatio || 1, 2) * 2;
  const font = `${italic ? "italic " : ""}${fontPx * ss}px ${displayFontFamily()}`;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const setup = () => {
    ctx.font = font;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
      `${trackingEm * fontPx * ss}px`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
  };
  setup();

  const lines: string[] = [];
  if (maxWidth) {
    const limit = maxWidth * ss;
    let cur = "";
    for (const word of text.split(/\s+/)) {
      const trial = cur ? `${cur} ${word}` : word;
      if (cur && ctx.measureText(trial).width > limit) {
        lines.push(cur);
        cur = word;
      } else cur = trial;
    }
    if (cur) lines.push(cur);
  } else lines.push(text);

  const lineH = fontPx * LINE_HEIGHT * ss;
  let textW = 0;
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

  // faint white halo keeps the glyph forward…
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(255,255,255,0.4)";
  ctx.shadowBlur = 3 * ss;
  at((l, x, y) => ctx.fillText(l, x, y));

  // …and a clean fill on top
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
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
