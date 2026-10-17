// The ⌘K / Ctrl+K command palette: jump to any page or run a few actions without
// the mouse. Keyboard first: type to filter, ↑ ↓ to move, Enter to run, Esc to
// close. A real dialog (focus goes in, Tab stays inside, focus returns to where
// it was) with an ARIA combobox + listbox, so a screen reader reads each option.
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface PaletteItem {
  id: string;
  label: string;
  // The group heading it sits under ("Actions", "Pages", "Labs").
  group: string;
  // A short extra line on the right ("Asks first", "3 of 4 done").
  hint?: string;
  // Extra words that find it ("halt kill cancel").
  keywords?: string;
  icon?: LucideIcon;
  run: () => void;
}

function matches(item: PaletteItem, query: string) {
  const haystack = `${item.label} ${item.keywords || ""} ${item.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export default function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const shown = useMemo(() => {
    const found = items.filter((item) => matches(item, query));
    const first = query.trim().toLowerCase().split(/\s+/)[0];
    if (!first) return found;
    // Names that start with what was typed come first; the rest keep their order.
    return [
      ...found.filter((item) => item.label.toLowerCase().startsWith(first)),
      ...found.filter((item) => !item.label.toLowerCase().startsWith(first))
    ];
  }, [items, query]);

  // Group headings in the order the items arrive.
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const item of shown) if (!order.includes(item.group)) order.push(item.group);
    return order.map((name) => ({ name, entries: shown.filter((item) => item.group === name) }));
  }, [shown]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const optionId = (item: PaletteItem) => `os-palette-opt-${item.id}`;
  const activeItem = flat[Math.min(active, Math.max(0, flat.length - 1))];

  useEffect(() => {
    if (activeItem) document.getElementById(optionId(activeItem))?.scrollIntoView({ block: "nearest" });
  }, [activeItem]);

  function activate(item: PaletteItem | undefined) {
    if (!item) return;
    // Close first, so focus is back where it was before the action moves it.
    onClose();
    window.setTimeout(item.run, 0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flat.length) setActive((index) => (index + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length) setActive((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(activeItem);
    } else if (event.key === "Tab") {
      // The input is the only stop in here: Tab (either way) stays on it.
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <div className="os-palette__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="os-palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="os-palette__search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="os-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            aria-label="Search pages and actions"
            placeholder="Type a page or an action…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="os-kbd" aria-hidden="true">
            Esc
          </span>
        </div>
        <div className="os-palette__list" id="os-palette-list" role="listbox" aria-label="Pages and actions">
          {groups.map((group) => (
            <div key={group.name} role="group" aria-labelledby={`os-palette-group-${group.name}`}>
              <div className="os-palette__group os-micro" id={`os-palette-group-${group.name}`}>
                {group.name}
              </div>
              {group.entries.map((item) => {
                const Icon = item.icon;
                const isActive = item === activeItem;
                return (
                  <div
                    key={item.id}
                    id={optionId(item)}
                    role="option"
                    aria-selected={isActive}
                    className={`os-palette__option${isActive ? " is-active" : ""}`}
                    onMouseMove={() => setActive(flat.indexOf(item))}
                    onClick={() => activate(item)}
                  >
                    {Icon ? <Icon size={16} aria-hidden="true" /> : <span className="os-palette__icon-gap" aria-hidden="true" />}
                    <span className="os-palette__label">{item.label}</span>
                    {item.hint ? <span className="os-palette__hint">{item.hint}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 ? (
            <p className="os-palette__empty" role="status">
              Nothing matches &ldquo;{query}&rdquo;. Try &ldquo;runs&rdquo;, &ldquo;setup&rdquo; or &ldquo;stop&rdquo;, or clear the box to
              see everything.
            </p>
          ) : null}
        </div>
        <p className="os-palette__foot os-micro" aria-hidden="true">
          ↑ ↓ move · Enter run · Esc close
        </p>
      </div>
    </div>
  );
}
