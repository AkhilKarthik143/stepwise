"""Voice/provider posture tests: live providers must fail closed to truthful local mode."""

from types import SimpleNamespace

import pytest

from app.agents.runtime import MockAgent, anthropic_tools, build_agent
from app.knowledge.providers import LocalDocumentProvider, MossProvider
from app.realtime.cartesia import CartesiaTTS, CartesiaUnavailable, status
from app.data.catalog import catalog


def test_anthropic_tool_conversion_keeps_strict_schemas():
    tools = anthropic_tools()
    highlight = next(tool for tool in tools if tool["name"] == "highlight_component")
    assert highlight["input_schema"]["additionalProperties"] is False
    assert {tool["name"] for tool in tools} >= {"show_machine_data", "retrieve_knowledge", "run_safety_check"}


def test_missing_claude_credentials_selects_deterministic_mock():
    settings = SimpleNamespace(agent_provider="claude", anthropic_api_key="", anthropic_model="unused")
    agent = build_agent(settings, system_prompt="test")
    assert isinstance(agent, MockAgent)
    assert agent.provider == "mock"


@pytest.mark.asyncio
async def test_local_retrieval_is_labeled_and_nonempty():
    result = await LocalDocumentProvider(catalog).query("lockout safety")
    assert result.status == "local_fallback"
    assert result.provider == "local"
    assert result.passages


@pytest.mark.asyncio
async def test_moss_adapter_falls_back_when_sdk_is_unavailable(monkeypatch):
    monkeypatch.setattr("app.knowledge.providers.importlib.util.find_spec", lambda _: None)
    result = await MossProvider("project", "key", "index", LocalDocumentProvider(catalog)).query("safety")
    assert result.status == "local_fallback"
    assert result.provider == "local"


def test_cartesia_status_and_generation_fail_closed_without_credentials():
    posture = status("")
    assert posture["configured"] is False
    assert posture["provider"] == "mock"

    async def exercise():
        with pytest.raises(CartesiaUnavailable):
            await CartesiaTTS("", "voice").generate("hello")

    import asyncio

    asyncio.run(exercise())
