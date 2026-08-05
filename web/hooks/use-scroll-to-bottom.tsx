import { useCallback, useEffect, useRef, useState } from "react";

/** Breathing room left above the prompt when it is pinned to the top. */
const PIN_GAP = 12;

export function useScrollToBottom() {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const isUserScrollingRef = useRef(false);
  // While pinned, the view holds the prompt at the top instead of following the answer
  // down — you read from where you asked, and the reference list appearing at the end
  // no longer yanks you past everything you were reading.
  const isPinnedRef = useRef(false);

  const lastElement = useCallback((selector: string): HTMLElement | null => {
    const nodes = containerRef.current?.querySelectorAll<HTMLElement>(selector);
    return nodes?.length ? nodes[nodes.length - 1] : null;
  }, []);

  /**
   * Size the trailing spacer so the pinned prompt can sit at the top even when what
   * follows it is shorter than the viewport. Re-measured as the answer streams, so the
   * page grows *into* the spacer rather than growing taller — which is what keeps the
   * prompt still without touching scrollTop at all. Written straight to the DOM: this
   * runs per token, and re-rendering the message list that often would be wasteful.
   */
  const measurePin = useCallback(() => {
    const container = containerRef.current;
    const end = endRef.current;
    if (!(container && end) || !isPinnedRef.current) {
      return;
    }
    const prompt = lastElement('[data-role="user"]');
    const last = lastElement("[data-role]");
    if (!(prompt && last)) {
      return;
    }
    const exchange =
      last.getBoundingClientRect().bottom - prompt.getBoundingClientRect().top;
    end.style.height = `${Math.max(0, container.clientHeight - exchange - PIN_GAP)}px`;
  }, [lastElement]);

  const releasePin = useCallback(() => {
    isPinnedRef.current = false;
    if (endRef.current) {
      endRef.current.style.height = "";
    }
  }, []);

  /** Put the newest prompt at the top of the viewport and hold it there. */
  const pinPrompt = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    isPinnedRef.current = true;
    measurePin(); // applied synchronously, so the scroll below can reach its target
    const prompt = lastElement('[data-role="user"]');
    if (!prompt) {
      return;
    }
    const offset =
      prompt.getBoundingClientRect().top -
      container.getBoundingClientRect().top;
    container.scrollTo({
      top: container.scrollTop + offset - PIN_GAP,
      behavior: "smooth",
    });
  }, [lastElement, measurePin]);

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  const checkIfAtBottom = useCallback(() => {
    if (!containerRef.current) {
      return true;
    }
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollTop + clientHeight >= scrollHeight - 100;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (!containerRef.current) {
        return;
      }
      // Going to the bottom is a deliberate "follow along" — the escape hatch from a
      // pinned prompt.
      releasePin();
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior,
      });
    },
    [releasePin]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let scrollTimeout: ReturnType<typeof setTimeout>;

    const handleScroll = () => {
      isUserScrollingRef.current = true;
      clearTimeout(scrollTimeout);

      const atBottom = checkIfAtBottom();
      setIsAtBottom(atBottom);
      isAtBottomRef.current = atBottom;

      scrollTimeout = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, [checkIfAtBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const onContentChange = () => {
      // Pinned: hold the prompt still and let the spacer absorb the answer's growth,
      // rather than following the text down to the reference list.
      if (isPinnedRef.current) {
        measurePin();
        return;
      }
      if (isAtBottomRef.current && !isUserScrollingRef.current) {
        requestAnimationFrame(() => {
          container.scrollTo({
            top: container.scrollHeight,
            behavior: "instant",
          });
          setIsAtBottom(true);
          isAtBottomRef.current = true;
        });
      }
    };

    const mutationObserver = new MutationObserver(onContentChange);
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const resizeObserver = new ResizeObserver(onContentChange);
    resizeObserver.observe(container);

    for (const child of container.children) {
      resizeObserver.observe(child);
    }

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [measurePin]);

  function onViewportEnter() {
    setIsAtBottom(true);
    isAtBottomRef.current = true;
  }

  function onViewportLeave() {
    setIsAtBottom(false);
    isAtBottomRef.current = false;
  }

  const reset = useCallback(() => {
    setIsAtBottom(true);
    isAtBottomRef.current = true;
    isUserScrollingRef.current = false;
    releasePin();
  }, [releasePin]);

  return {
    containerRef,
    endRef,
    pinPrompt,
    isAtBottom,
    scrollToBottom,
    onViewportEnter,
    onViewportLeave,
    reset,
  };
}
