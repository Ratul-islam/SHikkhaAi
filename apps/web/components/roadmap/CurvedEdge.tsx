import { BaseEdge, getBezierPath, type EdgeProps } from "reactflow";

export interface CurvedEdgeData {
  /** true when the edge leads into a currently-unlocked node — draws an animated, brighter path. */
  active: boolean;
}

export default function CurvedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<CurvedEdgeData>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <BaseEdge
      path={path}
      style={
        data?.active
          ? { stroke: "var(--color-primary)", strokeWidth: 2, strokeDasharray: 6, animation: "dash-flow 1.2s linear infinite" }
          : { stroke: "var(--color-outline-variant)", strokeWidth: 1.5 }
      }
    />
  );
}
