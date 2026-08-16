import { Clapperboard, FolderOpen, Image as ImageIcon, Loader2, Mic, Music, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  cancelVideoRun,
  createSelfModuleItem,
  getExecutionGateStatus,
  getSelfModule,
  getVideoRun,
  getVideoWorkerStatus,
  queueVideoJob,
  runVideoJob,
  videoRunDownloadUrl,
  writeWorkspaceFile
} from "../api";
import { navigateTo } from "../nav";
import type { ExecutionGateStatus, SelfModuleItem, SelfModuleState, VideoJobResult, VideoWorkerStatus } from "../types";
import { HonestNote, PageFrame } from "./PageFrame";

export default function StudioPage() {
  const [state, setState] = useState<SelfModuleState | null>(null);
  const [worker, setWorker] = useState<VideoWorkerStatus | null>(null);
  const [gate, setGate] = useState<ExecutionGateStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<VideoJobResult | null>(null);
  const selected = useMemo(
    () => state?.items.find((item) => item.id === selectedId) || state?.items[0] || null,
    [state, selectedId]
  );
  const dryRun = !gate?.enabled;
  const ffmpegOn = Boolean(worker?.tools?.ffmpeg?.available);
  const whisperOn = Boolean(worker?.tools?.whisper?.available);
  const groqOn = Boolean(worker?.stt?.providers?.some((item) => item.id === "groq" && item.configured));
  const videoReady = Boolean(worker?.tools?.ffprobe?.available || ffmpegOn || whisperOn || groqOn);

  async function refresh() {
    try {
      const [video, status, execution] = await Promise.all([
        getSelfModule("video"),
        getVideoWorkerStatus(),
        getExecutionGateStatus().catch(() => null)
      ]);
      setState(video);
      setWorker(status);
      setGate(execution);
      setSelectedId(selectedId || video.items[0]?.id || null);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load Studio.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createJob() {
    if (!title.trim()) return;
    setBusy("create");
    try {
      const next = await createSelfModuleItem("video", { title: title.trim(), sourcePath });
      setState(next);
      setSelectedId(next.items[0]?.id || null);
      setTitle("");
      setSourcePath("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save video job.");
    } finally {
      setBusy("");
    }
  }

  async function noteInWorkspace(jobResult: VideoJobResult) {
    const run = jobResult.run;
    const names = [run.output?.captions, run.output?.renderedVideo, run.output?.manifest].filter(Boolean) as string[];
    if (!names.length) return;
    await writeWorkspaceFile({
      folder: "video",
      name: `${run.id}.md`,
      content: [
        `# Video run ${run.id}`,
        "",
        `Status: ${run.status}`,
        `Mode: ${run.mode}`,
        `Operation: ${run.operation}`,
        "",
        ...names.map((name) => `- ${name}`),
        "",
        "Remotion / Midjourney / ElevenLabs are not connected.",
        ""
      ].join("\n")
    }).catch(() => undefined);
  }

  async function runSelected(kind: "run" | "queue") {
    if (!selected) return;
    setBusy(kind);
    try {
      const next = kind === "queue"
        ? await queueVideoJob(selected.id, { dryRun })
        : await runVideoJob(selected.id, { dryRun });
      setResult(next);
      setState(next.state);
      setSelectedId(next.job.id);
      await noteInWorkspace(next);
      if (next.queued && next.run.id) {
        const done = await getVideoRun(next.run.id);
        setResult(done);
        setState(done.state);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Video job failed.");
    } finally {
      setBusy("");
    }
  }

  async function cancelSelected() {
    const runId = result?.run.id || selected?.lastRunId;
    if (!runId) return;
    setBusy("cancel");
    try {
      const next = await cancelVideoRun(runId);
      setResult(next);
      setState(next.state);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cancel failed.");
    } finally {
      setBusy("");
    }
  }

  const run = result?.run || selected?.videoHistory?.[0];
  const sandboxNote = Boolean(run?.id);

  return (
    <PageFrame
      kicker="STUDIO · MEDIA SHELL"
      title="Local video worker. No fake Midjourney."
      hint="Image, voice, and music stay Not configured unless a real local tool exists. ffmpeg / Whisper / Groq can light the video tile only."
    >
      <div className="aos-status-grid">
        <article>
          <span>Video worker</span>
          <strong>{videoReady ? "Local tools found" : "Not configured"}</strong>
          <small>{worker?.publicSummary || "Worker status did not load."}</small>
        </article>
        <article>
          <span>ffmpeg / Whisper / Groq</span>
          <strong>{[ffmpegOn && "ffmpeg", whisperOn && "whisper", groqOn && "groq"].filter(Boolean).join(" · ") || "Missing"}</strong>
          <small>These can light video only. Remotion is not connected.</small>
        </article>
        <article>
          <span>Run mode</span>
          <strong>{dryRun ? "Dry-run" : "Live"}</strong>
          <small>{gate?.publicSummary || "Execution stays gated until you enable it."}</small>
        </article>
      </div>
      <HonestNote>
        Midjourney, ElevenLabs, and Remotion are not marked connected. Successful files land under ~/.hermes-agent-os/runs/video/. A markdown pointer is written into workspace/video when a run has outputs.
      </HonestNote>
      {error ? <div className="aos-global-error">{error}</div> : null}
      <div className="aos-studio-grid">
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>Not configured</span><h2><ImageIcon size={18} /> Image generation</h2></div></div>
          <p>No Midjourney / local image studio is wired into this dashboard.</p>
        </article>
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>{videoReady ? "Local tools found" : "Not configured"}</span><h2><Clapperboard size={18} /> Video studio</h2></div></div>
          <div className="aos-field">
            <span>Job title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Caption this clip" />
          </div>
          <div className="aos-field">
            <span>Source path</span>
            <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/path/to/clip.mp4" />
          </div>
          <button className="aos-secondary" onClick={() => void createJob()} disabled={busy !== "" || !title.trim()}>
            {busy === "create" ? <Loader2 className="aos-spin" size={16} /> : null} Save job
          </button>
          {(state?.items || []).map((item: SelfModuleItem) => (
            <button key={item.id} className={item.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
              <strong>{item.title}</strong>
              <span>{item.status || "queued"} · {item.sourcePath || "no source"}</span>
            </button>
          ))}
          <div className="aos-phase-toolbar">
            <button className="aos-primary" disabled={!selected || busy !== ""} onClick={() => void runSelected("run")}>
              {busy === "run" ? <Loader2 className="aos-spin" size={16} /> : <Play size={16} />} {dryRun ? "Dry-run" : "Run"}
            </button>
            <button className="aos-secondary" disabled={!selected || busy !== ""} onClick={() => void runSelected("queue")}>
              Queue
            </button>
            <button className="aos-secondary" disabled={!run || busy !== ""} onClick={() => void cancelSelected()}>
              Cancel
            </button>
            {sandboxNote ? (
              <button className="aos-secondary" onClick={() => navigateTo("workspace", { folder: "video" })}>
                <FolderOpen size={16} /> Open in Workspace
              </button>
            ) : null}
          </div>
          <p>{run?.message || worker?.publicSummary || "Create a job, then dry-run. Live ffmpeg needs the execution gate."}</p>
          {run?.output?.captions ? <a href={videoRunDownloadUrl(run.id, run.output.captions)}>{run.output.captions}</a> : null}
        </article>
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>Not configured</span><h2><Mic size={18} /> Voice / audio</h2></div></div>
          <p>ElevenLabs-style voice tools are not installed here.</p>
        </article>
        <article className="aos-panel">
          <div className="aos-panel-head"><div><span>Not configured</span><h2><Music size={18} /> Music / sound</h2></div></div>
          <p>No music generator is marked connected.</p>
        </article>
      </div>
    </PageFrame>
  );
}
