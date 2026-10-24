import pytest

from app.agents.runtime import MockAgent, anthropic_tools
from app.agents.tools.handlers import ToolResult
from app.ar.annotations import confirmed_anchor, normalize_box
from app.grounding.whitelists import validate


def test_claude_tool_mapping_preserves_existing_names_and_schemas():
    tools = anthropic_tools()
    names = {tool["name"] for tool in tools}
    assert "show_machine_data" in names
    assert "highlight_component" in names
    assert "retrieve_knowledge" in names
    highlight = next(tool for tool in tools if tool["name"] == "highlight_component")
    assert highlight["input_schema"]["additionalProperties"] is False


def test_bad_retrieval_and_anchor_args_are_rejected():
    assert not validate("retrieve_knowledge", {"query": ""})
    assert normalize_box([1, 2, 1, 5]) is None
    assert confirmed_anchor("not-a-component", [100, 100, 300, 300]) is None
    assert confirmed_anchor("spindle", [100, 100, 300, 300], source="model_guess") is None


def test_user_confirmed_anchor_is_structured_and_source_aware():
    event = confirmed_anchor("spindle", [100, 200, 400, 600])
    assert event is not None
    assert event["type"] == "ar.annotation.add"
    assert event["anchor"]["coordinate_system"] == "normalized_1000"
    assert event["anchor"]["source"] == "user_confirmed"
    assert event["tracking_status"] == "confirmed"


@pytest.mark.asyncio
async def test_mock_demo_uses_the_grounded_tool_runner():
    calls = []

    async def runner(name, args):
        calls.append((name, args))
        if name == "show_machine_data":
            return ToolResult(output={"model": "PL45LM Turn-Mill"})
        return ToolResult(output={"ok": True})

    turn = await MockAgent().respond("FORGE, what am I looking at?", runner)
    assert turn.mock is True
    assert "PL45LM" in turn.text
    assert calls == [("show_machine_data", {"data_type": "nameplate"})]
