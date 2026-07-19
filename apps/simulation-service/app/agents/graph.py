"""LangGraph StateGraph for the Myriox simulation.

Design (per architecture plan):
  - Agents emit *intentions* ("move north", "wait") rather than mutating shared state directly.
  - A central GridValidator node resolves legality/collisions and commits the authoritative
    position for the tick.
  - The graph runs one tick per invocation; the orchestrator service loops it and streams
    each tick's AgentState list over the WebSocket, and persists checkpoints to Cosmos DB.
"""

from __future__ import annotations

import json
from typing import Annotated, TypedDict

from langchain_core.messages import SystemMessage
from langchain_openai import AzureChatOpenAI
from langgraph.graph import END, StateGraph

from app.agents.grid_world import GridWorld
from app.agents.personas import get_persona
from app.agents.types import AgentState
from app.core.config import get_settings

MAX_STUCK_TICKS_BEFORE_GIVE_UP = 15


def _merge_agents(existing: list[AgentState], updates: list[AgentState]) -> list[AgentState]:
    by_id = {a["agent_id"]: a for a in existing}
    for updated in updates:
        by_id[updated["agent_id"]] = updated
    return list(by_id.values())


class SimulationState(TypedDict):
    run_id: str
    tick: int
    grid: GridWorld
    agents: Annotated[list[AgentState], _merge_agents]
    intentions: dict[str, str]


def _build_llm() -> AzureChatOpenAI:
    settings = get_settings()
    return AzureChatOpenAI(
        azure_endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        api_version=settings.azure_openai_api_version,
        azure_deployment=settings.agent_reasoning_deployment,
        temperature=0.4,
        max_tokens=120,
        # Bound worst-case per-tick latency: without an explicit timeout/retry cap, a
        # throttled or slow Azure OpenAI call can stall a single tick for minutes, and with
        # up to MAX_TICKS ticks per run that compounds into runs that appear to hang for hours.
        timeout=20.0,
        max_retries=1,
    )


def _visible_cells(grid: GridWorld, x: int, y: int, radius: int = 2) -> list[dict]:
    visible = []
    for dx in range(-radius, radius + 1):
        for dy in range(-radius, radius + 1):
            nx, ny = x + dx, y + dy
            if grid.in_bounds(nx, ny):
                visible.append({"x": nx, "y": ny, "type": grid.cell_type_at(nx, ny)})
    return visible


def persona_agent_node(llm: AzureChatOpenAI):
    """Returns a LangGraph node function that lets every non-exited agent choose its next
    intention. Every agent's reasoning is independent (no shared state is read until the
    GridValidator node), so all active agents are dispatched as one `llm.batch(...)` call —
    that fans the requests out across a thread pool instead of awaiting them one at a time,
    which is what made ticks scale linearly (and slowly) with agent count before this change.
    Kept as a closure so the LLM client is constructed once per graph, not per tick."""

    def _node(state: SimulationState) -> dict:
        grid = state["grid"]
        # "stuck" is a terminal give-up state (see MAX_STUCK_TICKS_BEFORE_GIVE_UP below) — the
        # agent isn't going anywhere, so skip the LLM call and free up concurrency budget for
        # agents that can still make progress this tick.
        active_agents = [
            a for a in state["agents"] if a["status"] not in ("exited", "stuck")
        ]
        if not active_agents:
            return {"intentions": {}}

        prompts = []
        for agent in active_agents:
            persona = get_persona(agent["persona_id"])
            visible = _visible_cells(grid, agent["x"], agent["y"])
            prompt = (
                f"You are simulating a pedestrian persona: {persona.name}. "
                f"Traits: {', '.join(persona.traits)}. Objective: {persona.objective}. "
                f"Mobility profile: {persona.mobility_profile}.\n"
                f"Current position: ({agent['x']}, {agent['y']}). "
                f"Visible cells (radius 2): {json.dumps(visible)}. "
                f"Recently visited (avoid looping): {agent['visited'][-6:]}. "
                "Choose exactly one move: north, south, east, west, or wait. "
                'Respond with strict JSON: {"direction": "...", "thought": "one short sentence"}'
            )
            prompts.append([SystemMessage(content=prompt)])

        responses = llm.batch(
            prompts, config={"max_concurrency": len(prompts)}, return_exceptions=True
        )

        intentions: dict[str, str] = {}
        for agent, response in zip(active_agents, responses):
            direction, thought = "wait", None
            if not isinstance(response, BaseException):
                try:
                    parsed = json.loads(response.content)
                    direction = parsed.get("direction", "wait")
                    thought = parsed.get("thought")
                except Exception:
                    pass
            intentions[agent["agent_id"]] = direction
            agent["thought"] = thought

        return {"intentions": intentions}

    return _node


def grid_validator_node(state: SimulationState) -> dict:
    grid = state["grid"]
    updated_agents: list[AgentState] = []

    for agent in state["agents"]:
        if agent["status"] == "exited":
            updated_agents.append(agent)
            continue

        persona = get_persona(agent["persona_id"])
        direction = state["intentions"].get(agent["agent_id"], "wait")
        nx, ny, moved = grid.resolve_move(
            agent["x"], agent["y"], direction, persona.mobility_profile
        )

        new_status = agent["status"]
        ticks_stuck = agent["ticks_stuck"]
        visited = agent["visited"]

        if (nx, ny) in grid.exit_points:
            new_status = "exited"
        elif not moved:
            new_status = "blocked"
            ticks_stuck += 1
        elif (nx, ny) != (agent["x"], agent["y"]):
            new_status = "moving"
            ticks_stuck = 0
            visited = (visited + [(nx, ny)])[-20:]
        else:
            # Agent chose (or defaulted to) "wait" and stayed put. This still counts toward
            # the give-up counter — otherwise an agent that just keeps waiting is frozen at
            # whatever ticks_stuck it already had and can never reach "stuck", which meant
            # the run's early-exit check (all agents stuck) could never fire for it and every
            # run burned its full tick budget even when nothing was actually happening.
            new_status = "waiting"
            ticks_stuck += 1

        if ticks_stuck >= MAX_STUCK_TICKS_BEFORE_GIVE_UP:
            new_status = "stuck"

        updated_agents.append(
            {
                **agent,
                "x": nx,
                "y": ny,
                "status": new_status,
                "ticks_stuck": ticks_stuck,
                "visited": visited,
            }
        )

    return {"agents": updated_agents, "tick": state["tick"] + 1}


def build_simulation_graph() -> StateGraph:
    llm = _build_llm()
    graph = StateGraph(SimulationState)
    graph.add_node("persona_agents", persona_agent_node(llm))
    graph.add_node("grid_validator", grid_validator_node)

    graph.set_entry_point("persona_agents")
    graph.add_edge("persona_agents", "grid_validator")
    graph.add_edge("grid_validator", END)

    return graph


def compile_simulation_graph():
    """Compiled, checkpoint-free graph for a single tick. The orchestrator service owns the
    tick loop and Cosmos-backed persistence between ticks (see app/services/simulation.py)."""
    return build_simulation_graph().compile()
