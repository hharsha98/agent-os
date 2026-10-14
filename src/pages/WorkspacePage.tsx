// The Workspace page: every file Agent OS and your agents have kept, who saved
// each one, a preview, and a form for a new note. It loads the whole list once
// (GET /api/workspace, at most 500 files) and filters it in the browser. One
// file's text comes from GET /api/workspace/file, a note goes out through
// POST /api/workspace/files, and "Undo this save" calls the Team Room's own
// undo route. There is no polling: the list reloads after this page's own
// actions and when Refresh is pressed. A reply that arrives after the person has
// left the page changes nothing and never navigates.
import {
  Check,
  File as FileIcon,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  History,
  Plus,
  RefreshCw,
  ServerOff,
  Users,
  X,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { getProductStatus, getWorkspaceListing } from "../api";
import { DEMO_BADGE } from "../demo";
import { navigateTo, queryParam } from "../nav";
import type { WorkspaceFile, WorkspaceListedFile, WorkspaceListing } from "../types";
import Banner from "../ui/components/Banner";
import EmptyState from "../ui/components/EmptyState";
import PageHeader from "../ui/components/PageHeader";
import { agoLabel } from "../ui/components/RelativeTime";
import WorkspaceNoteForm from "../ui/components/WorkspaceNoteForm";
import WorkspacePreview, { SavedByWords } from "../ui/components/WorkspacePreview";
import { canRevealInFinder, revealInFinder } from "../ui/desktop";
import { withTimeout } from "../ui/homeShared";
import {
  ALWAYS_CHIPS,
  LIST_LIMIT,
  NO_FILES_BODY,
  OPTIONAL_CHIPS,
  PANE_LABEL,
  TYPE_INFO,
  UnreadableListing,
  countByType,
  displayPath,
  filesWord,
  filterFiles,
  folderFromQuery,
  groupFiles,
  inFolder,
  isListing,
  listProblem,
  nameInGroup,
  paneMode,
  sandboxPaths,
  savedByView,
  typeOf,
  whenTitle,
  workspaceLede,
  type ListProblem,
  type Notice,
  type TypeFilter,
  type TypeKey
} from "../ui/workspaceShared";
import "../ui/workspace.css";

// A request that does not answer in time stops waiting, so the page never
// loads for ever and the Refresh button never stays switched off (Review Focus 5).
const LIST_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 8000;

const ICONS: Record<TypeKey, LucideIcon> = {
  md: FileText,
  txt: FileIcon,
  html: FileCode,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  pdf: FileIcon,
  other: FileIcon
};

type LoadState = "loading" | "ready" | "error";

function FileRow({ file, current, onSelect }: { file: WorkspaceListedFile; current: boolean; onSelect: (id: string) => void }) {
  const type = typeOf(file);
  const Icon = ICONS[type];
  const saved = savedByView(file.savedBy);
  return (
    <li>
      <button
        type="button"
        className="os-ws__row"
        data-file-id={file.id}
        aria-current={current ? "true" : undefined}
        onClick={() => onSelect(file.id)}
      >
        <Icon size={17} aria-hidden="true" className="os-ws__row-icon" />
        <span className="os-ws__row-text">
          <span className="os-ws__nm os-mono" title={displayPath(file)}>
            {nameInGroup(file)}
          </span>
          <span className="os-ws__by">
            <span className={saved.byAgent ? "os-ws__agent" : undefined}>
              <SavedByWords view={saved} />
            </span>{" "}
            · <span title={whenTitle(file.updatedAt) || undefined}>{agoLabel(file.updatedAt)}</span>
          </span>
        </span>
        <span className="os-ws__tag">{TYPE_INFO[type].tag}</span>
      </button>
    </li>
  );
}

function WorkspaceRules({ display }: { display: string }) {
  return (
    <div className="os-ws__rules">
      <h3 className="os-ws__h3">How the workspace works</h3>
      <ul>
        <li>
          <FolderOpen size={17} aria-hidden="true" />
          <span>
            <b>One folder.</b> This page lists and previews files only inside{" "}
            {display ? <code className="os-mono">{display}</code> : "the workspace folder"} and the exports folder. It never browses the rest of your
            disk.
          </span>
        </li>
        <li>
          <FileIcon size={17} aria-hidden="true" />
          <span>
            <b>Three note types.</b> You can write <code className="os-mono">.md</code>, <code className="os-mono">.txt</code> and{" "}
            <code className="os-mono">.html</code> notes here. Other files in the folder can still be previewed.
          </span>
        </li>
        <li>
          <Users size={17} aria-hidden="true" />
          <span>
            <b>Team Room saves wait for your approval.</b> A file from the Team Room arrives as a proposal first.
          </span>
        </li>
        <li>
          <History size={17} aria-hidden="true" />
          <span>
            <b>Team Room saves can be undone.</b> Select the file and use Undo this save. If the file changed after the save, or Agent OS cannot tell
            who saved it, there is no Undo.
          </span>
        </li>
      </ul>
    </div>
  );
}

export default function WorkspacePage() {
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");
  const [onlyAgents, setOnlyAgents] = useState(false);
  const [folder, setFolder] = useState(() => folderFromQuery(queryParam("folder")));
  const [selectedId, setSelectedId] = useState<string | null>(() => queryParam("file") || null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Why there is no list at all (loadState "error"): the words follow the cause, so a server
  // error, a timeout and a dropped connection do not all read the same.
  const [listProblemState, setListProblemState] = useState<ListProblem | null>(null);
  // Set while the list on screen may be out of date because the last reload failed. It is not
  // a notice: a notice says something that stays true until it is dismissed, but this stops being
  // true the moment a reload works, so refresh() clears it. `cause` is the sentence for the failure;
  // `savedAs` is the note that was saved while the list could not reload ("Press Refresh to see it").
  const [listStale, setListStale] = useState<{ savedAs: string | null; cause: string } | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  // null until /api/product/status has answered. Until then the page claims nothing that is true
  // in only one mode (no "private folder", no demo banner). Every reload asks again while it is null.
  const [demoPublic, setDemoPublic] = useState<boolean | null>(null);
  // True right after the person opened a file (or saved a note, which opens it): the pane's
  // heading takes keyboard focus once, then this goes back to false.
  const [focusPane, setFocusPane] = useState(false);

  // refresh() is created once, so it reads the latest values through refs.
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const paneRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const noteHeadingRef = useRef<HTMLHeadingElement>(null);
  // False once the person has left the page. Every reply that arrives later is ignored.
  const mountedRef = useRef(false);
  const demoRef = useRef<boolean | null>(null);
  const statusBusy = useRef(false);
  // The row after the open file (else the one before), kept up to date while the file is in
  // the list, so focus has somewhere to go if an Undo removes the file.
  const neighbourRef = useRef<string | null>(null);
  const goneRef = useRef(false);

  // The address keeps ?folder= and ?file= (Loop, Swarm, Studio and Memory link here with them).
  function syncUrl(fileId: string | null, folderName: string) {
    navigateTo("workspace", { ...(fileId ? { file: fileId } : {}), ...(folderName ? { folder: folderName } : {}) });
  }

  // Each reload gets a number. If an older one answers after a newer one (it
  // can, now that a slow request is given up on), its list is ignored, so a
  // stale list never replaces a fresh one.
  const loadSeq = useRef(0);

  // Asks whether this is the public demo. Nothing is assumed while it has not answered: a failed
  // or slow request leaves the flag unknown, and the next reload asks again.
  const loadStatus = useCallback(async () => {
    if (demoRef.current !== null || statusBusy.current) return;
    statusBusy.current = true;
    try {
      const product = await withTimeout(getProductStatus(), STATUS_TIMEOUT_MS);
      if (!mountedRef.current) return;
      demoRef.current = Boolean(product.demoPublic);
      setDemoPublic(demoRef.current);
    } catch {
      // Still unknown. refresh() tries again.
    } finally {
      statusBusy.current = false;
    }
  }, []);

  const refresh = useCallback(
    async (announceMissing = true): Promise<WorkspaceListing | null> => {
      const mine = ++loadSeq.current;
      setRefreshing(true);
      void loadStatus();
      try {
        const data = await withTimeout(getWorkspaceListing(), LIST_TIMEOUT_MS);
        // Superseded by a newer reload, or the person has left the page (leaving bumps loadSeq): do nothing.
        if (mine !== loadSeq.current || !mountedRef.current) return isListing(data) ? data : null;
        // A 200 without a files array is not an empty workspace; it is an answer the page cannot use.
        if (!isListing(data)) throw new UnreadableListing();
        setListing(data);
        setLoadState("ready");
        setListProblemState(null);
        setListStale(null);
        const wanted = selectedRef.current;
        if (wanted && !data.files.some((file) => file.id === wanted)) {
          // The open file left the list. If it was on screen, keyboard focus must not fall to the page.
          if (listingRef.current?.files.some((file) => file.id === wanted)) goneRef.current = true;
          setSelectedId(null);
          navigateTo("workspace", folderRef.current ? { folder: folderRef.current } : {});
          if (announceMissing) setNotice({ tone: "warn", text: "That file is not in the workspace any more." });
        }
        return data;
      } catch (error) {
        if (mine !== loadSeq.current || !mountedRef.current) return null;
        const problem = listProblem(error);
        // The last list that did load stays on screen, under a note that it may be out of date.
        if (listingRef.current) setListStale((was) => was ?? { savedAs: null, cause: problem.stale });
        else {
          setListProblemState(problem);
          setLoadState("error");
        }
        return null;
      } finally {
        if (mine === loadSeq.current) setRefreshing(false);
      }
    },
    [loadStatus]
  );

  // Leaving the page makes every reply still on its way out of date: refresh() sees the new
  // number, and the other late answers check mountedRef.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSeq.current += 1;
    };
  }, []);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // Other parts of the app change the address and fire the app's navigation
  // event (a menu click on Workspace clears the folder and the file).
  useEffect(() => {
    function sync() {
      setFolder(folderFromQuery(queryParam("folder")));
      setSelectedId(queryParam("file") || null);
    }
    window.addEventListener("aos-navigate", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("aos-navigate", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // Good news goes away by itself after 8 seconds, like the toast. A problem stays until it is dismissed.
  useEffect(() => {
    if (notice?.tone !== "ok") return undefined;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const files = useMemo(() => listing?.files ?? [], [listing]);
  const counts = useMemo(() => countByType(files), [files]);
  const visible = useMemo(() => filterFiles(files, { type, query, onlyAgents, folder }), [files, type, query, onlyAgents, folder]);
  const groups = useMemo(() => groupFiles(visible), [visible]);
  const selected = useMemo(() => files.find((file) => file.id === selectedId) ?? null, [files, selectedId]);
  const folderIsEmpty = useMemo(() => folder !== "" && !files.some((file) => inFolder(file, folder)), [files, folder]);
  const filtersActive = type !== "all" || query.trim() !== "" || onlyAgents || folder !== "";
  const chipKeys: TypeFilter[] = ["all", ...ALWAYS_CHIPS, ...OPTIONAL_CHIPS.filter((key) => counts[key] > 0 || type === key)];
  const sandbox = sandboxPaths(listing?.roots ?? []);
  const canRevealFolder = canRevealInFinder() && Boolean(sandbox.absolute);
  const mode = paneMode({ fileFound: Boolean(selected && listing), wantsFile: selectedId !== null, loadState });

  // Where focus goes if the open file leaves the list: the row after it, else the one before.
  const rowIds = groups.flatMap((group) => group.files.map((file) => file.id));
  const openAt = selectedId ? rowIds.indexOf(selectedId) : -1;
  if (openAt !== -1) neighbourRef.current = rowIds[openAt + 1] ?? rowIds[openAt - 1] ?? null;

  // An answer that arrives after the person has left the page says nothing.
  const notify = useCallback((next: Notice | null) => {
    if (mountedRef.current) setNotice(next);
  }, []);

  // The file that was open is gone from the list (an Undo removed it). Unless the person has
  // moved on to something else, focus goes to the neighbouring row, or to the New note heading.
  useEffect(() => {
    if (!goneRef.current || selectedId !== null) return;
    goneRef.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && !paneRef.current?.contains(active)) return;
    const wanted = neighbourRef.current;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".os-ws__row") ?? []);
    (rows.find((row) => row.dataset.fileId === wanted) ?? noteHeadingRef.current)?.focus();
  }, [selectedId, listing]);

  // Opening a file brings its pane into view, below the top bar. This runs AFTER the pane has drawn its new state: the New
  // note form it replaces is far taller than a file's pane, and scrolling before the swap lined the tall form up and then left
  // the short pane 27px under the bar.
  const [paneScrollTick, setPaneScrollTick] = useState(0);
  useEffect(() => {
    if (paneScrollTick === 0) return;
    paneRef.current?.scrollIntoView({ block: "nearest" });
  }, [paneScrollTick]);

  function selectFile(id: string) {
    setSelectedId(id);
    setNotice(null);
    setFocusPane(true);
    syncUrl(id, folder);
    setPaneScrollTick((n) => n + 1);
  }

  function newNote() {
    setSelectedId(null);
    setNotice(null);
    setFocusPane(false);
    syncUrl(null, folder);
    setFocusToken((n) => n + 1);
  }

  function clearFolder() {
    setFolder("");
    syncUrl(selectedId, "");
  }

  function clearFilters() {
    setType("all");
    setQuery("");
    setOnlyAgents(false);
    if (folder) clearFolder();
  }

  async function onSaved(file: WorkspaceFile, fileName: string) {
    // The save finished after the person left the page: the note is saved, and that is all.
    if (!mountedRef.current) return;
    setNotice({ tone: "ok", text: `Saved notes/${fileName}.` });
    setSelectedId(file.id);
    setFocusPane(true);
    // refresh() reads the wanted file through this ref, which is otherwise only
    // updated by the next render. Set it now so the new file is not seen as "missing".
    selectedRef.current = file.id;
    syncUrl(file.id, folder);
    const pending = refresh(false);
    const mine = loadSeq.current; // refresh() numbers itself before its first await
    const next = await pending;
    if (!mountedRef.current) return;
    // The note is saved either way. If the list could not reload, say both
    // things in the one out-of-date warning (a failed reload would otherwise say only
    // "could not refresh"). A newer reload that has taken over decides for itself.
    if (!next && mine === loadSeq.current) {
      setNotice((now) => (now?.text === `Saved notes/${fileName}.` ? null : now));
      setListStale((was) => ({ savedAs: fileName, cause: was?.cause ?? "" }));
    }
  }

  async function revealFolder() {
    if (!sandbox.absolute) return;
    try {
      await revealInFinder(sandbox.absolute);
    } catch {
      setNotice({ tone: "warn", text: `Finder could not be opened. The folder is at ${sandbox.absolute}` });
    }
  }

  // Up and Down move between rows, Home and End jump to the first and last.
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".os-ws__row"));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  }

  // The line under the list: how many the filters hide, and the server's 500 file limit.
  const countText = [
    filtersActive && visible.length !== files.length ? `Showing ${visible.length} of ${files.length} ${filesWord(files.length)}.` : "",
    files.length >= LIST_LIMIT ? `The list stops at ${LIST_LIMIT} files, so some files may not be shown.` : ""
  ]
    .filter(Boolean)
    .join(" ");
  // A count the server did not send is "—", never the word "undefined". Loading is "…".
  const countWord = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "—");
  const total = listing ? countWord(listing.summary?.total) : loadState === "error" ? "—" : "…";
  const byAgents = listing ? countWord(listing.summary?.savedByAgents) : loadState === "error" ? "—" : "…";

  function listBody() {
    if (loadState === "loading") {
      return (
        <div role="status">
          <span className="os-visually-hidden">Loading files…</span>
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="os-skeleton os-ws__skeleton" />
            ))}
          </div>
        </div>
      );
    }
    if (loadState === "error") {
      return (
        <EmptyState
          icon={ServerOff}
          title={listProblemState?.title ?? "Agent OS can't be reached"}
          body={listProblemState?.body ?? "The file list could not load. Check that Agent OS is still running, then try again."}
          action={
            <button type="button" className="os-btn os-btn--secondary" onClick={() => void refresh(true)} disabled={refreshing}>
              <RefreshCw size={15} aria-hidden="true" />
              Try again
            </button>
          }
        />
      );
    }
    if (folderIsEmpty) {
      return (
        <EmptyState
          icon={FolderOpen}
          title={folder === "loop" ? "No Loop briefings yet" : `Nothing in ${folder}/ yet`}
          body={folder === "loop" ? "Open Loop and save today's briefing. It will appear in this folder." : "Files saved to this folder will appear here."}
          action={
            <>
              {folder === "loop" ? (
                <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("loop")}>
                  Open Loop
                </button>
              ) : null}
              <button type="button" className="os-btn os-btn--ghost" onClick={clearFolder}>
                Show all files
              </button>
            </>
          }
        />
      );
    }
    if (files.length === 0) {
      return (
        <EmptyState
          icon={FolderOpen}
          title="No files yet"
          body={NO_FILES_BODY}
          action={
            <button type="button" className="os-btn os-btn--secondary" onClick={() => navigateTo("team")}>
              <Users size={15} aria-hidden="true" />
              Open Team Room
            </button>
          }
        />
      );
    }
    if (visible.length === 0) {
      return (
        <EmptyState
          icon={FolderOpen}
          title="No files match these filters"
          action={
            <button type="button" className="os-btn os-btn--secondary" onClick={clearFilters}>
              Clear filters
            </button>
          }
        />
      );
    }
    return groups.map((group) => (
      <div key={group.key || "top"} className="os-ws__group">
        <h3 className="os-ws__group-head">
          <code className="os-mono" title={group.label}>
            {group.label}
          </code>
          <span>
            {group.files.length} {filesWord(group.files.length)}
          </span>
        </h3>
        <ul className="os-ws__rows">
          {group.files.map((file) => (
            <FileRow key={file.id} file={file} current={file.id === selectedId} onSelect={selectFile} />
          ))}
        </ul>
      </div>
    ));
  }

  return (
    <section className="os-ws" aria-labelledby="os-workspace-title">
      <PageHeader
        title="Workspace"
        titleId="os-workspace-title"
        lede={workspaceLede(demoPublic)}
        actions={
          selectedId ? (
            <button type="button" className="os-btn os-btn--primary" onClick={newNote}>
              <Plus size={16} aria-hidden="true" />
              New note
            </button>
          ) : null
        }
      />
      {demoPublic === true ? (
        <div className="os-ws__gap">
          <Banner tone="info" title={DEMO_BADGE}>
            This workspace is shared with every visitor. Read demo/briefing.md, then save your own note. Do not paste secrets. Writes cannot leave the
            workspace, and they do not run shell.
          </Banner>
        </div>
      ) : null}
      <div className="os-ws__bar">
        <span className="os-ws__path">
          <FolderOpen size={16} aria-hidden="true" />
          <code className="os-mono">{sandbox.display || (loadState === "loading" ? "…" : "—")}</code>
        </span>
        <span>
          <span className="os-mono">{total}</span> {listing ? filesWord(listing.summary?.total ?? 0) : "files"}
        </span>
        <span>
          <span className="os-mono">{byAgents}</span> {byAgents === "1" ? "Team Room save" : "Team Room saves"}
        </span>
        <span className="os-ws__bar-right">
          <button type="button" className="os-btn os-btn--ghost" onClick={() => void refresh(true)} disabled={refreshing}>
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </button>
          {!selectedId && canRevealFolder ? (
            <button type="button" className="os-btn os-btn--ghost" onClick={() => void revealFolder()}>
              <FolderOpen size={15} aria-hidden="true" />
              Show in Finder
            </button>
          ) : null}
        </span>
      </div>
      <div className="os-ws__main">
        <section aria-labelledby="os-ws-files-title">
          <h2 id="os-ws-files-title" className="os-visually-hidden">
            Files
          </h2>
          <div className="os-ws__filters">
            <div className="os-ws__chips" role="group" aria-label="File type">
              {chipKeys.map((key) => (
                <button key={key} type="button" className="os-chip" aria-pressed={type === key} onClick={() => setType(key)}>
                  {type === key ? <Check size={14} aria-hidden="true" /> : null}
                  {key === "all" ? "All" : TYPE_INFO[key].chip}
                  <span className="os-ws__n os-mono">{listing ? counts[key] : loadState === "error" ? "—" : "…"}</span>
                </button>
              ))}
            </div>
            <div className="os-ws__find">
              <div className="os-field os-ws__search">
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by name"
                  aria-label="Filter by name"
                  autoComplete="off"
                />
              </div>
              <button
                type="button"
                className="os-chip"
                aria-pressed={onlyAgents}
                title="Files a Team Room saved. Files an agent run wrote show — under Saved by."
                onClick={() => setOnlyAgents((on) => !on)}
              >
                {onlyAgents ? <Check size={14} aria-hidden="true" /> : null}
                Team Room saves
              </button>
              {folder ? (
                <button
                  type="button"
                  className="os-chip os-ws__chip-folder"
                  aria-label={`Folder ${folder}/. Remove this filter.`}
                  title={`Folder ${folder}/`}
                  onClick={clearFolder}
                >
                  <span className="os-ws__chip-text">Folder {folder}/</span>
                  <X size={14} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="os-ws__list" ref={listRef} onKeyDown={onListKeyDown}>
            {listBody()}
          </div>
          {loadState === "ready" && countText ? (
            <p className="os-ws__count" role="status">
              {countText}
            </p>
          ) : null}
        </section>
        <section className="os-ws__pane" ref={paneRef} aria-label={PANE_LABEL[mode]}>
          {listStale ? (
            <div className="os-ws__gap">
              <Banner
                tone="warn"
                actions={
                  <button type="button" className="os-btn os-btn--ghost" onClick={() => setListStale(null)}>
                    Dismiss
                  </button>
                }
              >
                {listStale.savedAs ? `Saved notes/${listStale.savedAs}, but the list could not reload. Press Refresh to see it.` : listStale.cause}
              </Banner>
            </div>
          ) : null}
          {notice ? (
            notice.tone === "ok" ? (
              <p className="os-ws__ok" role="status">
                <Check size={15} aria-hidden="true" />
                {notice.text}
              </p>
            ) : (
              <div className="os-ws__gap">
                <Banner
                  tone={notice.tone}
                  actions={
                    <button type="button" className="os-btn os-btn--ghost" onClick={() => setNotice(null)}>
                      Dismiss
                    </button>
                  }
                >
                  {notice.text}
                </Banner>
              </div>
            )
          ) : null}
          {mode === "preview" && selected && listing ? (
            <WorkspacePreview
              key={selected.id}
              file={selected}
              roots={listing.roots}
              onRefresh={refresh}
              onNotice={notify}
              autoFocus={focusPane}
              onFocused={() => setFocusPane(false)}
            />
          ) : null}
          {mode === "opening" ? (
            <p className="os-ws__plain" role="status">
              Opening the file…
            </p>
          ) : null}
          {mode === "blocked" ? (
            <EmptyState
              icon={ServerOff}
              title="This file can't be opened yet"
              body={listProblemState?.file ?? "Agent OS can't be reached. Try again once it is running."}
              action={
                <button type="button" className="os-btn os-btn--secondary" onClick={() => void refresh(true)} disabled={refreshing}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Try again
                </button>
              }
            />
          ) : null}
          {/* Always mounted, and hidden while a file is open, so a draft survives a look at another file. */}
          <WorkspaceNoteForm
            files={listing ? listing.files : null}
            loadState={loadState}
            demoPublic={demoPublic}
            hidden={mode !== "form"}
            focusToken={focusToken}
            headingRef={noteHeadingRef}
            onSaved={onSaved}
            onUnsure={() => void refresh(false)}
          />
          {mode === "form" ? <WorkspaceRules display={sandbox.display} /> : null}
        </section>
      </div>
    </section>
  );
}
