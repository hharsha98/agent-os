// A file path or a diff line with its hidden characters made visible (Task U7, fix round 1). A right-to-left override or
// an isolate in a name or a line reorders what the person reads (the "Trojan Source" trick), and a control character
// draws as nothing, so each one is drawn as a dim token (`<U+202E>`, `\x1B`) where it sits. Text only: every piece is a
// React text node, never HTML. The pieces come from changesShared.ts (visiblePieces), which the logic test covers.
import { memo } from "react";
import { visiblePieces } from "../changesShared";

function VisibleText({ text }: { text: string }) {
  return (
    <>
      {visiblePieces(text).map((piece, index) =>
        piece.hidden ? (
          <span key={index} className="os-hidden-char" title={piece.label ?? undefined}>
            {piece.text}
          </span>
        ) : (
          piece.text
        )
      )}
    </>
  );
}

export default memo(VisibleText);
