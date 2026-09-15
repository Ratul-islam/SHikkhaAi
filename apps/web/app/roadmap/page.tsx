"use client";

import "reactflow/dist/style.css";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import ReactFlow, { Background, Controls, type Edge, type Node } from "reactflow";
import { Sparkles, PlayCircle, BookOpenText } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import type { RoadmapNode } from "../../lib/types";
import SkillNode, { type SkillNodeData } from "../../components/roadmap/SkillNode";
import CurvedEdge, { type CurvedEdgeData } from "../../components/roadmap/CurvedEdge";
import { Button } from "@/components/ui/button";

const nodeTypes = { skill: SkillNode };
const edgeTypes = { curved: CurvedEdge };

function layoutNodes(nodes: RoadmapNode[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthCache = new Map<string, number>();

  function depthOf(id: string, seen: Set<string> = new Set()): number {
    if (depthCache.has(id)) return depthCache.get(id) as number;
    if (seen.has(id)) return 0;
    seen.add(id);

    const node = byId.get(id);
    if (!node || node.prerequisites.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const depth = 1 + Math.max(...node.prerequisites.map((p) => (byId.has(p) ? depthOf(p, seen) : 0)));
    depthCache.set(id, depth);
    return depth;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const countPerDepth = new Map<number, number>();

  const sorted = [...nodes].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const node of sorted) {
    const depth = depthOf(node.id);
    const indexInRow = countPerDepth.get(depth) ?? 0;
    countPerDepth.set(depth, indexInRow + 1);
    positions.set(node.id, { x: indexInRow * 250, y: depth * 180 });
  }

  return positions;
}

export default function RoadmapPage(): JSX.Element {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [nodes, setNodes] = useState<RoadmapNode[]>([]);
  const [selected, setSelected] = useState<RoadmapNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    api
      .get<{ nodes: RoadmapNode[] }>("/roadmap")
      .then((res) => setNodes(res.data.nodes))
      .catch(() => setError("Failed to load your roadmap."))
      .finally(() => setLoading(false));
  }, [authLoading]);

  const { flowNodes, flowEdges } = useMemo(() => {
    const positions = layoutNodes(nodes);
    const flowNodes: Node<SkillNodeData>[] = nodes.map((node) => ({
      id: node.id,
      type: "skill",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node },
      draggable: false,
    }));

    const flowEdges: Edge<CurvedEdgeData>[] = nodes.flatMap((node) =>
      node.prerequisites.map((prereqId) => ({
        id: `${prereqId}->${node.id}`,
        source: prereqId,
        target: node.id,
        type: "curved",
        data: { active: node.status === "UNLOCKED" },
      })),
    );

    return { flowNodes, flowEdges };
  }, [nodes]);

  // Any node is selectable regardless of status — LOCKED/UNLOCKED is a
  // recommended path (SkillNode still shows the badge/lock icon), not an
  // access gate. It used to be: clicking a LOCKED node was silently
  // ignored, so `selected` kept pointing at whatever was picked before —
  // which is what made "start a different chapter" look like it was
  // redirecting back to the old one.
  const handleNodeClick = useCallback((_: unknown, flowNode: Node<SkillNodeData>) => {
    setSelected(flowNode.data.node);
  }, []);

  if (authLoading || loading) {
    return <div className="flex h-[calc(100vh-64px)] items-center justify-center text-on-surface-variant font-label-lg">Loading your roadmap...</div>;
  }

  if (error) {
    return <div className="flex h-[calc(100vh-64px)] items-center justify-center text-error font-label-lg">{error}</div>;
  }

  return (
    <>
      {/* Animated Spatial Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 bg-background/50">
        <motion.div 
          animate={{ x: [0, -60, 0], y: [0, 40, 0], scale: [1, 1.1, 1] }} 
          transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
          className="absolute top-[10%] left-[10%] w-[35vw] h-[35vw] rounded-full bg-primary/15 blur-[120px]" 
        />
        <motion.div 
          animate={{ x: [0, 50, 0], y: [0, -60, 0], scale: [1, 1.2, 1] }} 
          transition={{ duration: 22, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-[10%] right-[10%] w-[40vw] h-[40vw] rounded-full bg-tertiary/15 blur-[120px]" 
        />
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at center, currentColor 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      </div>

      <main className="flex gap-4 lg:gap-6 h-[calc(100dvh-104px)] w-full max-w-[1600px] mx-auto px-2 sm:px-4 lg:px-6 pb-6 relative z-10">
      {/* Canvas Area */}
      <div className="flex-1 relative h-full bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] overflow-hidden">
        <div className="absolute left-6 top-6 z-10 rounded-2xl bg-surface-container-lowest/90 backdrop-blur-md shadow-sm border border-outline-variant/30 px-5 py-4">
          <h1 className="flex items-center gap-2 text-headline-sm font-semibold text-on-surface">
            <Sparkles className="w-5 h-5 text-primary" />
            {user ? `Class ${user.classLevel} Roadmap` : "Curriculum Tree"}
          </h1>
          <p className="text-body-sm text-on-surface-variant mt-1">Unlock nodes to master topics sequentially.</p>
        </div>

        {nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-on-surface-variant font-label-md">
            No curriculum nodes yet for your class level. Check back soon!
          </div>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={handleNodeClick}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--color-outline-variant)" gap={24} size={1.5} />
            <Controls showInteractive={false} className="bg-surface-container-lowest border-outline-variant/30 text-on-surface-variant" />
          </ReactFlow>
        )}
      </div>

      {/* Sidebar Area */}
      <aside className="hidden lg:flex w-[380px] shrink-0 bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] flex-col overflow-hidden z-20">
        <div className="p-6 flex flex-col gap-6 overflow-y-auto h-full">
          
          {/* Active Node Details (Replaces Sheet) */}
          {selected ? (
            <div className="bg-primary/5 rounded-3xl p-5 border border-primary/20">
              <div className="flex items-center gap-2 mb-3 text-primary">
                <BookOpenText className="w-5 h-5" />
                <span className="font-label-md font-semibold tracking-wider uppercase">Selected Topic</span>
              </div>
              <h3 className="font-headline-sm text-on-surface mb-2">{selected.title}</h3>
              <p className="font-body-sm text-on-surface-variant mb-4">{selected.description}</p>
              
              <div className="flex flex-col gap-2 bg-surface-container-lowest p-3 rounded-xl mb-4 border border-outline-variant/20">
                <div className="flex justify-between font-label-sm">
                  <span className="text-on-surface-variant">Subject</span>
                  <span className="text-on-surface font-semibold">{selected.subject}</span>
                </div>
                <div className="flex justify-between font-label-sm">
                  <span className="text-on-surface-variant">Chapter</span>
                  <span className="text-on-surface font-semibold">{selected.chapterNumber}</span>
                </div>
                <div className="flex justify-between font-label-sm">
                  <span className="text-on-surface-variant">Reward</span>
                  <span className="text-amber font-semibold">+{selected.totalXp} XP</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={() => router.push(`/chat?subject=${encodeURIComponent(selected.subject)}&chapter=${selected.chapterNumber}&nodeId=${selected.id}&guided=1`)}
                  className="w-full py-2.5 px-4 rounded-full bg-primary hover:bg-primary-container text-on-primary font-label-md shadow-md flex items-center justify-center gap-2 transition-transform active:scale-95"
                >
                  <PlayCircle className="w-4 h-4" /> Start Lesson
                </button>
                <button
                  onClick={() => router.push(`/chat?subject=${encodeURIComponent(selected.subject)}&chapter=${selected.chapterNumber}&nodeId=${selected.id}`)}
                  className="w-full py-2.5 px-4 rounded-full bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md flex items-center justify-center transition-colors"
                >
                  Ask Question
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-surface-container-low rounded-3xl p-6 text-center border border-outline-variant/20 border-dashed">
              <Sparkles className="w-8 h-8 text-on-surface-variant mx-auto mb-3 opacity-50" />
              <p className="font-label-md text-on-surface-variant">Select a topic node from the roadmap to view details and start learning.</p>
            </div>
          )}
        </div>
      </aside>
      </main>
    </>
  );
}
