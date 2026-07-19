"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api, type GridCell } from "@/lib/api";
import { compressImageToDataUrl } from "@/lib/image";
import { cn } from "@/lib/utils";

const CELL_TYPES: { type: string; label: string; className: string }[] = [
  { type: "open", label: "Open", className: "bg-transparent" },
  { type: "wall", label: "Wall", className: "bg-muted-foreground/60" },
  { type: "door", label: "Door", className: "bg-heat-cool/70" },
  { type: "exit", label: "Exit", className: "bg-emerald-500/70" },
  { type: "ramp", label: "Ramp", className: "bg-primary/60" },
  { type: "stairs", label: "Stairs", className: "bg-heat-warm/70" },
  { type: "elevator", label: "Elevator", className: "bg-accent/70" },
  { type: "service_point", label: "Service point", className: "bg-chart-5/60" },
];

const GRID_W = 20;
const GRID_H = 14;

function emptyGrid(): Map<string, GridCell> {
  const cells = new Map<string, GridCell>();
  for (let x = 0; x < GRID_W; x++) {
    for (let y = 0; y < GRID_H; y++) {
      cells.set(`${x},${y}`, { x, y, type: "open" });
    }
  }
  return cells;
}

export function GridEditor() {
  const router = useRouter();
  const [cells, setCells] = useState<Map<string, GridCell>>(emptyGrid);
  const [activeType, setActiveType] = useState("wall");
  const [entryPoint, setEntryPoint] = useState<{ x: number; y: number } | null>(null);
  const [exitPoint, setExitPoint] = useState<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<"paint" | "entry" | "exit">("paint");
  const [planName, setPlanName] = useState("Untitled plan");
  const [saving, setSaving] = useState(false);
  const [isPainting, setIsPainting] = useState(false);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [imageOpacity, setImageOpacity] = useState(0.55);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    try {
      const dataUrl = await compressImageToDataUrl(file);
      setReferenceImage(dataUrl);
    } finally {
      setUploadingImage(false);
    }
  }

  function paintCell(x: number, y: number) {
    if (mode === "entry") {
      setEntryPoint({ x, y });
      return;
    }
    if (mode === "exit") {
      setExitPoint({ x, y });
      return;
    }
    setCells((prev) => {
      const next = new Map(prev);
      next.set(`${x},${y}`, { x, y, type: activeType });
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const plan = await api.createPlan({
        name: planName,
        width_cells: GRID_W,
        height_cells: GRID_H,
        cell_size_meters: 1,
        cells: Array.from(cells.values()).filter((c) => c.type !== "open"),
        entry_points: entryPoint
          ? [{ x: entryPoint.x, y: entryPoint.y, label: "main entry" }]
          : [],
        exit_points: exitPoint ? [{ x: exitPoint.x, y: exitPoint.y, label: "main exit" }] : [],
        source_image_blob_url: referenceImage ?? undefined,
      });
      router.push(`/dashboard/simulations/new?planId=${plan.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <Card className="glass-sm">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-64"
          />
          <Button
            onClick={handleSave}
            disabled={saving || !entryPoint || !exitPoint}
            className="w-full sm:w-auto"
          >
            {saving ? "Saving..." : "Save & configure simulation"}
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="relative min-w-[560px] overflow-hidden rounded-lg border border-border/60">
            {referenceImage && (
              // Traced-image underlay: paint cell types over the real floor plan instead of
              // guessing wall positions from scratch. See docs/architecture.md.
              <img
                src={referenceImage}
                alt="Reference floor plan being traced"
                className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                style={{ opacity: imageOpacity }}
              />
            )}
            <div
              className="relative grid select-none gap-px bg-border/60 p-px"
              style={{ gridTemplateColumns: `repeat(${GRID_W}, minmax(0, 1fr))` }}
              onMouseUp={() => setIsPainting(false)}
              onMouseLeave={() => setIsPainting(false)}
            >
              {Array.from(cells.values()).map((cell) => {
                const isEntry = entryPoint?.x === cell.x && entryPoint?.y === cell.y;
                const isExit = exitPoint?.x === cell.x && exitPoint?.y === cell.y;
                const typeStyle = CELL_TYPES.find((t) => t.type === cell.type)?.className;
                return (
                  <div
                    key={`${cell.x},${cell.y}`}
                    onMouseDown={() => {
                      setIsPainting(true);
                      paintCell(cell.x, cell.y);
                    }}
                    onMouseEnter={() => isPainting && mode === "paint" && paintCell(cell.x, cell.y)}
                    className={cn(
                      "aspect-square cursor-pointer bg-background transition-colors hover:bg-secondary",
                      typeStyle,
                      isEntry && "bg-primary ring-2 ring-primary",
                      isExit && "bg-emerald-500 ring-2 ring-emerald-400"
                    )}
                    title={isEntry ? "Entry" : isExit ? "Exit" : cell.type}
                  />
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
        <Card className="glass-sm">
          <CardHeader>
            <CardTitle className="text-sm">Reference image</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
            {!referenceImage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={uploadingImage}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageUp className="size-4" />
                {uploadingImage ? "Processing..." : "Upload floor plan image"}
              </Button>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Trace over the image below</span>
                  <Button size="sm" variant="ghost" onClick={() => setReferenceImage(null)}>
                    <X className="size-3.5" />
                    Remove
                  </Button>
                </div>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Overlay opacity
                  <input
                    type="range"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={imageOpacity}
                    onChange={(e) => setImageOpacity(Number(e.target.value))}
                  />
                </label>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              Upload a real floor plan and paint walls/doors/ramps directly over it — the
              image is traced, not auto-parsed.
            </p>
          </CardContent>
        </Card>

        <Card className="glass-sm">
          <CardHeader>
            <CardTitle className="text-sm">Paint tool</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {CELL_TYPES.map((t) => (
              <Badge
                key={t.type}
                variant={activeType === t.type && mode === "paint" ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => {
                  setActiveType(t.type);
                  setMode("paint");
                }}
              >
                {t.label}
              </Badge>
            ))}
          </CardContent>
        </Card>

        <Card className="glass-sm">
          <CardHeader>
            <CardTitle className="text-sm">Entry &amp; exit</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button
              size="sm"
              variant={mode === "entry" ? "default" : "outline"}
              onClick={() => setMode("entry")}
            >
              {entryPoint ? `Entry set (${entryPoint.x}, ${entryPoint.y})` : "Place entry point"}
            </Button>
            <Button
              size="sm"
              variant={mode === "exit" ? "default" : "outline"}
              onClick={() => setMode("exit")}
            >
              {exitPoint ? `Exit set (${exitPoint.x}, ${exitPoint.y})` : "Place exit point"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Click a cell on the grid after selecting a tool above. Both an entry and exit
              point are required before you can run a simulation.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
