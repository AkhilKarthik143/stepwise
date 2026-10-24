import type { BuildStatus } from "../lib/api";

interface Props {
  status: BuildStatus;
  lastCheckFrame: string | null; // base64 JPEG the last check was run on
}

// The current step: the manual's picture, what to grab, what to do. When a check fails it turns
// into the side-by-side view, manual on the left, camera on the right, the problem in words.
export function StepPanel({ status, lastCheckFrame }: Props) {
  const { build, step, check } = status;
  if (!build) return null;
  if (status.complete || !step) {
    return <section className="bs-step bs-step--done"><span className="bs-kicker">BUILD COMPLETE</span><b>The {build.title} is done.</b></section>;
  }
  const failed = check?.state === "failed" && (check.issues?.length ?? 0) > 0;
  const parts = step.parts.map((p) => `${p.qty > 1 ? `${p.qty}× ` : ""}${[p.color, p.name].filter(Boolean).join(" ")}`);

  return (
    <section className={`bs-step ${failed ? "bs-step--failed" : check?.state === "passed" ? "bs-step--passed" : ""}`} aria-live="polite">
      <div className="bs-step-head">
        <span className="bs-kicker">STEP {step.step} / {build.total}</span>
        <span className={`bs-check bs-check--${check?.state ?? "unchecked"}`}>{checkLabel(check?.state)}</span>
      </div>

      {failed ? (
        <>
          <div className="bs-compare">
            <figure><img src={step.image_url} alt={`Manual picture for step ${step.step}`} /><figcaption>Manual</figcaption></figure>
            <figure>{lastCheckFrame ? <img src={`data:image/jpeg;base64,${lastCheckFrame}`} alt="What the camera saw" /> : <div className="bs-compare-empty" />}<figcaption>Your build</figcaption></figure>
          </div>
          {check!.issues.map((i, n) => (
            <p key={n} className="bs-issue"><b>{i.part}: {i.problem}.</b> {i.fix}</p>
          ))}
        </>
      ) : (
        <div className="bs-step-body">
          <img className="bs-step-img" src={step.image_url} alt={`Manual picture for step ${step.step}`} />
          <div>
            <b className="bs-action">{step.action}</b>
            {parts.length > 0 && <ul className="bs-parts">{parts.map((p) => <li key={p}>{p}</li>)}</ul>}
            {step.watch_for.length > 0 && <small className="bs-watch">Watch for: {step.watch_for.join(", ")}</small>}
          </div>
        </div>
      )}
      <small className="bs-source">
        Manual page {step.page}{build.source?.url ? <> · <a href={build.source.url} target="_blank" rel="noreferrer">{build.source.title}</a></> : null}
        {!step.approved && " · not yet approved by a supervisor"}
      </small>
    </section>
  );
}

function checkLabel(state?: string) {
  switch (state) {
    case "passed": return "looks right";
    case "failed": return "mistake found";
    case "building": return "in progress";
    default: return "not checked";
  }
}
