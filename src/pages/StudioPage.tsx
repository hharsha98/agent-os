import { Clapperboard, Image as ImageIcon, Mic, Music } from "lucide-react";
import { HonestNote, PageFrame } from "./PageFrame";

const TILES = [
  {
    id: "image",
    label: "Image generation",
    status: "Not configured",
    icon: ImageIcon,
    detail: "No Midjourney / local image studio is wired into this dashboard."
  },
  {
    id: "video",
    label: "Video studio",
    status: "Parked",
    icon: Clapperboard,
    detail: "The server has a video worker, but it is parked on purpose. Remotion / HyperFrames are not connected."
  },
  {
    id: "voice",
    label: "Voice / audio",
    status: "Not configured",
    icon: Mic,
    detail: "ElevenLabs-style voice and audio overview tools are not installed here."
  },
  {
    id: "music",
    label: "Music / sound",
    status: "Not configured",
    icon: Music,
    detail: "No music generator is marked connected."
  }
];

export default function StudioPage() {
  return (
    <PageFrame
      kicker="STUDIO · MEDIA SHELL"
      title="A place for future media. Nothing is faked as live."
      hint="Use Workspace to preview files that actually exist on disk. This tab does not pretend Midjourney, ElevenLabs, or Remotion are connected."
    >
      <HonestNote>
        The public demo’s Studio generates images, video, and voice. This local copy only shows honest missing/parked states until you approve those integrations.
      </HonestNote>
      <div className="aos-studio-grid">
        {TILES.map((tile) => {
          const Icon = tile.icon;
          return (
            <article key={tile.id} className="aos-panel">
              <div className="aos-panel-head">
                <div>
                  <span>{tile.status}</span>
                  <h2><Icon size={18} /> {tile.label}</h2>
                </div>
              </div>
              <p>{tile.detail}</p>
            </article>
          );
        })}
      </div>
    </PageFrame>
  );
}
