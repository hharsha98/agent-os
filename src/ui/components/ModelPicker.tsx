// The "Change model" picker: OpenRouter's whole catalog (models that can use
// tools) in one window -- search, "Free only / All", a sort order, a paged list
// with plain badges, and on the right the chosen model with the "give it to"
// step (ModelApplyPanel).
//
// It is reusable: it knows nothing about Hermes or OpenClaw. What a model can
// be given TO is the `targets` list, how it is applied is the `apply`
// function, and the badges come from `recommend` (a "recommended" or
// "experimental" tag per model) and `filter` (hide models that can't work).
// Hermes and OpenClaw are wired up in AgentModelPicker.tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Search, X } from "lucide-react";
import ModelApplyPanel from "./ModelApplyPanel";
import StatusMark from "./StatusMark";
import OpenAddress from "./OpenAddress";
import type { CatalogModel, CatalogSort } from "../../setupApi";
import { cancelOpenRouterConnect, friendlyError, getModelCatalog, openOpenRouterModels } from "../../setupApi";
import type { ApplyFn, ApplySubject, ModelBadge, ModelTarget } from "../modelPickerShared";
import { DEFAULT_BADGE_LABELS, costNote, formatRetireDate, formatTokens } from "../modelPickerShared";
import "../modelPicker.css";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';
const SEARCH_DELAY_MS = 250;

const SORTS: { value: CatalogSort; label: string }[] = [
  { value: "agentic-high-to-low", label: "Best for agents" },
  { value: "newest", label: "Newest" },
  { value: "pricing-low-to-high", label: "Cheapest" },
  { value: "context-high-to-low", label: "Biggest context" }
];

export interface ModelPickerProps {
  title?: string;
  targets: ModelTarget[];
  // Ticked when a model is chosen (all that can be ticked when not given).
  initialTargets?: string[];
  apply: ApplyFn;
  // A tag per model, for whoever the picker is used for ("works with Hermes").
  recommend?: (model: CatalogModel) => ModelBadge | null;
  badgeLabels?: Partial<Record<ModelBadge, string>>;
  // Hides models that can't work for the caller.
  filter?: (model: CatalogModel) => boolean;
  // The words on the Apply button ("Use for this run" ...), given the ticked targets' names.
  applyLabel?: (targetLabels: string[]) => string;
  onClose: () => void;
  // At least one target really was changed.
  onApplied?: () => void;
}

