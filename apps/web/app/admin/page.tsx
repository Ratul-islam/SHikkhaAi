"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../lib/api";
import {
  CLASS_LEVELS,
  EmptyState,
  FIELD_CLASS,
  JobStatusPill,
  PageHeader,
  Panel,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  formatNumber,
  isJobBusy,
} from "../../components/admin/admin-ui";
import type { AnalyticsResponse, ChapterView, IngestionJobSummary } from "../../lib/types";

export default function AdminOverviewPage(): JSX.Element {
  const [classLevel, setClassLevel] = useState("");
  const [subject, setSubject] = useState("");
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [jobs, setJobs] = useState<IngestionJobSummary[]>([]);
  const [chapters, setChapters] = useState<ChapterView[]>([]);

  useEffect(() => {
    api.get<{ jobs: IngestionJobSummary[] }>("/admin/ingestion/jobs").then((res) => setJobs(res.data.jobs)).catch(() => {});
    api.get<{ chapters: ChapterView[] }>("/admin/ingestion/chapters").then((res) => setChapters(res.data.chapters)).catch(() => {});
  }, []);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (classLevel) params.classLevel = classLevel;
    if (subject.trim()) params.subject = subject.trim();
    api
      .get<AnalyticsResponse>("/admin/analytics", { params })
      .then((res) => setAnalytics(res.data))
      .catch(() => {});
  }, [classLevel, subject]);

  const waitingJobs = jobs.filter((j) => j.status === "READY_FOR_REVIEW" || j.status === "FAILED");
  const stats = [
    { label: "Students", value: analytics ? formatNumber(analytics.studentCount) : "…" },
    { label: "Published chapters", value: formatNumber(chapters.length) },
    { label: "Textbook passages", value: analytics ? formatNumber(analytics.documentChunkCount) : "…" },
    { label: "Books being read", value: formatNumber(jobs.filter((j) => isJobBusy(j.status)).length) },
  ];
  const attention = waitingJobs.length + (analytics?.uncoveredChapters.length ?? 0);

  return (
    <>
      <PageHeader
        title="Overview"
        description="How students are doing, and what's waiting on you."
        actions={
          <>
            <select
              value={classLevel}
              onChange={(e) => setClassLevel(e.target.value)}
              aria-label="Filter by class"
              className={`${FIELD_CLASS} w-36`}
            >
              <option value="">All classes</option>
              {CLASS_LEVELS.map((l) => (
                <option key={l} value={l}>
                  Class {l}
                </option>
              ))}
            </select>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Filter by subject"
              aria-label="Filter by subject"
              className={`${FIELD_CLASS} w-44`}
            />
          </>
        }
      />

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-outline-variant/70 bg-outline-variant/50 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface-container-lowest px-5 py-4">
            <dt className="text-sm text-on-surface-variant">{s.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-on-surface">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title="Waiting on you" description={attention > 0 ? `${attention} ${attention === 1 ? "item" : "items"}` : undefined}>
          {attention === 0 ? (
            <EmptyState title="Nothing waiting on you">Books you upload show up here when they're ready to review.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-outline-variant/40">
              {waitingJobs.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0">
                  <div className="min-w-0">
                    <Link href={`/admin/content/jobs/${job.id}`} className="block truncate text-sm font-medium text-on-surface hover:text-primary">
                      {job.fileName}
                    </Link>
                    <p className="text-xs text-on-surface-variant">
                      Class {job.classLevel} {job.subject}
                    </p>
                  </div>
                  <JobStatusPill status={job.status} />
                </li>
              ))}
              {analytics?.uncoveredChapters.map((c) => (
                <li key={`${c.classLevel}-${c.subject}-${c.chapter}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0">
                  <p className="text-sm text-on-surface">
                    Class {c.classLevel} {c.subject}, chapter {c.chapter} has no levels yet
                  </p>
                  <Link
                    href={`/admin/levels?classLevel=${c.classLevel}&subject=${encodeURIComponent(c.subject)}&chapter=${c.chapter}`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Generate levels
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Weakest levels" description="Lowest average mastery score first." flush>
          {!analytics || analytics.weakTopics.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No mastery scores yet">Scores appear once students pass or fail a mastery check.</EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD_CLASS}>
                    <th className="px-5 py-2.5 font-medium">Level</th>
                    <th className="px-3 py-2.5 font-medium">Class</th>
                    <th className="px-3 py-2.5 text-right font-medium">Attempts</th>
                    <th className="px-5 py-2.5 text-right font-medium">Average</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.weakTopics.map((t) => (
                    <tr key={t.nodeId} className={TABLE_ROW_CLASS}>
                      <td className="px-5 py-2.5 text-on-surface">
                        {t.title}
                        <span className="block text-xs text-on-surface-variant">{t.subject}</span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-on-surface-variant">{t.classLevel}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-on-surface-variant">{t.attempts}</td>
                      <td className="px-5 py-2.5 text-right font-medium tabular-nums text-on-surface">{t.averageScore.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel className="mt-6" title="Mastery pass rate by level" flush>
        {!analytics || analytics.nodePassRates.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No submitted mastery checks yet" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={TABLE_HEAD_CLASS}>
                  <th className="px-5 py-2.5 font-medium">Level</th>
                  <th className="px-3 py-2.5 font-medium">Chapter</th>
                  <th className="px-3 py-2.5 text-right font-medium">Attempts</th>
                  <th className="w-56 px-5 py-2.5 font-medium">Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {analytics.nodePassRates.map((n) => (
                  <tr key={n.nodeId} className={TABLE_ROW_CLASS}>
                    <td className="px-5 py-2.5 text-on-surface">
                      {n.title}
                      <span className="block text-xs text-on-surface-variant">
                        Class {n.classLevel} {n.subject}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-on-surface-variant">{n.chapterNumber}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-on-surface-variant">{n.attempts}</td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-container-high">
                          <div
                            className={n.passRate < 50 ? "h-full rounded-full bg-error" : "h-full rounded-full bg-primary"}
                            style={{ width: `${n.passRate}%` }}
                          />
                        </div>
                        <span className={`w-10 text-right font-medium tabular-nums ${n.passRate < 50 ? "text-error" : "text-on-surface"}`}>
                          {n.passRate}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
