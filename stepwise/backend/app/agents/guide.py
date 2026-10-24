"""Server-owned guided repair flow: problem -> identify -> confirm machine -> steps -> report.

The guide sits in front of the agent. It handles the few utterances whose meaning is fixed
("next", "repeat", "yes", "it didn't work", a problem statement) deterministically, so the
safety interlock never depends on a model following instructions. Anything else returns
``None`` and goes to the agent as a question; the procedure stays on the current step.

Every procedure change goes through the gateway's ``apply_tool`` (the orchestrator path), so
grounding, logging and the confirm-step interlock in ``procedure_step`` all still apply.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.data.catalog import catalog
from app.vision.identify import Identification, identify

ApplyTool = Callable[[str, dict], Awaitable[Any]]
SetAsset = Callable[[str], Awaitable[None]]

IDLE, AWAITING_MACHINE, GUIDING, REPORT = "idle", "awaiting_machine", "guiding", "report"


def _matches(text: str, *patterns: str) -> bool:
    return any(re.search(rf"(^|\b){p}(\b|$)", text) for p in patterns)


def is_next(t: str) -> bool:
    return _matches(t, "next", "next step", "done", "continue", "go on", "moving on", "finished that")


def is_repeat(t: str) -> bool:
    return _matches(t, "repeat", "say (that|it) again", "again", "come again", "pardon", "what was that")


def is_yes(t: str) -> bool:
    return _matches(t, "yes", "yeah", "yep", "yup", "confirm", "confirmed", "correct", "affirmative", "that's right", "it is")


def is_no(t: str) -> bool:
    return _matches(t, "no", "nope", "not that", "wrong", "that's wrong", "negative")


def is_not_fixed(t: str) -> bool:
    return _matches(t, "didn't work", "did not work", "didnt work", "not fixed", "still (clogged|broken|not working)", "no luck", "same problem")


def is_start_over(t: str) -> bool:
    return _matches(t, "start over", "restart( the procedure)?", "from the top", "do it again")


@dataclass
class GuideTurn:
    text: str
    source_refs: list[dict[str, str]] = field(default_factory=list)
    status: dict[str, Any] = field(default_factory=dict)


def _output(outcome: Any) -> dict[str, Any]:
    out = getattr(outcome, "model_output", outcome)
    return out if isinstance(out, dict) else {}


class RepairGuide:
    def __init__(self, settings, state, apply_tool: ApplyTool, set_asset: SetAsset) -> None:
        self.settings = settings
        self.state = state
        self.apply_tool = apply_tool
        self.set_asset = set_asset
        self.phase = IDLE
        self.problem = ""
        self.pending: dict[str, Any] | None = None  # {asset_id, procedure_id, ident}
        self.identification: Identification | None = None
        self.escalation = 0

    # ── public ───────────────────────────────────────────────────────────────
    def status(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "problem": self.problem,
            "identification": self.identification.as_dict() if self.identification else None,
            "pending_machine": (self.pending or {}).get("model"),
        }

    async def handle(self, text: str, image_b64: str | None) -> GuideTurn | None:
        t = (text or "").lower().strip()
        if not t:
            return None
        if self.phase == AWAITING_MACHINE:
            return await self._on_machine_answer(t)
        if self.phase == REPORT and is_not_fixed(t):
            return self._escalate()
        if self.phase == GUIDING and self._procedure_active():
            turn = await self._on_guiding(t)
            if turn is not None:
                return turn
        proc = catalog.procedure_for_problem(t)
        if proc and not self._procedure_active():
            return await self._on_problem(text, image_b64)
        return None

    # ── problem -> identify ──────────────────────────────────────────────────
    async def _on_problem(self, text: str, image_b64: str | None) -> GuideTurn:
        self.problem = text.strip()
        self.escalation = 0
        ident = await identify(image_b64, self.problem, self.settings)
        self.identification = ident
        asset = ident.asset_id or catalog.resolve_machine(self.problem)
        if asset is None:
            self.phase = IDLE
            return self._turn("I can't tell which machine this is. Tell me the make and model, then describe the problem again.")
        proc = catalog.procedure_for_problem(self.problem, asset)
        model = self._model(asset)
        if proc is None:
            self.phase = IDLE
            return self._turn(f"The manual I have for the {model} doesn't cover that problem, so I won't guess at a fix.")
        self.pending = {"asset_id": asset, "procedure_id": proc, "model": model}
        if ident.confidence >= self.settings.identify_min_confidence and ident.asset_id == asset:
            return await self._begin(lead=f"This is the {model}. ")
        self.phase = AWAITING_MACHINE
        if ident.provider == "local":
            ask = f"I can't verify the machine from the camera right now. Is this the {model}? Say yes or no."
        else:
            ask = f"This looks like the {model}, but I'm not sure. Is that right? Say yes or no."
        return self._turn(ask)

    async def _on_machine_answer(self, t: str) -> GuideTurn:
        if is_yes(t):
            return await self._begin()
        named = catalog.resolve_machine(t)
        if named:
            proc = catalog.procedure_for_problem(self.problem, named)
            if proc is None:
                self.phase, self.pending = IDLE, None
                return self._turn(f"The manual I have for the {self._model(named)} doesn't cover that problem, so I won't guess at a fix.")
            self.pending = {"asset_id": named, "procedure_id": proc, "model": self._model(named)}
            return await self._begin()
        if is_no(t):
            self.phase, self.pending = IDLE, None
            return self._turn("Okay. Which machine is it? Tell me the make and model.")
        return self._turn(f"Is this the {(self.pending or {}).get('model', 'machine I named')}? Say yes or no.")

    async def _begin(self, lead: str = "") -> GuideTurn:
        assert self.pending
        asset, proc_id = self.pending["asset_id"], self.pending["procedure_id"]
        if self.state.asset_id != asset:
            await self.set_asset(asset)
        self.state.add_log("identify", f"Machine confirmed: {self.pending['model']}", asset_id=asset)
        out = _output(await self.apply_tool("start_procedure", {"procedure_id": proc_id}))
        self.phase, self.pending = GUIDING, None
        proc = catalog.procedures[proc_id]
        parts = [lead + f"Starting {proc.get('title', 'the procedure')}."]
        if proc.get("warnings"):
            parts.append("Safety first. " + " ".join(proc["warnings"]))
        if proc.get("tools"):
            parts.append("You'll need: " + ", ".join(proc["tools"]) + ".")
        parts.append(self._step_line(out))
        return self._turn(" ".join(parts))

    # ── guiding ──────────────────────────────────────────────────────────────
    async def _on_guiding(self, t: str) -> GuideTurn | None:
        if is_not_fixed(t):
            return self._escalate()
        if is_start_over(t):
            self.escalation = 0
            out = _output(await self.apply_tool("procedure_step", {"action": "reset"}))
            return self._turn("Starting over. " + self._step_line(out))
        if is_repeat(t):
            out = _output(await self.apply_tool("procedure_step", {"action": "repeat"}))
            return self._turn(self._step_line(out))
        if is_yes(t) and self._awaiting_confirmation():
            return await self._advance("confirm")
        if is_next(t) or is_yes(t):
            return await self._advance("next")
        return None

    async def _advance(self, action: str) -> GuideTurn:
        out = _output(await self.apply_tool("procedure_step", {"action": action}))
        if out.get("blocked"):
            return self._turn(f"I can't move on yet. {out.get('message', 'Confirm this safety step first.')}")
        if out.get("complete"):
            return await self._finish()
        lead = "Confirmed. " if action == "confirm" else ""
        return self._turn(lead + self._step_line(out))

    async def _finish(self) -> GuideTurn:
        proc = catalog.procedures.get((self.state.active_procedure or {}).get("procedure_id", ""), {})
        await self.apply_tool("generate_report", {})
        self.phase = REPORT
        verify = f" To verify the fix: {proc['verify']}" if proc.get("verify") else ""
        return self._turn(f"That's the last step.{verify} Your service report is ready. If it didn't work, tell me.")

    def _escalate(self) -> GuideTurn:
        proc = catalog.procedures.get((self.state.active_procedure or {}).get("procedure_id", ""), {})
        options = proc.get("if_not_fixed") or []
        if self.escalation < len(options):
            line = options[self.escalation]
            self.escalation += 1
            self.state.add_log("escalation", f"Operator reported not fixed; escalated: {line}")
            return self._turn(line + " Say start over to run the procedure again.")
        self.state.add_log("escalation", "Operator reported not fixed; no further grounded steps on file")
        return self._turn("I don't have another grounded step for this in the manual. Escalate to the manufacturer or a senior technician.")

    # ── helpers ──────────────────────────────────────────────────────────────
    def _procedure_active(self) -> bool:
        proc = self.state.active_procedure
        return bool(proc) and not proc.get("complete")

    def _awaiting_confirmation(self) -> bool:
        proc = self.state.active_procedure or {}
        steps, frontier = proc.get("steps", []), len(proc.get("completed", set()))
        return frontier < len(steps) and bool(steps[frontier].get("confirm")) and frontier not in proc.get("confirmed", set())

    @staticmethod
    def _model(asset: str) -> str:
        return (catalog.machine(asset) or {}).get("nameplate", {}).get("model", asset)

    @staticmethod
    def _step_line(out: dict) -> str:
        if out.get("error"):
            return str(out.get("message", "That step isn't available."))
        line = f"Step {out.get('step_number')} of {out.get('total')}. {out.get('step', '')}"
        if out.get("confirm_prompt"):
            line += f" {out['confirm_prompt']}"
        return line

    def _source_refs(self) -> list[dict[str, str]]:
        proc = catalog.procedures.get((self.state.active_procedure or {}).get("procedure_id", ""), {})
        src = proc.get("source")
        if src:
            return [{"kind": "manual", "label": src.get("title", "Manual"), "url": src.get("url", "")}]
        return [{"kind": "stepwise_catalog", "label": "STEPWISE authoritative catalog"}]

    def _turn(self, text: str) -> GuideTurn:
        return GuideTurn(text=text, source_refs=self._source_refs(), status=self.status())
