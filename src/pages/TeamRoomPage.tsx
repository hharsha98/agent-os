// Team Room screen: Hermes Agent and OpenClaw discuss a task in turns while
// you watch. With no ?room=<id> it shows the explainer, the start form and
// past rooms; with one it shows that room live. The route is page=team.
import { useEffect, useState } from "react";
import { navigateTo, queryParam } from "../nav";
import TeamRoomStart from "../ui/components/TeamRoomStart";
import TeamRoomView from "../ui/components/TeamRoomView";
import "../ui/runs.css";
import "../ui/teamRoom.css";

export default function TeamRoomPage() {
  const [roomId, setRoomId] = useState(() => queryParam("room"));

  useEffect(() => {
    function sync() {
      setRoomId(queryParam("room"));
    }
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  function openRoom(id: string) {
    setRoomId(id);
    navigateTo("team", { room: id });
  }
  function closeRoom() {
    setRoomId("");
    navigateTo("team");
  }

  return (
    <div className="os-team aos-phase-page">
      <header className="os-team__header">
        <span className="os-micro">AGENT OS · TEAM ROOM</span>
        <h1>Team Room</h1>
      </header>
      {roomId ? <TeamRoomView roomId={roomId} onBack={closeRoom} /> : <TeamRoomStart onOpenRoom={openRoom} />}
    </div>
  );
}
