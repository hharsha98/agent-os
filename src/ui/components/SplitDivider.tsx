// The divider between the two panes of split view (the prototype's .ss-div; spec SP4, Split): drag it, or use the
// arrow keys (2 % a press) and Home (back to the middle); a double click puts it back in the middle too. It reports the
// left pane's share of the panes' width (28 % to 72 %, splitShared.ts); the page keeps it with the rest of split view.
// The pointer is captured while dragging, so moving over a terminal never selects text or reaches the agent.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { SPLIT_DEFAULT, SPLIT_DIVIDER_LABEL, SPLIT_GAP_PX, SPLIT_MAX, SPLIT_MIN, dividerKeyRatio, ratioFromPointer } from "../splitShared";

export default function SplitDivider({
  ratio,
  containerRef,
  onRatio,
  onDragChange
}: {
  ratio: number;
  containerRef: RefObject<HTMLDivElement>;
  onRatio: (ratio: number) => void;
  // True when a drag starts, false when it ends: the page keeps split view in sessionStorage once, at the end.
  onDragChange?: (dragging: boolean) => void;
}) {
  const dragging = useRef(false);
  // Where inside the grip the pointer took hold (from the grip's centre), so the grip never jumps when the drag starts.
  const grab = useRef(0);
  const [drag, setDrag] = useState(false);
  // Split view can go away in the middle of a drag (a pane's session left): the page is still told the drag is over.
  const latestChange = useRef(onDragChange);
  latestChange.current = onDragChange;
  useEffect(
    () => () => {
      if (dragging.current) latestChange.current?.(false);
    },
    []
  );

  function stop() {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(false);
    onDragChange?.(false);
  }
  function follow(event: PointerEvent<HTMLDivElement>) {
    const box = containerRef.current?.getBoundingClientRect();
    const next = box ? ratioFromPointer(event.clientX - grab.current, box.left, box.width, SPLIT_GAP_PX) : null;
    if (next !== null) onRatio(next);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = dividerKeyRatio(event.key, ratio);
    if (next === null) return;
    event.preventDefault();
    onRatio(next);
  }

  return (
    <div
      className={drag ? "os-sess-split__divider is-drag" : "os-sess-split__divider"}
      role="separator"
      aria-orientation="vertical"
      aria-label={SPLIT_DIVIDER_LABEL}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // A stale pointer id makes setPointerCapture throw; without the capture a drag could lose its end, so no drag.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          return;
        }
        const grip = event.currentTarget.getBoundingClientRect();
        grab.current = event.clientX - (grip.left + grip.width / 2);
        dragging.current = true;
        setDrag(true);
        onDragChange?.(true);
      }}
      onPointerMove={(event) => {
        if (dragging.current) follow(event);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => onRatio(SPLIT_DEFAULT)}
      onKeyDown={onKeyDown}
    >
      <i aria-hidden="true" />
    </div>
  );
}
