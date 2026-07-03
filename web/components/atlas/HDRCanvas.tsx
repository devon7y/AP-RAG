"use client";

import { Canvas, type CanvasProps } from "@react-three/fiber";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { useAtlasStore, type CanvasMode } from "@/lib/atlas/store";

type BackendLike = {
  isWebGPUBackend?: boolean;
  context?: { getConfiguration?: () => { toneMapping?: { mode?: string } } | null };
};

/**
 * Negotiate the best pipeline, in order:
 * 1. WebGPU + rgba16float + extended tone mapping → TRUE HDR canvas (Chromium 129+):
 *    pixels above 1.0 light the display's EDR headroom.
 * 2. WebGPU, standard SDR tone mapping.
 * 3. three's WebGL2 fallback backend — same scene graph, SDR output.
 * The result is published to the store so scenes can scale emissive overshoot
 * (hdrBoost) to what the canvas can actually show.
 */
async function createRenderer(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
    outputType: THREE.HalfFloatType,
  });
  await renderer.init();

  let mode: CanvasMode = "webgl";
  const backend = (renderer as unknown as { backend?: BackendLike }).backend;
  if (backend?.isWebGPUBackend) {
    mode = "webgpu-sdr";
    try {
      const cfg = backend.context?.getConfiguration?.();
      if (cfg?.toneMapping?.mode === "extended") mode = "webgpu-hdr";
    } catch {
      /* getConfiguration not implemented — assume SDR */
    }
  }
  useAtlasStore.getState().setCanvasMode(mode);
  return renderer;
}

export default function HDRCanvas({
  children,
  clearColor = 0x0d0d0d,
  ...props
}: Omit<CanvasProps, "gl"> & { clearColor?: number }) {
  return (
    <Canvas
      dpr={[1, 2]}
      flat
      gl={(p) => createRenderer(p.canvas as HTMLCanvasElement)}
      onCreated={({ gl }) => {
        gl.setClearColor(clearColor, 1);
      }}
      {...props}
    >
      {children}
    </Canvas>
  );
}
