import type { ReactNode } from "react";

// A small, safe Markdown reader for the Workspace preview. It draws headings
// (#, ##, ###), bullet and numbered lists, fenced code, **bold** and `code`,
// and nothing else: no links, no images, no raw HTML. Every piece of text goes
// through React, which escapes it, so a note can never inject markup. Anything
// it does not understand is shown as plain text.

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "p"; text: string };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const STARTS_A_BLOCK = /^(#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*```)/;

function parse(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence (or the end of the text)
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      i += 1;
      continue;
    }
    const bullet = BULLET.test(line);
    if (bullet || NUMBERED.test(line)) {
      const pattern = bullet ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length) {
        const match = pattern.exec(lines[i]);
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      blocks.push({ kind: bullet ? "ul" : "ol", items });
      continue;
    }
    // A paragraph runs until a blank line or the start of another block.
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !STARTS_A_BLOCK.test(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "p", text: paragraph.join(" ") });
  }
  return blocks;
}

function inline(text: string, base: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let index = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? (
        <strong key={`${base}-${index}`}>{match[1]}</strong>
      ) : (
        <code key={`${base}-${index}`}>{match[2]}</code>
      )
    );
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Headings are drawn as h3, h4 and h5 (not h1 and h2): the page's own h1 is
// "Workspace" and the preview's h2 is the file name, so a note's "# Title"
// sits one level below them.
export default function MiniMarkdown({ source }: { source: string }) {
  return (
    <div className="os-md">
      {parse(source).map((block, n) => {
        const key = `b${n}`;
        switch (block.kind) {
          case "heading":
            return block.level === 1 ? (
              <h3 key={key} className="os-md__h1">{inline(block.text, key)}</h3>
            ) : block.level === 2 ? (
              <h4 key={key} className="os-md__h2">{inline(block.text, key)}</h4>
            ) : (
              <h5 key={key} className="os-md__h3">{inline(block.text, key)}</h5>
            );
          case "ul":
            return <ul key={key}>{block.items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={key}>{block.items.map((item, j) => <li key={j}>{inline(item, `${key}-${j}`)}</li>)}</ol>;
          case "code":
            return <pre key={key} className="os-md__code">{block.text}</pre>;
          default:
            return <p key={key}>{inline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
