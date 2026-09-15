"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "../../../lib/api";
import {
  EmptyState,
  FIELD_CLASS,
  Field,
  Notice,
  PageHeader,
  Panel,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  errorMessage,
} from "../../../components/admin/admin-ui";
import type {
  BulkCreateNodesResponse,
  ChapterView,
  CurriculumNode,
  DraftLevel,
  SynthesizeLevelsResponse,
} from "../../../lib/types";

function LevelsInner(): JSX.Element {
  const searchParams = useSearchParams();
  const [chapters, setChapters] = useState<ChapterView[]>([]);
  const [chapterId, setChapterId] = useState("");
  const [nodes, setNodes] = useState<CurriculumNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [draft, setDraft] = useState<DraftLevel[] | null>(null);
  const [existingCount, setExistingCount] = useState(0);

  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ title: "", description: "", totalXp: 100, prerequisites: [] as string[] });

  const loadNodes = useCallback(() => {
    return api
      .get<{ nodes: CurriculumNode[] }>("/admin/nodes")
      .then((res) => setNodes(res.data.nodes))
      .catch((err) => setError(errorMessage(err, "Couldn't load levels.")));
  }, []);

  useEffect(() => {
    Promise.all([
      api.get<{ chapters: ChapterView[] }>("/admin/ingestion/chapters").then((res) => setChapters(res.data.chapters)),
      loadNodes(),
    ])
      .catch((err) => setError(errorMessage(err, "Couldn't load chapters.")))
      .finally(() => setLoading(false));
  }, [loadNodes]);

  // Deep links from Overview ("chapter 3 has no levels yet") preselect that chapter.
  useEffect(() => {
    if (chapterId || chapters.length === 0) return;
    const classLevel = Number(searchParams.get("classLevel"));
    const subject = searchParams.get("subject");
    const number = Number(searchParams.get("chapter"));
    const match = chapters.find((c) => c.classLevel === classLevel && c.subject === subject && c.number === number);
    setChapterId((match ?? chapters[0]!).id);
  }, [chapters, chapterId, searchParams]);

  const chapter = chapters.find((c) => c.id === chapterId) ?? null;
  const chapterNodes = useMemo(
    () =>
      chapter
        ? nodes
            .filter((n) => n.classLevel === chapter.classLevel && n.subject === chapter.subject && n.chapterNumber === chapter.number)
            .sort((a, b) => a.orderIndex - b.orderIndex)
        : [],
    [nodes, chapter],
  );
  const nodeTitle = new Map(nodes.map((n) => [n.id, n.title]));

  function selectChapter(id: string): void {
    setChapterId(id);
    setDraft(null);
    setNotice(null);
    setError(null);
  }

  async function generate(): Promise<void> {
    if (!chapter) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<SynthesizeLevelsResponse>("/admin/synthesize-levels", {
        classLevel: chapter.classLevel,
        subject: chapter.subject,
        chapter: chapter.number,
      });
      setDraft(res.data.draft);
      setExistingCount(res.data.existingNodeCount);
    } catch (err) {
      setError(errorMessage(err, "Couldn't generate levels. Try again."));
    } finally {
      setGenerating(false);
    }
  }

  async function saveDraft(): Promise<void> {
    if (!chapter || !draft) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await api.post<BulkCreateNodesResponse>("/admin/nodes/bulk", {
        classLevel: chapter.classLevel,
        subject: chapter.subject,
        chapterNumber: chapter.number,
        levels: draft,
      });
      setNotice(`Saved ${res.data.created} levels.`);
      setDraft(null);
      await loadNodes();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save these levels."));
    } finally {
      setCommitting(false);
    }
  }

  function patchLevel(tempKey: string, patch: Partial<DraftLevel>): void {
    setDraft((d) => d?.map((l) => (l.tempKey === tempKey ? { ...l, ...patch } : l)) ?? null);
  }

  /** Dropping a level also drops references to it, so the saved graph stays sound. */
  function removeLevel(tempKey: string): void {
    setDraft(
      (d) =>
        d
          ?.filter((l) => l.tempKey !== tempKey)
          .map((l) => ({ ...l, prerequisiteKeys: l.prerequisiteKeys.filter((k) => k !== tempKey) })) ?? null,
    );
  }

  async function deleteNode(node: CurriculumNode): Promise<void> {
    if (!window.confirm(`Delete the level "${node.title}"?`)) return;
    setError(null);
    try {
      await api.delete(`/admin/nodes/${node.id}`);
      await loadNodes();
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete that level. Students may already have progress on it."));
    }
  }

  async function addManual(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!chapter) return;
    setError(null);
    try {
      await api.post("/admin/nodes", {
        classLevel: chapter.classLevel,
        subject: chapter.subject,
        chapterNumber: chapter.number,
        title: manual.title.trim(),
        description: manual.description.trim(),
        prerequisites: manual.prerequisites,
        orderIndex: chapterNodes.length,
        totalXp: manual.totalXp,
      });
      setManual({ title: "", description: "", totalXp: 100, prerequisites: [] });
      setManualOpen(false);
      setNotice("Level added.");
      await loadNodes();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add that level."));
    }
  }

  const draftTitle = new Map((draft ?? []).map((l) => [l.tempKey, l.title]));

  return (
    <>
      <PageHeader
        title="Levels"
        description="The roadmap steps students work through. Each level belongs to a published chapter."
        actions={
          chapters.length > 0 ? (
            <select
              value={chapterId}
              onChange={(e) => selectChapter(e.target.value)}
              aria-label="Chapter"
              className={`${FIELD_CLASS} w-72 max-w-full`}
            >
              {Array.from(new Set(chapters.map((c) => `${c.classLevel}::${c.subject}`))).map((book) => {
                const [classLevel, subject] = book.split("::");
                return (
                  <optgroup key={book} label={`Class ${classLevel} ${subject}`}>
                    {chapters
                      .filter((c) => `${c.classLevel}::${c.subject}` === book)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          Chapter {c.number}: {c.title}
                        </option>
                      ))}
                  </optgroup>
                );
              })}
            </select>
          ) : undefined
        }
      />

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Loader2 className="size-4 animate-spin" />
          Loading
        </p>
      ) : !chapter ? (
        <EmptyState title="No published chapters yet">
          Levels are built from a chapter.{" "}
          <Link href="/admin/content" className="font-medium text-primary hover:underline">
            Upload and publish a book
          </Link>{" "}
          first.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {error && <Notice tone="error">{error}</Notice>}
          {notice && <Notice tone="success">{notice}</Notice>}

          <Panel
            title={`Chapter ${chapter.number}: ${chapter.title}`}
            description={`Class ${chapter.classLevel} ${chapter.subject}, ${chapterNodes.length} ${chapterNodes.length === 1 ? "level" : "levels"}`}
            actions={
              <>
                <Button variant="outline" size="lg" className="px-3" onClick={() => setManualOpen((o) => !o)}>
                  <Plus />
                  Add by hand
                </Button>
                <Button size="lg" className="px-4" disabled={generating || draft !== null} onClick={() => void generate()}>
                  {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  {generating ? "Generating" : "Generate levels"}
                </Button>
              </>
            }
            flush
          >
            {manualOpen && (
              <form onSubmit={addManual} className="grid gap-3 border-b border-outline-variant/50 bg-surface-container-low/50 p-5 sm:grid-cols-[1fr_7rem]">
                <Field label="Title">
                  <input required value={manual.title} onChange={(e) => setManual((m) => ({ ...m, title: e.target.value }))} className={FIELD_CLASS} />
                </Field>
                <Field label="XP">
                  <input
                    type="number"
                    min={0}
                    value={manual.totalXp}
                    onChange={(e) => setManual((m) => ({ ...m, totalXp: Number(e.target.value) }))}
                    className={FIELD_CLASS}
                  />
                </Field>
                <Field label="What the student learns" className="sm:col-span-2">
                  <textarea
                    required
                    rows={2}
                    value={manual.description}
                    onChange={(e) => setManual((m) => ({ ...m, description: e.target.value }))}
                    className={`${FIELD_CLASS} h-auto py-2`}
                  />
                </Field>
                {chapterNodes.length > 0 && (
                  <fieldset className="sm:col-span-2">
                    <legend className="text-sm font-medium text-on-surface">Comes after</legend>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {chapterNodes.map((n) => {
                        const on = manual.prerequisites.includes(n.id);
                        return (
                          <button
                            type="button"
                            key={n.id}
                            aria-pressed={on}
                            onClick={() =>
                              setManual((m) => ({
                                ...m,
                                prerequisites: on ? m.prerequisites.filter((p) => p !== n.id) : [...m.prerequisites, n.id],
                              }))
                            }
                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                              on ? "border-primary bg-primary-fixed/40 text-primary" : "border-outline-variant text-on-surface-variant hover:bg-surface-container"
                            }`}
                          >
                            {n.title}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" size="lg" className="px-4">
                    Add level
                  </Button>
                  <Button type="button" variant="ghost" size="lg" onClick={() => setManualOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {chapterNodes.length === 0 ? (
              <div className="p-5">
                <EmptyState title="This chapter has no levels">Generate them from the chapter's content, or add them by hand.</EmptyState>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={TABLE_HEAD_CLASS}>
                      <th className="w-12 px-5 py-2 font-medium">Order</th>
                      <th className="px-3 py-2 font-medium">Level</th>
                      <th className="px-3 py-2 font-medium">Comes after</th>
                      <th className="px-3 py-2 text-right font-medium">XP</th>
                      <th className="w-12 px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {chapterNodes.map((n, i) => (
                      <tr key={n.id} className={TABLE_ROW_CLASS}>
                        <td className="px-5 py-2.5 tabular-nums text-on-surface-variant">{i + 1}</td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-on-surface">{n.title}</p>
                          <p className="line-clamp-1 text-xs text-on-surface-variant">{n.description}</p>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-on-surface-variant">
                          {n.prerequisites.map((p) => nodeTitle.get(p) ?? "Unknown").join(", ") || "Nothing"}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-on-surface-variant">{n.totalXp}</td>
                        <td className="px-3 py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => void deleteNode(n)}
                            aria-label={`Delete ${n.title}`}
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
            )}
          </Panel>

          {draft && (
            <Panel
              title="Generated levels"
              description="Nothing is saved until you save. Edit or remove anything that doesn't fit."
              actions={
                <>
                  <Button variant="ghost" size="lg" onClick={() => setDraft(null)}>
                    Discard
                  </Button>
                  <Button size="lg" className="px-4" disabled={committing || draft.length === 0} onClick={() => void saveDraft()}>
                    {committing ? <Loader2 className="animate-spin" /> : <Check />}
                    Save {draft.length} levels
                  </Button>
                </>
              }
            >
              {existingCount > 0 && (
                <Notice tone="warning" className="mb-4">
                  This chapter already has {existingCount} {existingCount === 1 ? "level" : "levels"}. Saving adds to them, so delete
                  the old ones first if these replace them.
                </Notice>
              )}
              <ol className="flex flex-col gap-3">
                {draft.map((level, i) => (
                  <li key={level.tempKey} className="flex gap-3 rounded-xl border border-outline-variant/70 p-3">
                    <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold tabular-nums text-on-primary">
                      {i + 1}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <input
                        value={level.title}
                        aria-label={`Level ${i + 1} title`}
                        onChange={(e) => patchLevel(level.tempKey, { title: e.target.value })}
                        className={`${FIELD_CLASS} font-medium`}
                      />
                      <textarea
                        rows={2}
                        value={level.description}
                        aria-label={`Level ${i + 1} description`}
                        onChange={(e) => patchLevel(level.tempKey, { description: e.target.value })}
                        className={`${FIELD_CLASS} h-auto py-2`}
                      />
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
                        <label className="flex items-center gap-1.5">
                          XP
                          <input
                            type="number"
                            min={0}
                            value={level.totalXp}
                            onChange={(e) => patchLevel(level.tempKey, { totalXp: Number(e.target.value) })}
                            className="h-7 w-20 rounded-md border border-outline-variant bg-surface-container-lowest px-2 tabular-nums"
                          />
                        </label>
                        {level.prerequisiteKeys.length > 0 && (
                          <span>Comes after {level.prerequisiteKeys.map((k) => draftTitle.get(k) ?? k).join(", ")}</span>
                        )}
                        {level.sourcePages.length > 0 && <span>From pages {level.sourcePages.join(", ")}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLevel(level.tempKey)}
                      aria-label={`Remove ${level.title}`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-error-container/60 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

export default function AdminLevelsPage(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <LevelsInner />
    </Suspense>
  );
}
