"use client";

import { useEffect, useState } from "react";

/**
 * Detect HDR/EDR display capability via `(dynamic-range: high)`.
 * SSR-safe (false on server). Re-evaluates when the window moves displays.
 */
export function useEDR(): boolean {
  const [edr, setEdr] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(dynamic-range: high)");
    const update = () => {
      setEdr(mq.matches);
      document.body?.setAttribute("data-edr", mq.matches ? "on" : "off");
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return edr;
}
