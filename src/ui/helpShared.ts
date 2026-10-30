// The Help page's words ("How a session works": the prototype's how-it-works.html). Every sentence is true today: the
// alerts lane is here since SP4 (alertWords, tested in test/sessions-alerts-ui-logic.test.js); hand-offs arrive with
// Task X8, so they are not (test/recordings-help-logic.test.js checks the rest). What closing the window does depends on where Agent OS
// runs: on a Mac the window hides and the sessions keep running; on Windows and Linux closing the window quits after
// asking (there is no tray, spec "Persistence, quit and Stop"); in a browser tab, closing the tab only leaves the page.
// No imports, so the test loads this file straight from src/.

export const HELP_TITLE = "How a session works";
export const HELP_LEDE = "The agent's own terminal program runs inside Agent OS. You type, it answers, the same as in your own terminal.";
export const ROUTE_TITLE = "From your keyboard to the agent, and back";
export const ROUTE_QUIET = "Everything on this diagram runs on your computer";

// The prototype's Lane A, in words. (Its fourth item, the hand-off, arrives with Task X8; Lane B is alertWords below.)
export const ROUTE_WORDS: Array<Array<{ text: string; bold?: boolean }>> = [
  [{ text: "You type", bold: true }, { text: " in the Agent OS window. The keys travel over a private connection to the engine." }],
  [{ text: "The engine types them into the agent's " }, { text: "real terminal", bold: true }, { text: ". The agent answers by drawing on it." }],
  [
    { text: "The engine keeps an " },
    { text: "invisible copy", bold: true },
    { text: " of that screen, saves a recording on this computer, and streams the screen back to your window." }
  ]
];

// The prototype's Lane B, in words (SP4 Task U5): how an agent's own signal becomes an alert, what shows it where Agent
// OS runs (a desktop notification in the desktop app, Task X4; a message at the bottom of the page in a browser tab,
// spec Alerts UI), that nothing answers for you, and what "basic" means (rulings R17 to R19).
export const ALERTS_TITLE = "Alerts, in words";
export function alertWords({ desktop }: { desktop: boolean }): Array<Array<{ text: string; bold?: boolean }>> {
  return [
    [
      { text: "The agent raises " },
      { text: "its own signal", bold: true },
      { text: " when it needs you: a hook, a notification, a bell or an approval request, depending on the agent." }
    ],
    [
      {
        text: desktop
          ? "Agent OS turns it into an alert: an amber tab marker, the Home strip, the top-bar badge and, when its window is hidden or not in front, a desktop notification."
          : "Agent OS turns it into an alert: an amber tab marker, the Home strip, the top-bar badge and a message at the bottom of this page."
      }
    ],
    [
      { text: "Nothing answers for you.", bold: true },
      { text: " You open the session and press the key yourself, or choose Allow once or Deny on an OpenClaw card." }
    ],
    [
      { text: "Alerts for Hermes and Cursor are " },
      { text: "basic", bold: true },
      { text: ": Agent OS hears only a bell or a sign in the title, which may also mean the agent finished." }
    ]
  ];
}

// The prototype's two promises, Stop made true for SP3, plus the third one the spec makes in SP3 ("No auto-answers
// anywhere"). The Stop promise is the decided sentence (ruling R24): it names the three ways to stop (R22: the
// palette's "Stop all agent work") and only the agent's program and the commands it started in its terminal, with
// the two honest limits: a Claude Code task moved with /bg that `claude agents --json` does not report outlives the
// Stop (S7), and OpenClaw may still finish its last step. D11: the two background services keep running.
export const PROMISES: Array<{ id: "stop" | "flags" | "answers"; title: string; body: string }> = [
  {
    id: "stop",
    title: "Stop ends the agent and what runs under it",
    body:
      "Stop on a session, Hold to stop all, or Stop all agent work ends the agent's program and the commands it started in its terminal. A Claude Code background task moved with /bg may keep running if Agent OS can't find it, and OpenClaw may still finish its last step after the terminal closes. The Hermes background service and the OpenClaw Gateway keep running: each has its own Stop on Agents."
  },
  {
    id: "flags",
    title: "No skip-permissions flags, ever",
    body: "Some agents have a launch option that switches off their safety questions. Agent OS never starts an agent with it, and no setting can turn it on."
  },
  {
    id: "answers",
    title: "Nothing answers for you",
    body: "Agent OS never answers an agent's question for you. You read it and press the key yourself."
  }
];

export const GLOSSARY: Array<{ term: string; text: string }> = [
  { term: "Pseudo-terminal", text: "A pretend keyboard and screen the engine gives the agent, so the agent behaves as if you typed in an ordinary terminal." },
  { term: "WebSocket", text: "A two-way line between two programs that stays open, so the screen can update the instant the agent draws." },
  { term: "Recording", text: "What the terminal showed, saved on this computer as it happens, including anything you typed that appeared on screen." }
];

export interface LifeStep {
  id: "close" | "reopen" | "quit" | "resume";
  title: string;
  body: string;
}
export interface LifeSection {
  title: string;
  quiet: string;
  // The engine's second line in the diagram.
  engineNote: string;
  // The prototype's timeline (a closed window while the sessions run) is true only where closing hides the window.
  timeline: boolean;
  steps: LifeStep[];
}

const RESUME: LifeStep = {
  id: "resume",
  title: "Resume later",
  body: "Press Resume conversation on the ended tab or in Runs. The agent's own resume feature picks the conversation up again."
};

export function lifeSection({ desktop, isMac }: { desktop: boolean; isMac: boolean }): LifeSection {
  if (desktop && isMac) {
    return {
      title: "Close the window, and nothing stops",
      quiet: "Because the engine owns the sessions, not the window",
      engineNote: "Keeps running if you close the window",
      timeline: true,
      steps: [
        { id: "close", title: "Close the window", body: "Sessions keep running. The engine owns them, so closing a window ends nothing." },
        { id: "reopen", title: "Reopen", body: "The screen is restored at once, because the engine kept an invisible copy of it." },
        // Only ⌘Q and the Quit menu item can ask: the Dock's Quit, the app switcher's Quit and logging out end the
        // sessions without the question (decision Q5b, ruling R19).
        { id: "quit", title: "Quit Agent OS", body: "With ⌘Q or the Quit menu item, Agent OS asks first while sessions run. If you go ahead, it ends them." },
        RESUME
      ]
    };
  }
  if (desktop) {
    // Decision copy for Windows and Linux, step 1. The other steps say what really follows a quit.
    return {
      title: "Closing the window quits Agent OS",
      quiet: "On Windows and Linux, closing the window is how you quit",
      engineNote: "Runs while Agent OS is open",
      timeline: false,
      steps: [
        { id: "close", title: "Close the window", body: "Agent OS asks first, then quits and ends your sessions." },
        { id: "reopen", title: "Open Agent OS again", body: "Sessions that ended when Agent OS quit come back as ended tabs. Their recordings stay in Runs." },
        RESUME
      ]
    };
  }
  return {
    title: "Close this tab, and nothing stops",
    quiet: "Because the engine owns the sessions, not the page",
    engineNote: "Keeps running if you close this tab",
    timeline: false,
    steps: [
      { id: "close", title: "Close this tab", body: "Sessions keep running. The engine owns them, so closing a tab ends nothing." },
      { id: "reopen", title: "Open it again", body: "The screen is restored at once, because the engine kept an invisible copy of it." },
      { id: "quit", title: "Stop Agent OS", body: "When the Agent OS program stops, it ends the running sessions first." },
      RESUME
    ]
  };
}
