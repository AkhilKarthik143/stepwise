import type { GuideStatus, SourceRef } from "../lib/api";

interface Props {
  guide: GuideStatus;
  step: any; // the "procedure" panel payload (procedure or safety checklist view)
  report?: string;
  sources: SourceRef[];
  onSay: (text: string) => void;
}

// The hands-free card under the guidance text. Every button sends the same phrase the
// technician would say, so voice and tap go through one server path (and one interlock).
export function RepairCard({ guide, step, report, sources, onSay }: Props) {
  if (guide.phase === "awaiting_machine") {
    const ident = guide.identification;
    const how = !ident || ident.provider === "local"
      ? "Camera identification is off, so confirm the machine yourself."
      : `Claude vision guess · ${Math.round(ident.confidence * 100)}% confident`;
    return (
      <div className="stepwise-step-card stepwise-step-card--confirm">
        <span>CONFIRM MACHINE</span>
        <b>Is this the {guide.pending_machine}?</b>
        <small>{how}</small>
        <div className="stepwise-say-row">
          <button className="is-primary" onClick={() => onSay("yes")}>Yes</button>
          <button onClick={() => onSay("no")}>No</button>
        </div>
      </div>
    );
  }

  if (step?.mode === "procedure" && !step.complete) {
    const steps: any[] = step.steps || [];
    const idx: number = step.current ?? step.index ?? 0;
    const current = steps[idx] || {};
    const locked = !!step.awaiting_confirmation;
    const source: SourceRef | undefined = step.source ? { kind: "manual", label: step.source.title, url: step.source.url } : sources.find((s) => s.url);
    return (
      <div className={`stepwise-step-card ${locked ? "stepwise-step-card--locked" : ""}`}>
        <span>STEP {Math.min(idx + 1, steps.length)} / {steps.length} · {step.title}</span>
        <b>{current.text || "Current approved action"}</b>
        {current.confirm && (
          <small className="stepwise-safety-note">
            {locked ? `SAFETY LOCK · ${current.confirm_prompt || "Confirm this step to continue."}` : "Safety step confirmed."}
          </small>
        )}
        {idx === 0 && step.tools?.length > 0 && <small>Tools: {step.tools.join(", ")}</small>}
        {/* No figure is ever generated. Show the real one when the manual has it, else the source. */}
        {current.figure_url
          ? <img className="stepwise-figure" src={current.figure_url} alt={`Manual figure for step ${current.n}`} />
          : <small className="stepwise-source">No manual figure on file. {source?.url ? <a href={source.url} target="_blank" rel="noreferrer">Source: {source.label}</a> : "Source: STEPWISE catalog"}</small>}
        <div className="stepwise-say-row">
          <button onClick={() => onSay("repeat")}>Repeat</button>
          {locked
            ? <button className="is-primary is-safety" onClick={() => onSay("yes")}>Yes, confirmed</button>
            : <button className="is-primary" onClick={() => onSay("next")}>Next</button>}
          <button onClick={() => onSay("it didn't work")}>It didn't work</button>
        </div>
      </div>
    );
  }

  if (step?.mode === "safety" && !step.complete) {
    const items: any[] = step.items || [];
    const idx: number = step.index ?? 0;
    return (
      <div className="stepwise-step-card stepwise-step-card--locked">
        <span>{step.title} · ITEM {idx + 1} / {items.length}</span>
        <b>{items[idx]?.text}</b>
        <small>{items[idx]?.prompt || "Say confirmed to advance this safety item."}</small>
        <div className="stepwise-say-row"><button className="is-primary is-safety" onClick={() => onSay("confirmed")}>Confirmed</button></div>
      </div>
    );
  }

  if (report && guide.phase === "report") {
    const download = () => {
      const url = URL.createObjectURL(new Blob([report], { type: "text/plain" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "stepwise-service-report.txt" });
      a.click();
      URL.revokeObjectURL(url);
    };
    return (
      <div className="stepwise-step-card stepwise-step-card--report">
        <span>SERVICE REPORT</span>
        <pre>{report}</pre>
        <div className="stepwise-say-row">
          <button className="is-primary" onClick={download}>Download report</button>
          <button onClick={() => onSay("it didn't work")}>It didn't work</button>
        </div>
      </div>
    );
  }

  return null;
}
