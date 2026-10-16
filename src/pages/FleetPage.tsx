import { Plus } from "lucide-react";
import Banner from "../ui/components/Banner";
import GetStartedCard from "../ui/components/GetStartedCard";
import HomeAgentTable from "../ui/components/HomeAgentTable";
import Orbit from "../ui/components/Orbit";
import PageHeader from "../ui/components/PageHeader";
import RecentActivity from "../ui/components/RecentActivity";
import WaitingStrip from "../ui/components/WaitingStrip";
import { homeLede, isUnreachable, nothingRunningKnown, orbitLabel, orbitNote, orbitStates } from "../ui/homeShared";
import { openNewSession } from "../ui/newSession";
import { useHomeData } from "../ui/useHomeData";
import "../ui/fleet.css";

export default function FleetPage() {
  const data = useHomeData();
  // Until the runs list and the sessions list have both loaded once, Home does not know what is running, so it
  // says nothing about it (no "Nothing running", no "No agent is working").
  const workKnown = data.runs.state === "ok" && data.sessions.state === "ok";
  const states = orbitStates(data.runs.state === "ok" ? data.runs.data : [], data.sessions.state === "ok" ? data.sessions.data : []);
  // "Nothing is running right now." is said only when nothing is open either: an idle or starting session lights no
  // line, but it is open (the menu counts it, the agent's row names it), so the lede must not contradict that.
  const quietKnown = nothingRunningKnown(workKnown, data.sessions.state === "ok" ? data.sessions.data : []);
  const offline = isUnreachable(data.agents) || isUnreachable(data.runs) || isUnreachable(data.sessions);
  return (
    <section className="os-home" aria-labelledby="os-home-title">
      <WaitingStrip />
      {offline ? (
        <Banner tone="warn" title="Can't reach Agent OS">
          This page tries again every few seconds. Nothing on it is live until then.
        </Banner>
      ) : null}
      <PageHeader
        titleId="os-home-title"
        title="Home"
        lede={homeLede({ agents: data.agents, states, runsKnown: quietKnown })}
        actions={
          data.sessionsAvailable ? (
            <button type="button" className="os-btn os-btn--primary" onClick={() => openNewSession()}>
              <Plus size={17} aria-hidden="true" />
              New session
            </button>
          ) : undefined
        }
      />
      <GetStartedCard />
      <div className="os-home__stage">
        <Orbit states={states} label={orbitLabel(states, workKnown)} note={orbitNote(states)} />
        <HomeAgentTable data={data} />
      </div>
      <RecentActivity data={data} />
    </section>
  );
}
