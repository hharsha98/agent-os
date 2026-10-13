// Team Room screen: Hermes Agent and OpenClaw discuss a task in turns while
// you watch. With no ?room=<id> it shows the start form and past rooms; with
// one it shows that room live. The route is page=team. Each of the two views
// draws its own page header (one h1, "Team Room").
import { useEffect, useRef, useState } from "react";
import { navigateTo, queryParam } from "../nav";
import TeamRoomStart from "../ui/components/TeamRoomStart";
import TeamRoomView from "../ui/components/TeamRoomView";
import "../ui/runs.css";
import "../ui/teamRoom.css";

export default function TeamRoomPage() {
  const [roomId, setRoomId] = useState(() => queryParam("room"));
  const pageRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    function sync() {
      setRoomId(queryParam("room"));
    }
    window.addEventListener("aos-navigate", sync);
    return () => window.removeEventListener("aos-navigate", sync);
  }, []);

  // Opening or closing a room swaps the whole view, so the button that was
  // clicked disappears. Put the focus on the page itself so a keyboard or
  // screen reader user starts at the top of the new view.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    pageRef.current?.focus();
  }, [roomId]);

  function openRoom(id: string) {
    setRoomId(id);
    navigateTo("team", { room: id });
  }
  function closeRoom() {
    setRoomId("");
    navigateTo("team");
  }

  return (
    <div className="os-team" ref={pageRef} tabIndex={-1} role="region" aria-labelledby="os-team-title">
      {roomId ? <TeamRoomView roomId={roomId} onBack={closeRoom} /> : <TeamRoomStart onOpenRoom={openRoom} />}
    </div>
  );
}
