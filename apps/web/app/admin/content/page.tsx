"use client";

import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Trash2, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { api } from "../../../lib/api";
import {
  CLASS_LEVELS,
  EmptyState,
  FIELD_CLASS,
  Field,
  JobStatusPill,
  Notice,
  PageHeader,
  Panel,
  ProgressBar,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  errorMessage,
  formatDateTime,
  formatNumber,
  formatUsd,
  isJobBusy,
} from "../../../components/admin/admin-ui";
import type { ChapterView, CreateIngestionJobResponse, IngestionJobSummary } from "../../../lib/types";

const MAX_BYTES = 100 * 1024 * 1024;

function UploadBookPanel({ subjects }: { subjects: string[] }): JSX.Element {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [classLevel, setClassLevel] = useState(9);
  const [subject, setSubject] = useState("");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pick(candidate: File | undefined): void {
    setError(null);
    if (!candidate) return;
    if (candidate.type !== "application/pdf") return setError("Choose a PDF file.");
    if (candidate.size > MAX_BYTES) return setError("This PDF is larger than 100 MB. Compress it and try again.");
    setFile(candidate);
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!file || !subject.trim()) return;
    setError(null);
    setUploadPct(0);

    const form = new FormData();
    // Fields before the file part as well as after would both work server-side; the file goes first by convention.
    form.append("file", file);
    form.append("classLevel", String(classLevel));
    form.append("subject", subject.trim());

    try {
      // No explicit Content-Type: the browser must set the multipart boundary itself.
      const res = await api.post<CreateIngestionJobResponse>("/admin/ingestion/jobs", form, {
        onUploadProgress: (event) => setUploadPct(event.total ? Math.round((event.loaded / event.total) * 100) : null),
      });
      router.push(`/admin/content/jobs/${res.data.job.id}`);
    } catch (err) {
      setError(errorMessage(err, "The upload didn't go through. Check your connection and try again."));
      setUploadPct(null);
    }
  }

  const uploading = uploadPct !== null;

  return (
    <Panel
      title="Upload a book"
      description="Upload the whole textbook as one PDF. Every page is read, then chapters and topics are found for you to check before students see anything."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
            dragging ? "border-primary bg-primary-fixed/20" : "border-outline-variant bg-surface-container-low/50",
          )}
        >
          {file ? (
            <>
              <FileText className="size-6 text-primary" />
              <p className="max-w-full truncate text-sm font-medium text-on-surface">{file.name}</p>
              <p className="text-xs text-on-surface-variant">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            </>
          ) : (
            <>
              <UploadCloud className="size-6 text-on-surface-variant" />
              <p className="text-sm text-on-surface">Drop the PDF here</p>
            </>
          )}
          <label className="cursor-pointer rounded text-sm font-medium text-primary hover:underline focus-within:ring-2 focus-within:ring-primary/40">
            {file ? "Choose a different file" : "or choose a file"}
            <input type="file" accept="application/pdf" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
          <Field label="Class">
            <select value={classLevel} onChange={(e) => setClassLevel(Number(e.target.value))} className={FIELD_CLASS}>
              {CLASS_LEVELS.map((l) => (
                <option key={l} value={l}>
                  Class {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject">
            <input
              required
              list="known-subjects"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Physics"
              className={FIELD_CLASS}
            />
            <datalist id="known-subjects">
              {subjects.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        {uploading && (
          <div className="flex flex-col gap-1.5">
            <ProgressBar value={uploadPct ?? 0} label="Upload progress" />
            <p className="text-xs text-on-surface-variant">Uploading {uploadPct ?? 0}%</p>
          </div>
        )}

        <Button type="submit" size="lg" disabled={!file || !subject.trim() || uploading} className="self-start px-4">
          {uploading ? <Loader2 className="animate-spin" /> : <UploadCloud />}
          {uploading ? "Uploading" : "Upload and read"}
        </Button>
      </form>
    </Panel>
  );
}

export default function AdminBooksPage(): JSX.Element {
  const [chapters, setChapters] = useState<ChapterView[]>([]);
  const [jobs, setJobs] = useState<IngestionJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(() => {
    api.get<{ jobs: IngestionJobSummary[] }>("/admin/ingestion/jobs").then((res) => setJobs(res.data.jobs)).catch(() => {});
  }, []);

  const loadChapters = useCallback(() => {
    return api
      .get<{ chapters: ChapterView[] }>("/admin/ingestion/chapters")
      .then((res) => setChapters(res.data.chapters))
      .catch((err) => setError(errorMessage(err, "Couldn't load the library.")));
  }, []);

  useEffect(() => {
    loadJobs();
    loadChapters().finally(() => setLoading(false));
  }, [loadJobs, loadChapters]);

  const anyBusy = jobs.some((j) => isJobBusy(j.status));
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(loadJobs, 5000);
    return () => clearInterval(timer);
  }, [anyBusy, loadJobs]);

  const books = useMemo(() => {
    const byBook = new Map<string, { classLevel: number; subject: string; chapters: ChapterView[] }>();
    for (const c of chapters) {
      const key = `${c.classLevel}::${c.subject}`;
      const book = byBook.get(key);
      if (book) book.chapters.push(c);
      else byBook.set(key, { classLevel: c.classLevel, subject: c.subject, chapters: [c] });
    }
    return [...byBook.values()];
  }, [chapters]);

  const subjects = useMemo(() => [...new Set(chapters.map((c) => c.subject))], [chapters]);

  async function deleteChapter(chapter: ChapterView): Promise<void> {
    const ok = window.confirm(
      `Delete chapter ${chapter.number}, "${chapter.title}"? Students will no longer be able to ask about it. Its levels are kept.`,
    );
    if (!ok) return;
    try {
      await api.delete(`/admin/ingestion/chapters/${chapter.id}`);
      await loadChapters();
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete that chapter."));
    }
  }

  return (
    <>
      <PageHeader title="Books" description="Textbooks students can learn from, split into chapters and topics." />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {error && <Notice tone="error">{error}</Notice>}

          <Panel title="Library" flush>
            {loading ? (
              <p className="flex items-center gap-2 p-5 text-sm text-on-surface-variant">
                <Loader2 className="size-4 animate-spin" />
                Loading
              </p>
            ) : books.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No published books yet">Upload a textbook, check its chapters, and publish it.</EmptyState>
              </div>
            ) : (
              books.map((book) => {
                const chunks = book.chapters.reduce((sum, c) => sum + c.chunkCount, 0);
                const topics = book.chapters.reduce((sum, c) => sum + c.topics.length, 0);
                return (
                  <div key={`${book.classLevel}-${book.subject}`} className="border-b border-outline-variant/50 last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 bg-surface-container-low/60 px-5 py-3">
                      <h3 className="text-sm font-semibold text-on-surface">
                        Class {book.classLevel} {book.subject}
                      </h3>
                      <p className="text-xs tabular-nums text-on-surface-variant">
                        {book.chapters.length} chapters, {topics} topics, {formatNumber(chunks)} passages
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className={TABLE_HEAD_CLASS}>
                            <th className="w-16 px-5 py-2 font-medium">Chapter</th>
                            <th className="px-3 py-2 font-medium">Title</th>
                            <th className="px-3 py-2 text-right font-medium">Topics</th>
                            <th className="px-3 py-2 text-right font-medium">Pages</th>
                            <th className="px-3 py-2 text-right font-medium">Passages</th>
                            <th className="w-12 px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {book.chapters.map((c) => (
                            <tr key={c.id} className={TABLE_ROW_CLASS}>
                              <td className="px-5 py-2.5 tabular-nums text-on-surface-variant">{c.number}</td>
                              <td className="px-3 py-2.5 font-medium text-on-surface">{c.title}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-on-surface-variant">{c.topics.length}</td>
                              <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-on-surface-variant">
                                {c.startPage}–{c.endPage}
                              </td>
                              <td className={cn("px-3 py-2.5 text-right tabular-nums", c.chunkCount === 0 ? "text-error" : "text-on-surface-variant")}>
                                {formatNumber(c.chunkCount)}
                              </td>
                              <td className="px-3 py-1.5 text-right">
                                <button
                                  type="button"
                                  onClick={() => void deleteChapter(c)}
                                  aria-label={`Delete chapter ${c.number}`}
                                  className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-variant hover:bg-error-container/60 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                >
                                  <Trash2 className="size-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })
            )}
          </Panel>

          <Panel title="Uploads" description="Books being read, waiting for review, or already published." flush>
            {jobs.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No uploads yet" />
              </div>
            ) : (
              <ul className="divide-y divide-outline-variant/40">
                {jobs.map((job) => {
                  const pct = job.pageCount > 0 ? ((job.pagesDone + job.pagesFailed) / job.pageCount) * 100 : 0;
                  return (
                    <li key={job.id}>
                      <Link
                        href={`/admin/content/jobs/${job.id}`}
                        className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 hover:bg-surface-container-low focus-visible:bg-surface-container-low focus-visible:outline-none"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-on-surface">{job.fileName}</p>
                          <p className="text-xs tabular-nums text-on-surface-variant">
                            Class {job.classLevel} {job.subject}, {job.pageCount} pages, uploaded {formatDateTime(job.createdAt)}
                          </p>
                          {job.status === "READING" && (
                            <div className="mt-2 max-w-sm">
                              <ProgressBar value={pct} label={`Reading ${job.fileName}`} />
                            </div>
                          )}
                        </div>
                        <span className="text-xs tabular-nums text-on-surface-variant">{formatUsd(job.costUsd)}</span>
                        <JobStatusPill status={job.status} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="xl:sticky xl:top-24 xl:self-start">
          <UploadBookPanel subjects={subjects} />
        </div>
      </div>
    </>
  );
}
