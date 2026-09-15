"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../../lib/api";
import {
  EmptyState,
  FIELD_CLASS,
  Notice,
  PageHeader,
  Panel,
  errorMessage,
  formatNumber,
} from "../../../components/admin/admin-ui";
import type { StudentDrilldownResponse, StudentListItem } from "../../../lib/types";

function Meter({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-on-surface-variant">{label}</span>
        <span className="tabular-nums text-on-surface">{value.toFixed(2)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-container-high">
        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

export default function AdminStudentsPage(): JSX.Element {
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<StudentDrilldownResponse | null>(null);
  const [loadingDrilldown, setLoadingDrilldown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ students: StudentListItem[] }>("/admin/analytics/students")
      .then((res) => setStudents(res.data.students))
      .catch((err) => setError(errorMessage(err, "Couldn't load students.")));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoadingDrilldown(true);
    api
      .get<StudentDrilldownResponse>(`/admin/analytics/students/${selectedId}`)
      .then((res) => setDrilldown(res.data))
      .catch((err) => setError(errorMessage(err, "Couldn't load that student.")))
      .finally(() => setLoadingDrilldown(false));
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? students.filter((s) => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q)) : students;
  }, [students, query]);

  return (
    <>
      <PageHeader title="Students" description="Progress and how the tutor has adapted to each student." />
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Panel
          title={`${formatNumber(students.length)} students`}
          actions={
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              aria-label="Search students"
              className={`${FIELD_CLASS} w-64 max-w-full`}
            />
          }
          flush
        >
          {filtered.length === 0 ? (
            <div className="p-5">
              <EmptyState title={students.length === 0 ? "No students yet" : "No students match that search"} />
            </div>
          ) : (
            <ul className="divide-y divide-outline-variant/40">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    aria-pressed={selectedId === s.id}
                    className={cn(
                      "flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none",
                      selectedId === s.id && "bg-primary-fixed/25",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-on-surface">{s.name}</p>
                      <p className="truncate text-xs text-on-surface-variant">{s.email}</p>
                    </div>
                    <span className="text-sm tabular-nums text-on-surface-variant">Class {s.classLevel}</span>
                    <span className="w-20 text-right text-sm tabular-nums text-on-surface">{formatNumber(s.xp)} XP</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="xl:sticky xl:top-24 xl:self-start">
          <Panel title={drilldown && selectedId ? drilldown.name : "Student details"}>
            {!selectedId ? (
              <EmptyState title="Select a student">Their progress, mastery checks and learning profile show here.</EmptyState>
            ) : loadingDrilldown || !drilldown ? (
              <p className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 className="size-4 animate-spin" />
                Loading
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                <dl className="grid grid-cols-3 gap-3 text-sm">
                  {[
                    ["Class", String(drilldown.classLevel)],
                    ["XP", formatNumber(drilldown.xp)],
                    ["Streak", `${drilldown.streakDays} days`],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-on-surface-variant">{label}</dt>
                      <dd className="text-base font-semibold tabular-nums text-on-surface">{value}</dd>
                    </div>
                  ))}
                </dl>

                <section className="flex flex-col gap-2.5">
                  <h3 className="text-sm font-semibold text-on-surface">Learning profile</h3>
                  <Meter label="Prefers visuals" value={drilldown.profile.visualPreferenceScore} />
                  <Meter label="Wants formal working" value={drilldown.profile.mathRigidityScore} />
                  <Meter label="Patience for long answers" value={drilldown.profile.patienceLevel} />
                  {drilldown.profile.weakTopics.length > 0 && (
                    <p className="text-sm text-on-surface-variant">Struggles with {drilldown.profile.weakTopics.join(", ")}</p>
                  )}
                </section>

                <section>
                  <h3 className="text-sm font-semibold text-on-surface">Levels ({drilldown.progress.length})</h3>
                  {drilldown.progress.length === 0 ? (
                    <p className="mt-1 text-sm text-on-surface-variant">No levels started.</p>
                  ) : (
                    <ul className="mt-1.5 divide-y divide-outline-variant/40 text-sm">
                      {drilldown.progress.slice(0, 12).map((p) => (
                        <li key={p.nodeId} className="flex justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-on-surface">{p.nodeTitle}</span>
                          <span className="shrink-0 tabular-nums text-on-surface-variant">
                            {p.status === "COMPLETED" ? `${p.score}%` : p.status.toLowerCase()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="text-sm font-semibold text-on-surface">Mastery checks ({drilldown.masteryHistory.length})</h3>
                  {drilldown.masteryHistory.length === 0 ? (
                    <p className="mt-1 text-sm text-on-surface-variant">No mastery checks taken.</p>
                  ) : (
                    <ul className="mt-1.5 divide-y divide-outline-variant/40 text-sm">
                      {drilldown.masteryHistory.slice(0, 12).map((a) => (
                        <li key={a.attemptId} className="flex justify-between gap-3 py-1.5">
                          <span className="min-w-0 truncate text-on-surface">{a.nodeTitle}</span>
                          <span
                            className={cn(
                              "shrink-0 tabular-nums",
                              a.passed === true && "text-primary",
                              a.passed === false && "text-error",
                              a.passed === null && "text-on-surface-variant",
                            )}
                          >
                            {a.score === null ? "In progress" : `${a.score}% ${a.passed ? "passed" : "failed"}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
