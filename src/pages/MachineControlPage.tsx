import { Loader2, RefreshCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { getDemoStatus, getProductStatus, getVoiceControlStatus, previewDemoMachine } from "../api";
import { DEMO_BADGE, type DemoMachineScenario } from "../demo";
import type { VoiceControlStatus } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

function row(label: string, ready: boolean, detail: string, goodWhenOff = false) {
  const on = goodWhenOff ? !ready : ready;
  return { label, ready: on, raw: ready, detail, goodWhenOff };
}

export default function MachineControlPage() {
  const [status, setStatus] = useState<VoiceControlStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [demoPublic, setDemoPublic] = useState(false);
  const [scenarios, setScenarios] = useState<DemoMachineScenario[]>([]);
  const [scenario, setScenario] = useState("health-check");
  const [transcript, setTranscript] = useState("");
  const [previewNote, setPreviewNote] = useState("");

  async function refresh() {
    setBusy(true);
    try {
      setStatus(await getVoiceControlStatus());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load machine-control status.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    void getProductStatus()
      .then((product) => setDemoPublic(Boolean(product.demoPublic)))
      .catch(() => setDemoPublic(false));
    void getDemoStatus()
      .then((demo) => {
        if (demo.enabled && demo.scenarios?.length) {
          setScenarios(demo.scenarios);
          setScenario(demo.scenarios[0].id);
        }
      })
      .catch(() => setScenarios([]));
  }, []);

  async function preview() {
    setBusy(true);
    setTranscript("");
    setPreviewNote("");
    try {
      const result = await previewDemoMachine(scenario);
      setTranscript(result.transcript || "");
      setPreviewNote(result.note || "Nothing was executed on the host.");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not preview the canned scenario.");
    } finally {
      setBusy(false);
    }
  }

  const tools = status?.tools;
  const checks = tools ? [
    row("Live execution gate", tools.executionGate, tools.executionGate ? `On via ${tools.executionGateSource}` : "Off. Dashboard actions stay dry-run.", true),
    row("Voice shell gate", tools.shellGate, tools.shellGate ? "Shell commands could be allowed" : "Off. Shell stays blocked.", true),
    row("cliclick", tools.cliclick, tools.cliclick ? "Click helper is installed" : "Missing. Not installed by this page."),
    row("Accessibility probe", tools.accessibility, tools.accessibility ? "Runtime reported Accessibility access" : "Not granted to this runtime. Terminal permission is not the same as Cursor/Hermes/Node."),
    row("osascript", tools.osascript, tools.osascript ? "AppleScript tool is present" : "Missing"),
    row("open", tools.open, tools.open ? "macOS open tool is present" : "Missing"),
    row("screencapture tool", tools.screencapture, "Tool presence is not Screen Recording permission. Permission is per-app."),
    row("mdfind", tools.mdfind, tools.mdfind ? "Spotlight search tool is present" : "Missing"),
    row("Codex CLI", tools.codex, tools.codex ? "codex command is on PATH" : "Standalone Codex CLI not found"),
    row("Codex GPT planner key", tools.codexGptPlanner, "Shows whether a planner key is configured. The key itself is not displayed.")
  ] : [];

  return (
    <PageFrame
      kicker={demoPublic ? "MACHINE CONTROL · GATED DEMO" : "MACHINE CONTROL · STATUS ONLY"}
      title={demoPublic ? "Preview what a gated command would look like. Nothing runs." : "See what this machine would need. Do not run commands from here."}
      hint={demoPublic
        ? `${DEMO_BADGE}. The preview is a canned transcript. There is no command box, and Run stays disabled.`
        : "This page reads /api/voice/status. There is no Run command button. OS permissions are per-app: allowing a terminal does not allow Cursor, Hermes, or Node."}
      actions={
        <button className="aos-secondary" onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 className="aos-spin" size={16} /> : <RefreshCcw size={16} />} Refresh
        </button>
      }
    >
      <HonestNote>
        To enable computer control later you would need to approve installs, Accessibility, Screen Recording, Microphone, and possibly Automation — each explained first. This phase keeps all of that off.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      {demoPublic ? (
        <div className="aos-panel aos-demo-machine">
          <div className="aos-panel-head">
            <div>
              <span>{DEMO_BADGE}</span>
              <h2>Canned preview</h2>
            </div>
          </div>
          <p>Pick a scenario. Agent OS returns a fixed transcript and does not pass text to a shell.</p>
          <div className="aos-phase-toolbar">
            <label className="aos-field">
              <span>Scenario</span>
              <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
                {(scenarios.length ? scenarios : [{ id: "health-check", label: "Preview health check", description: "" }]).map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <button className="aos-secondary" onClick={() => void preview()} disabled={busy}>
              {busy ? <Loader2 className="aos-spin" size={16} /> : null} Preview simulated run
            </button>
          </div>
          {transcript ? <pre className="aos-demo-transcript">{transcript}</pre> : null}
          {previewNote ? <p className="aos-honest-note">{previewNote}</p> : null}
        </div>
      ) : null}
      <div className="aos-panel aos-disabled-action">
        <ShieldCheck size={18} />
        <div>
          <strong>Run command</strong>
          <p>{demoPublic
            ? "Disabled on the public demo. Host shell stays locked even if a visitor asks for a command."
            : "Disabled. Voice/computer actions stay dry-run until you explicitly approve execution later."}</p>
        </div>
        <button className="aos-primary" disabled>Run command</button>
      </div>
      <div className="aos-permission-list">
        {checks.length === 0 ? (
          <div className="aos-empty"><p>Status has not loaded yet.</p></div>
        ) : (
          checks.map((check) => (
            <article key={check.label}>
              <span className={check.ready ? "ok" : "missing"}>{check.ready ? (check.goodWhenOff ? "Safe / off" : "Ready") : (check.goodWhenOff ? "On" : "Missing")}</span>
              <div>
                <strong>{check.label}</strong>
                <p>{check.detail}</p>
              </div>
            </article>
          ))
        )}
      </div>
      <div className="aos-panel">
        <div className="aos-panel-head"><div><span>HOW TO ENABLE LATER</span><h2>You click Allow. This app does not.</h2></div></div>
        <ol className="aos-howto">
          <li>Ask to enable a specific tool, such as cliclick, and hear the risk first.</li>
          <li>Grant the matching OS permission in system settings to the exact app that needs it.</li>
          <li>Keep a way to turn it off: set execution and voice-shell flags back to 0.</li>
        </ol>
      </div>
    </PageFrame>
  );
}
