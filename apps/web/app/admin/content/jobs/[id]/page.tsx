"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, RefreshCw, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api } from "../../../../../lib/api";
import PageMap from "../../../../../components/admin/PageMap";
import StructureEditor from "../../../../../components/admin/StructureEditor";
import {
  EmptyState,
  JobStatusPill,
  Notice,
  PageHeader,
  Panel,
  ProgressBar,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  errorMessage,
  formatNumber,
  formatUsd,
  isJobBusy,
} from "../../../../../components/admin/admin-ui";
import type { DraftChapter, IngestionJobDetailResponse, IngestionPageView } from "../../../../../lib/types";

const POLL_MS = 3000;

const PAGE_KIND_LABEL: Record<string, string> = {
  chapter_opening: "Chapter opening",
  content: "Content",
  exercises: "Exercises",
  front_matter: "Front matter",
  blank: "Blank",
  failed: "Couldn't read",
};

interface PreviewState {
  page: number;
  loading: boolean;
  view: IngestionPageView | null;
  imageUrl: string | null;
  error: string | null;
}

export default function IngestionJobPage({ params }: { params: { id: string } }): JSX.Element {
  const { id } = params;
  const router = useRouter();
  const [detail, setDetail] = useState<IngestionJobDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<DraftChapter[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const requestedPage = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<IngestionJobDetailResponse>(`/admin/ingestion/jobs/${id}`);
      setDetail(res.data);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load this upload."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const status = detail?.job.status;
  const busy = status ? isJobBusy(status) : false;

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  // The editor starts from the detected structure once reading is done, and
  // is never overwritten by later polls — the admin's edits win.
  useEffect(() => {
    if (chapters === null && detail?.draft && (status === "READY_FOR_REVIEW" || status === "COMMITTED")) {
      setChapters(detail.draft.chapters);
    }
  }, [chapters, detail, status]);

  useEffect(() => {
    const url = preview?.imageUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview?.imageUrl]);

  async function openPage(page: number): Promise<void> {
    requestedPage.current = page;
    setPreview({ page, loading: true, view: null, imageUrl: null, error: null });
    const [viewRes, imageRes] = await Promise.allSettled([
      api.get<IngestionPageView>(`/admin/ingestion/jobs/${id}/pages/${page}`),
      detail?.pdfAvailable
        ? api.get<Blob>(`/admin/ingestion/jobs/${id}/pages/${page}/image`, { responseType: "blob" })
        : Promise.reject(new Error("no pdf")),
    ]);
    if (requestedPage.current !== page) return;
    setPreview({
      page,
      loading: false,
      view: viewRes.status === "fulfilled" ? viewRes.value.data : null,
      imageUrl: imageRes.status === "fulfilled" ? URL.createObjectURL(imageRes.value.data) : null,
      error: viewRes.status === "rejected" ? "This page hasn't been read yet." : null,
    });
  }

  async function publish(): Promise<void> {
    if (!chapters) return;
    setActing(true);
    setActionError(null);
    try {
      await api.post(`/admin/ingestion/jobs/${id}/commit`, { chapters });
      setDirty(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't publish. Check the chapters and try again."));
    } finally {
      setActing(false);
    }
  }

  async function retryFailed(): Promise<void> {
    setActing(true);
    setActionError(null);
    try {
      await api.post(`/admin/ingestion/jobs/${id}/retry-failed`);
      setChapters(null);
      await load();
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't retry those pages."));
    } finally {
      setActing(false);
    }
  }

  async function deleteUpload(): Promise<void> {
    const published = (detail?.committedChapters.length ?? 0) > 0;
    const ok = window.confirm(
      published
        ? "Delete this upload? Its published chapters stay available to students."
        : "Delete this upload and everything read from it?",
    );
    if (!ok) return;
    try {
      await api.delete(`/admin/ingestion/jobs/${id}`);
      router.push("/admin/content");
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't delete this upload."));
    }
  }

  if (!detail) {
    return (
      <>
        <PageHeader title="Upload" backHref="/admin/content" backLabel="Books" />
        {loadError ? (
          <Notice tone="error">{loadError}</Notice>
        ) : (
          <p className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Loader2 className="size-4 animate-spin" />
            Loading
          </p>
        )}
      </>
    );
  }

  const { job } = detail;
  const read = job.pagesDone + job.pagesFailed;
  const mapChapters = chapters ?? detail.draft?.chapters ?? [];
  const canEdit = status === "READY_FOR_REVIEW" || status === "COMMITTED";
  const stats = [
    { label: "Pages read", value: `${formatNumber(job.pagesDone)} of ${formatNumber(job.pageCount)}` },
    { label: "Couldn't read", value: formatNumber(job.pagesFailed) },
    { label: "Reading cost", value: formatUsd(job.costUsd) },
    { label: "Passages published", value: formatNumber(job.chunksInserted) },
  ];

  return (
    <>
      <PageHeader
        title={job.fileName}
        description={`Class ${job.classLevel} ${job.subject}`}
        backHref="/admin/content"
        backLabel="Books"
        actions={
          <>
            <JobStatusPill status={job.status} />
            {!busy && (
              <Button variant="ghost" size="sm" onClick={() => void deleteUpload()}>
                <Trash2 />
                Delete upload
              </Button>
            )}
          </>
        }
      />

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-outline-variant/70 bg-outline-variant/50 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface-container-lowest px-5 py-3.5">
            <dt className="text-sm text-on-surface-variant">{s.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-on-surface">{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 flex flex-col gap-6">
        {job.status === "READING" || job.status === "QUEUED" ? (
          <Notice tone="info">
            <p>Reading page {Math.min(read + 1, job.pageCount)} of {job.pageCount}. You can leave this page; reading continues.</p>
            <div className="mt-2">
              <ProgressBar value={job.pageCount ? (read / job.pageCount) * 100 : 0} label="Reading progress" />
            </div>
          </Notice>
        ) : null}
        {job.status === "COMMITTING" && <Notice tone="info">Publishing chapters. This takes a minute or two.</Notice>}
        {job.error && <Notice tone={job.status === "FAILED" ? "error" : "warning"}>{job.error}</Notice>}
        {actionError && <Notice tone="error">{actionError}</Notice>}

        <Panel
          title="Pages"
          description="Every page of the book, grouped by chapter. Select a page to see what was read from it."
          actions={
            detail.failedPages.length > 0 && detail.pdfAvailable && !busy ? (
              <Button variant="outline" size="sm" disabled={acting} onClick={() => void retryFailed()}>
                <RefreshCw />
                Retry {detail.failedPages.length} {detail.failedPages.length === 1 ? "page" : "pages"}
              </Button>
            ) : undefined
          }
        >
          <PageMap
            pageCount={job.pageCount}
            pageKinds={detail.pageKinds}
            chapters={mapChapters}
            selectedPage={preview?.page ?? null}
            onOpenPage={(page) => void openPage(page)}
          />
        </Panel>

        {canEdit && chapters && (
          <Panel
            title="Chapters and topics"
            description={
              status === "COMMITTED"
                ? "Published. Students can pick these chapters in the tutor. Publishing again replaces them."
                : "Found in the book. Check titles and page ranges, then publish. Students see nothing until you do."
            }
            actions={
              <>
                {dirty && detail.draft && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setChapters(detail.draft!.chapters);
                      setDirty(false);
                    }}
                  >
                    <RotateCcw />
                    Undo my changes
                  </Button>
                )}
                <Button size="lg" className="px-4" disabled={acting || chapters.length === 0} onClick={() => void publish()}>
                  {acting ? <Loader2 className="animate-spin" /> : <Send />}
                  {status === "COMMITTED" ? "Publish again" : `Publish ${chapters.length} chapters`}
                </Button>
              </>
            }
          >
            {detail.draft && detail.draft.warnings.length > 0 && (
              <Notice tone="warning" className="mb-4">
                <p className="font-medium">Check these before publishing</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {detail.draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {chapters.length === 0 && (
              <div className="mb-3">
                <EmptyState title="No chapters found">Add the chapters yourself using the page map to find where each one starts.</EmptyState>
              </div>
            )}
            <StructureEditor
              chapters={chapters}
              pageCount={job.pageCount}
              disabled={acting}
              onChange={(next) => {
                setChapters(next);
                setDirty(true);
              }}
            />
          </Panel>
        )}

        {detail.committedChapters.length > 0 && (
          <Panel title="Published chapters" flush>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD_CLASS}>
                    <th className="w-16 px-5 py-2 font-medium">Chapter</th>
                    <th className="px-3 py-2 font-medium">Title</th>
                    <th className="px-3 py-2 text-right font-medium">Topics</th>
                    <th className="px-5 py-2 text-right font-medium">Passages</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.committedChapters.map((c) => (
                    <tr key={c.id} className={TABLE_ROW_CLASS}>
                      <td className="px-5 py-2.5 tabular-nums text-on-surface-variant">{c.number}</td>
                      <td className="px-3 py-2.5 font-medium text-on-surface">{c.title}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-on-surface-variant">{c.topicCount}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-on-surface-variant">{formatNumber(c.chunkCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>

      <Sheet open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-surface-container-lowest sm:max-w-xl">
          <SheetHeader className="border-b border-outline-variant/50">
            <SheetTitle>Page {preview?.page}</SheetTitle>
            {preview?.view && (
              <p className="text-sm text-on-surface-variant">
                {PAGE_KIND_LABEL[preview.view.pageKind] ?? preview.view.pageKind}
                {preview.view.printedPageNumber ? `, printed page ${preview.view.printedPageNumber}` : ""}
              </p>
            )}
          </SheetHeader>
          <div className="flex flex-col gap-4 p-4">
            {preview?.loading && (
              <p className="flex items-center gap-2 text-sm text-on-surface-variant">
                <Loader2 className="size-4 animate-spin" />
                Loading page
              </p>
            )}
            {preview?.error && <Notice tone="info">{preview.error}</Notice>}
            {preview?.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- a blob URL for an authenticated preview; next/image can't optimize it
              <img
                src={preview.imageUrl}
                alt={`Scan of page ${preview.page}`}
                className="w-full rounded-lg border border-outline-variant/60"
              />
            )}
            {preview?.view?.error && <Notice tone="error">{preview.view.error}</Notice>}
            {preview?.view && preview.view.headings.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-on-surface">Headings found</h3>
                <ul className="mt-1 space-y-0.5 text-sm text-on-surface-variant">
                  {preview.view.headings.map((h, i) => (
                    <li key={i}>
                      {h.code && <span className="tabular-nums text-on-surface">{h.code} </span>}
                      {h.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview?.view?.text && (
              <div>
                <h3 className="text-sm font-semibold text-on-surface">Text read from the page</h3>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 text-sm leading-relaxed text-on-surface">
                  {preview.view.text}
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
