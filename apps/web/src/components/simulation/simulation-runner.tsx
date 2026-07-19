"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { API_WS_URL, api, type Persona } from "@/lib/api";
import { getToken } from "@/lib/auth-client";
import { SimulationCanvas, type LiveAgent } from "@/components/simulation/simulation-canvas";
import { ReportPanel, type ComplianceFinding, type Bottleneck } from "@/components/simulation/report-panel";

interface Props {
  planId: string;
}

const DEFAULT_COUNT = 6;

export function SimulationRunner({ planId }: Props) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [mix, setMix] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [agents, setAgents] = useState<Record<string, LiveAgent>>({});
  const [tick, setTick] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [finalElapsedSeconds, setFinalElapsedSeconds] = useState<number | null>(null);
  const [finalTicks, setFinalTicks] = useState<number | null>(null);
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[]>([]);
  const [findings, setFindings] = useState<ComplianceFinding[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api.listPersonas().then((list) => {
      setPersonas(list);
      const initialMix: Record<string, number> = {};
      list.forEach((p) => (initialMix[p.id] = p.id === "rushed_commuter" ? DEFAULT_COUNT : 2));
      setMix(initialMix);
    });
  }, []);

  function startSimulation() {
    setStatus("running");
    setAgents({});
    setBottlenecks([]);
    setFindings([]);
    setTick(0);
    setElapsedSeconds(0);
    setFinalElapsedSeconds(null);
    setFinalTicks(null);

    const ws = new WebSocket(`${API_WS_URL}/api/simulations/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          token: getToken(),
          plan_id: planId,
          persona_mix: Object.entries(mix)
            .filter(([, count]) => count > 0)
            .map(([persona_id, count]) => ({ persona_id, count })),
        })
      );
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) {
        setStatus("error");
        return;
      }
      if (data.final) {
        setBottlenecks(data.bottlenecks ?? []);
        setFindings(data.findings ?? []);
        setFinalElapsedSeconds(data.elapsed_seconds ?? null);
        setFinalTicks(data.ticks ?? null);
        setStatus("done");
        return;
      }
      setTick(data.tick);
      if (typeof data.elapsed_seconds === "number") setElapsedSeconds(data.elapsed_seconds);
      setAgents((prev) => {
        const next = { ...prev };
        for (const a of data.agents) {
          next[a.agent_id] = a;
        }
        return next;
      });
    };

    ws.onerror = () => setStatus("error");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <Card className="glass-sm lg:sticky lg:top-24 lg:self-start">
        <CardHeader>
          <CardTitle className="text-sm">Persona mix</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {personas.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.mobility_profile}</p>
              </div>
              <input
                type="number"
                min={0}
                max={20}
                value={mix[p.id] ?? 0}
                onChange={(e) =>
                  setMix((prev) => ({ ...prev, [p.id]: Number(e.target.value) }))
                }
                className="w-16 rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ))}
          <Button onClick={startSimulation} disabled={status === "running"} className="mt-2">
            {status === "running" ? "Running..." : status === "done" ? "Run again" : "Run simulation"}
          </Button>
          {status === "running" && (
            <p className="text-center text-xs text-muted-foreground">
              Tick {tick} · {elapsedSeconds.toFixed(1)}s elapsed
            </p>
          )}
          {status === "done" && finalElapsedSeconds !== null && (
            <p className="text-center text-xs text-muted-foreground">
              Finished in {finalElapsedSeconds.toFixed(1)}s across {finalTicks} tick
              {finalTicks === 1 ? "" : "s"}
            </p>
          )}
          {status === "error" && (
            <Badge variant="destructive">Simulation failed — check API logs</Badge>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        <SimulationCanvas agents={Object.values(agents)} />
        {status === "done" && <ReportPanel bottlenecks={bottlenecks} findings={findings} />}
      </div>
    </div>
  );
}
