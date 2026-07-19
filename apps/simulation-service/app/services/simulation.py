"""Simulation orchestrator: owns the tick loop, Cosmos checkpointing, bottleneck heat
aggregation, and hands struggle summaries to the Compliance Auditor at the end of a run.
Plan geometry is fetched from the Plan Service over HTTP — this service never touches
the `plans` Cosmos container."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from app.agents.compliance import deterministic_geometry_findings, synthesize_llm_findings
from app.agents.grid_world import GridWorld
from app.agents.graph import compile_simulation_graph
from app.agents.personas import get_persona
from app.agents.types import AgentState
from app.services.cosmos import agent_events_container, runs_container
from app.services.plan_client import fetch_plan

MAX_TICKS = 60


def _new_agents(plan: dict, persona_mix: list[dict]) -> list[AgentState]:
    agents: list[AgentState] = []
    entries = plan["entry_points"] or [{"x": 0, "y": 0, "label": "default"}]
    idx = 0
    for mix in persona_mix:
        for _ in range(mix["count"]):
            entry = entries[idx % len(entries)]
            agents.append(
                AgentState(
                    agent_id=str(uuid.uuid4()),
                    persona_id=mix["persona_id"],
                    x=entry["x"],
                    y=entry["y"],
                    status="moving",
                    ticks_stuck=0,
                    visited=[(entry["x"], entry["y"])],
                    thought=None,
                )
            )
            idx += 1
    return agents


async def run_simulation(
    org_id: str, plan_id: str, persona_mix: list[dict]
) -> AsyncIterator[dict]:
    """Async generator yielding one tick summary dict at a time, for the WebSocket router
    to stream straight through. Also persists per-tick agent events and the final run
    document + compliance findings to Cosmos."""
    run_started = time.monotonic()
    plan_item = await fetch_plan(org_id, plan_id)
    grid = GridWorld.from_plan(plan_item)
    graph = compile_simulation_graph()

    run_id = str(uuid.uuid4())
    agent_count = sum(m["count"] for m in persona_mix)
    run_doc = {
        "id": run_id,
        "orgId": org_id,
        "planId": plan_id,
        "status": "running",
        "agentCount": agent_count,
        "personaMix": persona_mix,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "bottlenecks": [],
        "complianceFindings": [],
    }
    # Cosmos SDK calls are synchronous network I/O; run them off the event loop thread so a
    # slow write never blocks the tick loop or other concurrent connections on this worker.
    await asyncio.to_thread(runs_container().create_item, run_doc)

    state = {
        "run_id": run_id,
        "tick": 0,
        "grid": grid,
        "agents": _new_agents(plan_item, persona_mix),
        "intentions": {},
    }

    heat: Counter[tuple[int, int]] = Counter()
    struggle_summaries: set[str] = set()

    for _ in range(MAX_TICKS):
        try:
            # Hard ceiling on a single tick's wall-clock time. Without this, a stalled or
            # heavily-throttled Azure OpenAI call inside graph.invoke() can block a tick
            # indefinitely, which is what made runs appear to hang for hours instead of
            # failing fast and surfacing an error to the client.
            state = await asyncio.wait_for(
                asyncio.to_thread(graph.invoke, state), timeout=45.0
            )
        except asyncio.TimeoutError:
            state["agents"] = [
                {**a, "status": "stuck"} if a["status"] not in ("exited", "stuck") else a
                for a in state["agents"]
            ]
            break

        active = [a for a in state["agents"] if a["status"] != "exited"]
        for agent in state["agents"]:
            heat[(agent["x"], agent["y"])] += 1
            if agent["status"] in ("blocked", "stuck"):
                persona = get_persona(agent["persona_id"])
                # Name the cell types actually blocking the agent (e.g. "stairs") and the
                # agent's mobility profile — without this concrete detail the report LLM has
                # nothing to distinguish "genuine code violation" from "ordinary crowding".
                neighbor_types = sorted(
                    {
                        grid.cell_type_at(agent["x"] + dx, agent["y"] + dy)
                        for dx, dy in ((0, 1), (0, -1), (1, 0), (-1, 0))
                        if grid.in_bounds(agent["x"] + dx, agent["y"] + dy)
                    }
                )
                struggle_summaries.add(
                    f"Persona {agent['persona_id']} (mobility profile: {persona.mobility_profile}) "
                    f"became {agent['status']} at ({agent['x']}, {agent['y']}) after "
                    f"{agent['ticks_stuck']} consecutive ticks with no progress. Adjacent cell "
                    f"types blocking movement: {neighbor_types}."
                )

        tick_payload = {
            "run_id": run_id,
            "tick": state["tick"],
            "elapsed_seconds": round(time.monotonic() - run_started, 1),
            "agents": [
                {
                    "agent_id": a["agent_id"],
                    "persona_id": a["persona_id"],
                    "x": a["x"],
                    "y": a["y"],
                    "status": a["status"],
                    "thought": a["thought"],
                }
                for a in state["agents"]
            ],
        }

        # Persist the checkpoint in the background instead of awaiting it before streaming
        # the tick to the client — the frontend doesn't need to wait on a Cosmos round-trip
        # to see the next tick, and this call is fire-and-forget from the loop's perspective.
        asyncio.create_task(
            asyncio.to_thread(
                agent_events_container().create_item,
                {
                    "id": str(uuid.uuid4()),
                    "orgId": org_id,
                    "runId": run_id,
                    **tick_payload,
                },
            )
        )
        yield tick_payload

        # Stop once nothing can change further: no one left mid-route, or everyone remaining
        # has already given up (status "stuck") rather than just being "blocked" this tick.
        if not active or all(a["status"] == "stuck" for a in active):
            break

    bottlenecks = [
        {"x": x, "y": y, "heat": count / max(1, agent_count)}
        for (x, y), count in heat.most_common(25)
    ]

    # Geometry findings are pure CPU (no LLM/network call) and don't depend on the LLM
    # findings at all, so run both concurrently instead of paying their latency serially.
    geometry_findings, llm_findings = await asyncio.gather(
        asyncio.to_thread(
            deterministic_geometry_findings, run_id, grid, plan_item.get("cell_size_meters", 1.0)
        ),
        synthesize_llm_findings(run_id, list(struggle_summaries)),
    )
    all_findings = geometry_findings + llm_findings
    elapsed_seconds = round(time.monotonic() - run_started, 1)

    await asyncio.to_thread(
        runs_container().replace_item,
        item=run_id,
        body={
            **run_doc,
            "status": "completed",
            "completedAt": datetime.now(timezone.utc).isoformat(),
            "bottlenecks": bottlenecks,
            "complianceFindings": all_findings,
            "elapsedSeconds": elapsed_seconds,
        },
    )

    yield {
        "run_id": run_id,
        "final": True,
        "bottlenecks": bottlenecks,
        "findings": all_findings,
        "elapsed_seconds": elapsed_seconds,
        "ticks": state["tick"],
    }
