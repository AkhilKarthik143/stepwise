"""Provider-independent FORGE agent runtime.

The runtime owns conversation history and provider selection. Every tool call is
delegated to the caller's existing ``Orchestrator`` path; this module never reads
catalogs or mutates safety state directly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from app.agents import intent
from app.agents.tools.schemas import TOOLS
from app.data.catalog import catalog

logger = logging.getLogger("forge.agent_runtime")

ToolRunner = Callable[[str, dict[str, Any]], Awaitable[Any]]


@dataclass
class AgentTurn:
    text: str
    source_refs: list[dict[str, str]] = field(default_factory=list)
    provider: str = "mock"
    mock: bool = True


def anthropic_tools() -> list[dict[str, Any]]:
    """Convert the existing OpenAI-shaped FORGE schemas to Anthropic Messages tools."""
    result: list[dict[str, Any]] = []
    for tool in TOOLS.values():
        fn = tool.get("function", {})
        result.append(
            {
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return result


def _catalog_source() -> dict[str, str]:
    return {"kind": "forge_catalog", "label": "FORGE authoritative catalog"}


def _text_chunks(text: str, size: int = 72) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


class MockAgent:
    """Deterministic demo provider using the real FORGE orchestrator/tool path."""

    provider = "mock"

    def __init__(self) -> None:
        self.history: list[dict[str, Any]] = []

    async def respond(self, text: str, tool_runner: ToolRunner, *, image_b64: str | None = None) -> AgentTurn:
        del image_b64  # The deterministic fixture is intentionally image-independent.
        lower = text.lower().strip()
        self.history.append({"role": "user", "content": text})

        async def run(name: str, args: dict[str, Any]) -> dict[str, Any]:
            outcome = await tool_runner(name, args)
            if hasattr(outcome, "model_output"):
                return getattr(outcome, "model_output") or {}
            if hasattr(outcome, "output"):
                return getattr(outcome, "output") or {}
            return outcome if isinstance(outcome, dict) else {}

        if any(p in lower for p in ("what am i looking at", "what am i seeing", "identify this machine")):
            result = await run("show_machine_data", {"data_type": "nameplate"})
            machine = result.get("model") or catalog.default_asset_id
            answer = f"You're looking at the {machine}. The answer is grounded in the FORGE catalog."
        elif any(p in lower for p in ("what's wrong", "what is wrong", "diagnose", "open fault", "faults")):
            await run("show_machine_data", {"data_type": "faults"})
            telemetry = await run("show_machine_data", {"data_type": "telemetry"})
            readings = telemetry.get("readings", {})
            answer = "I found the catalog's open fault view and live telemetry. I will not infer a cause beyond those records."
            if readings:
                answer += f" Spindle torque is {readings.get('spindle_torque', {}).get('value', 'unavailable')} Nm in this demo snapshot."
        elif "highlight" in lower or "where is" in lower or "show me where" in lower or "point me" in lower:
            target = "spindle"
            for candidate in catalog.hotspot_names():
                if candidate.replace("_", " ") in lower or candidate in lower:
                    target = candidate
                    break
            result = await run("highlight_component", {"name": target})
            answer = f"{result.get('label', target).capitalize()} is in the approved component map. Tap its location in the camera to confirm the AR anchor."
        elif "schematic" in lower:
            target = "turret" if "turret" in lower else "axes" if "axis" in lower else "spindle"
            await run("show_schematic", {"diagram_type": target})
            answer = f"The {target} schematic is open. Schematic coordinates are kept separate from camera coordinates."
        elif "what should i inspect" in lower or "inspect" in lower:
            await run("show_machine_data", {"data_type": "faults"})
            await run("show_machine_data", {"data_type": "maintenance"})
            answer = "Start with the approved inspection path for the active fault. I have opened faults and recent maintenance history; safety gates still apply."
        elif "walk me through" in lower or "start the procedure" in lower or "drawbar inspection" in lower:
            await run("start_procedure", {"procedure_id": "drawbar_inspection"})
            answer = "The drawbar inspection is loaded. Step one requires confirmed LOTO before disassembly."
        elif "run" in lower and ("lockout" in lower or "loto" in lower or "safety" in lower):
            result = await run("run_safety_check", {"check_type": "loto", "action": "start"})
            answer = str(result.get("message") or "The LOTO checklist is open. Confirm each item verbally, one at a time.")
        elif lower in {"confirmed", "confirm", "yes", "i confirm"}:
            if hasattr(tool_runner, "__self__"):
                # The gateway decides whether a safety confirmation is currently valid.
                pass
            result = await run("run_safety_check", {"check_type": "loto", "action": "confirm"})
            answer = str(result.get("message") or "Confirmation recorded only if the active LOTO item allowed it.")
        elif "next" in lower:
            result = await run("procedure_step", {"action": "next"})
            answer = str(result.get("message") or "The next approved procedure step is shown. Completion still requires operator confirmation.")
        elif "report" in lower:
            result = await run("generate_report", {})
            answer = f"The maintenance report is ready. {result.get('summary', 'The structured work-order summary is in the report panel.')}"
        elif "explain that again" in lower or lower == "repeat":
            answer = "I can repeat the current grounded answer. The active evidence remains in the expanded panels below."
        else:
            # Keep the fallback useful while remaining honest about what is and is not known.
            answer = "I can help with the machine, faults, spindle location, schematics, approved steps, or a report. Ask in plain language or use the quick actions."

        self.history.append({"role": "assistant", "content": answer})
        return AgentTurn(text=answer, source_refs=[_catalog_source()], provider=self.provider, mock=True)


class ClaudeAgent:
    """Anthropic Messages API adapter with a bounded grounded tool loop."""

    provider = "claude"

    def __init__(self, api_key: str, model: str, system_prompt: str) -> None:
        self.model = model
        self.system_prompt = system_prompt
        self.history: list[dict[str, Any]] = []
        try:
            from anthropic import Anthropic

            self.client = Anthropic(api_key=api_key)
        except Exception as exc:  # pragma: no cover - exercised only with optional dependency
            raise RuntimeError("anthropic SDK is not installed") from exc

    def _request(self, messages: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]], list[dict[str, Any]]]:
        """Run one streaming request in a worker thread; return text chunks, blocks, usage."""
        chunks: list[str] = []
        with self.client.messages.stream(
            model=self.model,
            max_tokens=1200,
            system=self.system_prompt,
            tools=anthropic_tools(),
            messages=messages,
        ) as stream:
            for chunk in stream.text_stream:
                chunks.append(str(chunk))
            final = stream.get_final_message()
        blocks = [b if isinstance(b, dict) else b.model_dump() for b in final.content]
        usage = [final.usage.model_dump() if hasattr(final.usage, "model_dump") else dict(final.usage)]
        return chunks, blocks, usage

    async def respond(self, text: str, tool_runner: ToolRunner, *, image_b64: str | None = None) -> AgentTurn:
        content: list[dict[str, Any]] = [{"type": "text", "text": text}]
        if image_b64:
            content.insert(0, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}})
        self.history.append({"role": "user", "content": content})
        spoken: list[str] = []
        source_refs = [_catalog_source()]
        for _ in range(4):
            chunks, blocks, _usage = await asyncio.to_thread(self._request, self.history)
            spoken.extend(chunks)
            self.history.append({"role": "assistant", "content": blocks})
            tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
            if not tool_uses:
                break
            tool_results: list[dict[str, Any]] = []
            for call in tool_uses:
                name = str(call.get("name", ""))
                args = call.get("input") if isinstance(call.get("input"), dict) else {}
                # The orchestrator/grounding layer remains the single authority.
                outcome = await tool_runner(name, args)
                result = getattr(outcome, "model_output", outcome) or {}
                tool_results.append({"type": "tool_result", "tool_use_id": call.get("id", ""), "content": json.dumps(result, ensure_ascii=False)})
            self.history.append({"role": "user", "content": tool_results})
        answer = "".join(spoken).strip() or "The grounded tool result is shown on screen."
        return AgentTurn(text=answer, source_refs=source_refs, provider=self.provider, mock=False)


def build_agent(settings, *, system_prompt: str) -> MockAgent | ClaudeAgent:
    provider = str(getattr(settings, "agent_provider", "mock") or "mock").lower()
    if provider == "claude" and getattr(settings, "anthropic_api_key", ""):
        try:
            return ClaudeAgent(settings.anthropic_api_key, settings.anthropic_model, system_prompt)
        except Exception as exc:  # pragma: no cover - optional dependency posture
            logger.warning("Claude unavailable; using deterministic mock: %s", exc)
    return MockAgent()