export default function ModelPicker({ title = "Change model", targets, initialTargets, apply, recommend, badgeLabels, filter, applyLabel, onClose, onApplied }: ModelPickerProps) {
  const labels = { ...DEFAULT_BADGE_LABELS, ...badgeLabels };

  // ---- what to list --------------------------------------------------------------------
  const [free, setFree] = useState<"only" | "all">("all");
  const [sort, setSort] = useState<CatalogSort>("agentic-high-to-low");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);

  const [rows, setRows] = useState<CatalogModel[]>([]);
  const [meta, setMeta] = useState({ total: 0, hasMore: false, source: "public" as "public" | "account", keyRejected: false });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);

  // ---- what is chosen and what is happening ------------------------------------------------
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [panelKey, setPanelKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [openNote, setOpenNote] = useState<{ text: string; url?: string } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const flowRef = useRef<string | null>(null);
  flowRef.current = flowId;
  const busyRef = useRef(false);
  busyRef.current = busy;

  // Typing waits a moment, so each key press isn't a request to OpenRouter.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const id = (requestId.current += 1);
    setStatus("loading");
    setErrorText("");
    getModelCatalog({ free, sort, q: search, offset: 0, flowId })
      .then((res) => {
        if (id !== requestId.current) return;
        if (res.error) {
          setErrorText(res.error);
          setStatus("error");
          return;
        }
        setRows(res.models);
        setMeta({ total: res.total, hasMore: res.hasMore, source: res.source, keyRejected: Boolean(res.keyRejected) });
        setStatus("ready");
      })
      .catch((error) => {
        if (id !== requestId.current) return;
        setErrorText(friendlyError(error, "Couldn't load OpenRouter's models."));
        setStatus("error");
      });
  }, [free, sort, search, flowId, attempt]);

  async function showMore() {
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const res = await getModelCatalog({ free, sort, q: search, offset: rows.length, flowId });
      if (id !== requestId.current) return;
      if (res.error) {
        setErrorText(res.error);
        return;
      }
      setRows((current) => [...current, ...res.models.filter((model) => !current.some((known) => known.id === model.id))]);
      setMeta((current) => ({ ...current, total: res.total, hasMore: res.hasMore }));
    } catch (error) {
      if (id === requestId.current) setErrorText(friendlyError(error, "Couldn't load more models."));
    } finally {
      setLoadingMore(false);
    }
  }

  // The connection only lives while this window is open: an unused one is
  // forgotten on the server when the window closes.
  useEffect(() => {
    return () => {
      if (flowRef.current) void cancelOpenRouterConnect(flowRef.current).catch(() => undefined);
    };
  }, []);

  // ---- the window itself: focus in, Escape out, Tab stays inside --------------------------
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    searchRef.current?.focus();
    return () => {
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [requestClose]);

  // ---- helpers --------------------------------------------------------------------------
  async function openPage(model: CatalogModel) {
    setOpenNote(null);
    try {
      const result = await openOpenRouterModels(model.id);
      if (!result.opened) setOpenNote({ text: "Couldn't open your browser by itself. Open this page:", url: result.url });
    } catch (error) {
      setOpenNote({ text: friendlyError(error, "Couldn't open OpenRouter's page.") });
    }
  }

  function choose(model: CatalogModel) {
    if (busy) return;
    setSelected(model);
    setView("detail");
    setPanelKey((n) => n + 1);
  }

  const visible = useMemo(() => (filter ? rows.filter(filter) : rows), [rows, filter]);

  const subject: ApplySubject | null = useMemo(
    () => (selected ? { title: selected.name, model: selected, notes: selected.free ? [] : [costNote(selected)] } : null),
    [selected]
  );

  function badgesFor(model: CatalogModel) {
    const out: { key: string; text: string; tone: "ok" | "warn" | "plain" }[] = [];
    const tag = recommend?.(model) ?? null;
    if (tag) out.push({ key: tag, text: labels[tag], tone: tag === "recommended" ? "ok" : "warn" });
    if (model.isNew) out.push({ key: "new", text: "New", tone: "plain" });
    if (model.expiresAt) out.push({ key: "retiring", text: `Retiring ${formatRetireDate(model.expiresAt)}`, tone: "warn" });
    return out;
  }

  const countText = status !== "ready" ? "" : filter ? `${visible.length} models` : meta.hasMore ? `Showing ${rows.length} of ${meta.total} models` : `${meta.total} models`;

  return (
    <div className="os-mp__backdrop" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div className="os-mp" role="dialog" aria-modal="true" aria-labelledby="os-mp-title" data-view={view} ref={dialogRef}>
        <header className="os-mp__head">
          <div>
            <h2 id="os-mp-title" className="os-mp__title">
              {title}
            </h2>
            <p className="os-mp-sub">
              OpenRouter&apos;s models that can use tools
              {meta.source === "account" ? " · only the ones your account may use" : ""}
            </p>
          </div>
          <button type="button" className="os-btn os-btn--ghost os-mp__close" onClick={requestClose} disabled={busy} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="os-mp__body">
          <section className="os-mp__list" aria-label="Models">
            <div className="os-mp__toolbar">
              <label className="os-mp-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  maxLength={100}
                  placeholder="Search models"
                  aria-label="Search models"
                  onChange={(event) => setQuery(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="os-mp-seg" role="group" aria-label="Price">
                <button type="button" aria-pressed={free === "only"} onClick={() => setFree("only")}>
                  Free only
                </button>
                <button type="button" aria-pressed={free === "all"} onClick={() => setFree("all")}>
                  All
                </button>
              </div>
              <label className="os-mp-sort">
                <span className="os-micro">Sort</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)} aria-label="Sort models">
                  {SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="os-mp-count" role="status">
              {countText}
              {meta.keyRejected ? " · OpenRouter didn't accept the connection, so this is the public list" : ""}
            </p>
            {openNote ? (
              <p className="os-mp-hint os-mp-hint--warn" role="status">
                <StatusMark kind="warn" label="note" />
                <span>
                  {openNote.text}{" "}
                  {openNote.url ? (
                    <OpenAddress href={openNote.url} copyLabel="Copy the address">
                      {openNote.url}
                    </OpenAddress>
                  ) : null}
                </span>
              </p>
            ) : null}

            {status === "loading" ? (
              <ul className="os-mp-rows" aria-busy="true" aria-label="Loading models">
                {Array.from({ length: 6 }, (_, index) => (
                  <li key={index} className="os-mp-row os-mp-row--skeleton os-skeleton" />
                ))}
              </ul>
            ) : status === "error" ? (
              <div className="os-mp-state" role="alert">
                <p className="os-mp-error">
                  <StatusMark kind="error" /> {errorText}
                </p>
                <button type="button" className="os-btn os-btn--secondary" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              </div>
            ) : !visible.length ? (
              <div className="os-mp-state">
                <p className="os-mp-hint">
                  {free === "only" && !search
                    ? "OpenRouter has no free models that can use tools right now. Switch to All to see paid ones."
                    : free === "only"
                      ? "No free model matches that search. Switch to All to include paid ones."
                      : "No model matches that search."}
                </p>
              </div>
            ) : (
              <ul className="os-mp-rows" role="radiogroup" aria-label="Models">
                {visible.map((model) => {
                  const picked = selected?.id === model.id;
                  return (
                    <li key={model.id} className={`os-mp-row${picked ? " os-mp-row--picked" : ""}`}>
                      <label className="os-mp-row__main">
                        <input
                          type="radio"
                          name="os-mp-model"
                          className="os-mp-row__radio"
                          checked={picked}
                          disabled={busy}
                          onChange={() => choose(model)}
                        />
                        <span className="os-mp-row__body">
                          <span className="os-mp-row__top">
                            <strong className="os-mp-row__name">{model.name}</strong>
                            <span className={`os-mp-price${model.free ? " os-mp-price--free" : ""}`}>{model.pricing.label}</span>
                          </span>
                          <span className="os-mp-row__id os-mono">{model.id}</span>
                          <span className="os-mp-row__meta">
                            <span>{model.contextLength ? `${formatTokens(model.contextLength)} context` : "context not listed"}</span>
                            {badgesFor(model).map((badge) => (
                              <span key={badge.key} className={`os-mp-badge os-mp-badge--${badge.tone}`}>
                                {badge.text}
                              </span>
                            ))}
                          </span>
                        </span>
                      </label>
                      <button
                        type="button"
                        className="os-mp-row__open"
                        tabIndex={-1}
                        onClick={() => void openPage(model)}
                        aria-label={`Open ${model.name} on OpenRouter`}
                        title="Open on OpenRouter"
                      >
                        Open on OpenRouter <ExternalLink size={12} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {status === "ready" && meta.hasMore ? (
              <div className="os-mp-more">
                <button type="button" className="os-btn os-btn--secondary" onClick={() => void showMore()} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Show more"}
                </button>
              </div>
            ) : null}
          </section>

          <section className="os-mp__detail" aria-label="Chosen model">
            {selected && subject ? (
              <div className="os-mp-detail">
                <button type="button" className="os-mp-back os-btn os-btn--ghost" onClick={() => setView("list")} disabled={busy}>
                  <ArrowLeft size={14} aria-hidden="true" /> Back to the list
                </button>
                <header className="os-mp-detail__head">
                  <h3>{selected.name}</h3>
                  <p className="os-mp-detail__id os-mono">{selected.id}</p>
                  <div className="os-mp-detail__badges">
                    <span className={`os-mp-price${selected.free ? " os-mp-price--free" : ""}`}>{selected.pricing.label}</span>
                    {badgesFor(selected).map((badge) => (
                      <span key={badge.key} className={`os-mp-badge os-mp-badge--${badge.tone}`}>
                        {badge.text}
                      </span>
                    ))}
                  </div>
                  <button type="button" className="os-mp-link" onClick={() => void openPage(selected)}>
                    Open on OpenRouter <ExternalLink size={12} aria-hidden="true" />
                  </button>
                </header>
                {selected.description ? <p className="os-mp-detail__desc">{selected.description}</p> : null}
                <dl className="os-mp-facts">
                  <div>
                    <dt>Context</dt>
                    <dd className="os-mono">{selected.contextLength ? formatTokens(selected.contextLength) : "not listed"}</dd>
                  </div>
                  <div>
                    <dt>Max reply</dt>
                    <dd className="os-mono">{selected.maxCompletionTokens ? formatTokens(selected.maxCompletionTokens) : "not listed"}</dd>
                  </div>
                  <div>
                    <dt>Understands</dt>
                    <dd>{selected.inputModalities.length ? selected.inputModalities.join(", ") : "text"}</dd>
                  </div>
                </dl>
                {selected.expiresAt ? (
                  <p className="os-mp-hint os-mp-hint--warn">
                    <StatusMark kind="warn" label="note" /> OpenRouter plans to retire this model on {formatRetireDate(selected.expiresAt)}.
                  </p>
                ) : null}
                <ModelApplyPanel
                  key={`${selected.id}:${panelKey}`}
                  subject={subject}
                  targets={targets}
                  initialTargets={initialTargets}
                  apply={apply}
                  applyLabel={applyLabel}
                  flowId={flowId}
                  onFlowChange={setFlowId}
                  onBusyChange={setBusy}
                  onApplied={onApplied}
                  onPickAnother={() => {
                    setView("list");
                    setSelected(null);
                  }}
                />
              </div>
            ) : (
              <p className="os-mp-empty">Pick a model on the left to see its details and give it to an agent.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
