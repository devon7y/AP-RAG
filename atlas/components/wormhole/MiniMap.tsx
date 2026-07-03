"use client";

import { useEffect, useRef } from "react";
import type { CorpusData } from "@/lib/types";
import { clusterColor } from "@/lib/palette";

/**
 * Tiny top-down radar of the whole corpus: every chunk as a dim tinted dot,
 * plus this player's trail, current position, and the target paper's beacon.
 * The 9k-point base layer is rendered once per corpus and shared.
 */

const BASE_PX = 512; // internal resolution of the shared base layer

const baseCache = new WeakMap<CorpusData, HTMLCanvasElement>();

function baseLayer(corpus: CorpusData): HTMLCanvasElement {
  const hit = baseCache.get(corpus);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = BASE_PX;
  cv.height = BASE_PX;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgba(13,13,13,0.9)";
    ctx.fillRect(0, 0, BASE_PX, BASE_PX);
    const { atlas } = corpus;
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < atlas.n; i++) {
      ctx.fillStyle = clusterColor(atlas.cluster[i]);
      ctx.fillRect(atlas.pos2[i * 2] * BASE_PX, atlas.pos2[i * 2 + 1] * BASE_PX, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
  }
  baseCache.set(corpus, cv);
  return cv;
}

export default function MiniMap({
  corpus,
  path,
  targetPaper,
  color,
  size = 116,
}: {
  corpus: CorpusData;
  /** chunk indices visited so far (first = start, last = current) */
  path: number[];
  targetPaper: number;
  /** player trail color */
  color: string;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const S = size * 2; // 2x for crispness
    cv.width = S;
    cv.height = S;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(baseLayer(corpus), 0, 0, S, S);

    const px = (chunk: number): [number, number] => [
      corpus.atlas.pos2[chunk * 2] * S,
      corpus.atlas.pos2[chunk * 2 + 1] * S,
    ];

    // target beacon: diamond + halo at the target paper centroid
    const t = corpus.papers[targetPaper];
    if (t) {
      const tx = t.centroid[0] * S;
      const ty = t.centroid[1] * S;
      ctx.strokeStyle = "#199e70";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#5ad6a8";
      ctx.beginPath();
      ctx.moveTo(tx, ty - 5);
      ctx.lineTo(tx + 5, ty);
      ctx.lineTo(tx, ty + 5);
      ctx.lineTo(tx - 5, ty);
      ctx.closePath();
      ctx.fill();
    }

    // trail
    if (path.length > 1) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      const [x0, y0] = px(path[0]);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < path.length; i++) {
        const [x, y] = px(path[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // start marker
    if (path.length > 0) {
      const [sx, sy] = px(path[0]);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // current position: bright dot with glow
      const [cx, cy] = px(path[path.length - 1]);
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }, [corpus, path, targetPaper, color, size]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size }}
      className="rounded-lg border border-hairline"
      aria-label="minimap of the semantic space"
    />
  );
}
