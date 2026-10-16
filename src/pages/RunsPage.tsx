// Runs: the Board of every run in three bays (Active, Held, Landed), the Session recordings tab (every recorded
// session, Task U4), and one run's console when ?run=<id> is set. ?tab=recordings opens the recordings tab, and
// ?highlight=<session id> marks one of its rows ("Open recording" on an ended Sessions tab lands there).
import { useEffect, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { listRuns } from "../api";
import { navigateTo, queryParam } from "../nav";
import type { RunMeta } from "../types";
import Banner from "../ui/components/Banner";
import PageHeader from "../ui/components/PageHeader";
import RunBoard from "../ui/components/RunBoard";
import RunConsole from "../ui/components/RunConsole";
import SessionRecordings, { useRecordings } from "../ui/components/SessionRecordings";
import Tabs, { tabPanelProps } from "../ui/components/Tabs";
import { useInterval } from "../ui/components/useInterval";
import { openNewRun, takeFocusNextRun } from "../ui/newRun";
import { SAFE_EXAMPLE_PROMPT } from "../ui/onboardingShared";
import { splitBays } from "../ui/runsBoard";
import "../ui/runs.css";

const WATCHDOG_MS = 15000;
type TabId = "board" | "recordings";
const tabFromUrl = (): TabId => (queryParam("tab") === "recordings" ? "recordings" : "board");

export default function RunsPage() {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [failed, setFailed] = useState(false); // the last load failed
  const [timedOut, setTimedOut] = useState(false); // nothing has loaded for 15 seconds
  const [selectedId, setSelectedId] = useState(() => queryParam("run"));
  const [tab, setTab] = useState<TabId>(tabFromUrl);
  const [highlight, setHighlight] = useState(() => queryParam("highlight"));
  // True when the run was opened by something the person did (Start run in the dialog, a row on the Board), so the
  // console takes keyboard focus: the control they used is gone. A page loaded straight on ?run= does not grab focus.
  const [focusConsole, setFocusConsole] = useState(() => takeFocusNextRun());
  // The recordings are read only while their tab is on screen.
  const recordings = useRecordings(tab === "recordings" && !selectedId);

  async function loadRuns() {
    try {
      const { runs: list } = await listRuns({ limit: 100 });
      setRuns(list);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void loadRuns();
  }, []);
  useInterval(() => void loadRuns(), 5000);

  // Never wait forever on a server that does not answer.
  useEffect(() => {
    if (runs !== null) {
      setTimedOut(false);
      return undefined;
    }
    const id = setTimeout(() => setTimedOut(true), WATCHDOG_MS);
    return () => clearTimeout(id);
  }, [runs]);

  useEffect(() => {
    function sync() {
      setSelectedId(queryParam("run"));
      setTab(tabFromUrl());
      setHighlight(queryParam("highlight"));
      if (queryParam("run") && takeFocusNextRun()) setFocusConsole(true);
      // The Get started checklist sends ?example=safe: open the dialog with the example typed in, then tidy
      // the address. The timer lets the Shell (the parent, whose listener is added after this page's effects
      // on a first load) be listening before the request is sent.
      if (queryParam("example") === "safe") {
        const agentId = queryParam("agent") || undefined;
        window.setTimeout(() => openNewRun({ agentId, prompt: SAFE_EXAMPLE_PROMPT }), 0);
        navigateTo("runs");
      }
    }
    sync();
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  function open(id: string) {
    setFocusConsole(true);
    setSelectedId(id);
    navigateTo("runs", { run: id });
  }
  function back() {
    setFocusConsole(false);
    setSelectedId("");
    navigateTo("runs");
  }
  // The tab is in the address too, so a link (Open recording) and a reload land on the same tab.
  function changeTab(id: string) {
    const next: TabId = id === "recordings" ? "recordings" : "board";
    setTab(next);
    navigateTo("runs", next === "recordings" ? { tab: "recordings" } : {});
  }

  const bays = runs ? splitBays(runs) : null;
  const offline = runs === null && (failed || timedOut);
  // "New run" lives in the Active bay while that bay shows its empty state, and in the header otherwise.
  const activeEmpty = tab === "board" && !selectedId && bays !== null && bays.active.length === 0;
  const count = (n: number | undefined) => (n === undefined ? (offline ? "—" : "…") : n);
  const recCount = recordings.value.state === "ok" ? recordings.value.data.rows.length : recordings.value.state === "error" ? "—" : "…";
  // Where sessions do not run (404 not_available), the tab says so and claims nothing about this computer.
  const recUnavailable = recordings.value.state === "unavailable";

  const lede = selectedId
    ? undefined
    : tab === "board"
      ? "A run is one task an agent does on its own. It starts Active, may be Held by a limit, and ends Landed."
      : recUnavailable
        ? undefined
        : "Every session is recorded here as it happens, on this computer, so you can pick the conversation up again.";

  return (
    <section className={`os-runs${selectedId ? " os-runs--detail" : ""}`} aria-labelledby="os-runs-title">
      <PageHeader
        title="Runs"
        titleId="os-runs-title"
        lede={lede}
        actions={
          selectedId || activeEmpty ? undefined : (
            <button type="button" className="os-btn os-btn--primary" onClick={() => openNewRun()}>
              <Plus size={17} aria-hidden="true" />
              New run
            </button>
          )
        }
      />

      {selectedId ? (
        <div className="os-runs__detail">
          <button type="button" className="os-btn os-btn--ghost os-runs__back" onClick={back}>
            <ArrowLeft size={15} aria-hidden="true" />
            All runs
          </button>
          <RunConsole runId={selectedId} focusTitle={focusConsole} onEnded={() => void loadRuns()} />
        </div>
      ) : (
        <>
          <div className="os-runs__tabbar">
            <Tabs
              label="Runs views"
              idPrefix="runs"
              tabs={[
                { id: "board", label: "Board" },
                { id: "recordings", label: "Session recordings" }
              ]}
              value={tab}
              onChange={changeTab}
            />
            <p className="os-runs__tally">
              {tab === "board" ? (
                <>
                  <span className="os-mono">{count(bays?.active.length)}</span> in the air
                  <span className="os-runs__sep" aria-hidden="true" />
                  <span className="os-mono">{count(bays?.held.length)}</span> held
                  <span className="os-runs__sep" aria-hidden="true" />
                  <span className="os-mono">{count(bays?.landed.length)}</span> landed
                </>
              ) : recUnavailable ? null : (
                <>
                  <span className="os-mono">{recCount}</span> kept on this computer
                </>
              )}
            </p>
          </div>

          {tab === "board" ? (
            <div {...tabPanelProps("runs", "board")}>
              {offline ? (
                <Banner
                  tone="danger"
                  title="Agent OS isn't responding"
                  actions={
                    <button type="button" className="os-btn os-btn--secondary" onClick={() => void loadRuns()}>
                      Try again
                    </button>
                  }
                >
                  {failed ? "The runs can't be listed right now." : "It is taking too long to answer, so the runs can't be listed yet."} Agent OS keeps trying, and
                  this page fills in by itself when it is back.
                </Banner>
              ) : (
                <>
                  {runs && failed ? (
                    <Banner tone="warn" title="Can't reach Agent OS">
                      This is the last list it got. It keeps trying, and this page updates by itself when Agent OS is back.
                    </Banner>
                  ) : null}
                  <RunBoard runs={runs} onOpen={open} onNew={() => openNewRun()} />
                </>
              )}
            </div>
          ) : (
            <div {...tabPanelProps("runs", "recordings")}>
              <SessionRecordings value={recordings.value} highlight={highlight} onReload={recordings.reload} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
