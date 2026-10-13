import Banner from "../ui/components/Banner";
import GetStartedCard from "../ui/components/GetStartedCard";
import HomeAgentTable from "../ui/components/HomeAgentTable";
import Orbit from "../ui/components/Orbit";
import PageHeader from "../ui/components/PageHeader";
import RecentActivity from "../ui/components/RecentActivity";
import WaitingStrip from "../ui/components/WaitingStrip";
import { homeLede, isUnreachable, orbitLabel, orbitNote, orbitStates } from "../ui/homeShared";
import { useHomeData } from "../ui/useHomeData";
import "../ui/fleet.css";

export default function FleetPage() {
  const data = useHomeData();
  // Until the runs list has loaded once, Home does not know what is running, so it
  // says nothing about it (no "Nothing running", no "No agent is working").
  const runsKnown = data.runs.state === "ok";
  const states = data.runs.state === "ok" ? orbitStates(data.runs.data) : {};
  const offline = isUnreachable(data.agents) || isUnreachable(data.runs);
  return (
    <section className="os-home" aria-labelledby="os-home-title">
      <WaitingStrip />
      {offline ? (
        <Banner tone="warn" title="Can't reach Agent OS">
          This page tries again every few seconds. Nothing on it is live until then.
        </Banner>
      ) : null}
      {/* The primary "New session" button arrives with Sessions in SP3. */}
      <PageHeader titleId="os-home-title" title="Home" lede={homeLede({ agents: data.agents, states, runsKnown })} />
      <GetStartedCard />
      <div className="os-home__stage">
        <Orbit states={states} label={orbitLabel(states, runsKnown)} note={orbitNote(states)} />
        <HomeAgentTable data={data} />
      </div>
      <RecentActivity data={data} />
    </section>
  );
}
