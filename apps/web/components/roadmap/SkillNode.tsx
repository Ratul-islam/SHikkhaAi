"use client";

import { Handle, Position, type NodeProps } from "reactflow";
import { Lock, Sparkles, Star } from "lucide-react";
import type { RoadmapNode } from "../../lib/types";
import { cn } from "@/lib/utils";

export interface SkillNodeData {
  node: RoadmapNode;
}

export default function SkillNode({ data }: NodeProps<SkillNodeData>): JSX.Element {
  const { node } = data;

  return (
    <div
      className={cn(
        "relative flex w-48 flex-col items-center gap-1.5 rounded-2xl px-4 py-5 text-center transition-all duration-300",
        node.status === "LOCKED" &&
          "cursor-not-allowed border-2 border-dashed border-outline-variant/40 bg-surface-container-low text-on-surface-variant opacity-80",
        node.status === "UNLOCKED" &&
          "bg-surface-container-lowest animate-glow-ring cursor-pointer border-transparent text-primary hover:scale-105 shadow-[0_8px_20px_rgba(0,104,95,0.12)]",
        node.status === "COMPLETED" &&
          "cursor-pointer border-2 border-secondary bg-surface-container-lowest text-on-surface hover:scale-105 shadow-sm",
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-outline-variant !border-none !w-3 !h-3" />

      {node.status === "COMPLETED" && (
        <span className="absolute -right-3 -top-3 flex w-8 h-8 items-center justify-center rounded-full bg-secondary text-on-secondary shadow-md z-10">
          <Star className="w-4 h-4" fill="currentColor" />
        </span>
      )}
      
      {node.status === "LOCKED" && <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center mb-1"><Lock className="w-4 h-4 text-on-surface-variant/70" /></div>}
      {node.status === "UNLOCKED" && <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mb-1"><Sparkles className="w-4 h-4 text-primary" /></div>}

      <span
        className={cn(
          "rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
          node.status === "LOCKED" ? "bg-surface-container text-on-surface-variant" : "bg-primary-container/20 text-primary",
        )}
      >
        {node.subject}
      </span>
      
      <span className="font-headline-sm text-sm leading-tight mt-1">{node.title}</span>
      
      <span className={cn("font-label-sm text-xs mt-1", node.status === "LOCKED" ? "text-on-surface-variant/60" : "text-on-surface-variant")}>
        Ch {node.chapterNumber} • {node.totalXp} XP
      </span>

      <Handle type="source" position={Position.Bottom} className="!bg-outline-variant !border-none !w-3 !h-3" />
    </div>
  );
}
