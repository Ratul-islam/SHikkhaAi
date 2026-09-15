"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { isAxiosError } from "axios";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { applyTheme, storeTheme } from "../../lib/theme";
import GlassCard from "../../components/GlassCard";
import { Button } from "@/components/ui/button";
import type { EarnedBadgeView, ProfileStatsResponse, ProfileView } from "../../lib/types";

/* ── Avatar ────────────────────────────────────────────────────────────── */

function AvatarPicker({ profile, onUpdated }: { profile: ProfileView; onUpdated: (p: ProfileView) => void }) {
  const [customUrl, setCustomUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function regenerate(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const res = await api.patch<ProfileView>("/profile/avatar", { regenerate: true });
      onUpdated(res.data);
    } catch {
      setError("Couldn't generate a new avatar. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function useCustomUrl(): Promise<void> {
    if (!customUrl.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const res = await api.patch<ProfileView>("/profile/avatar", { avatarUrl: customUrl.trim() });
      onUpdated(res.data);
      setCustomUrl("");
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "That doesn't look like a valid image URL.");
    } finally {
      setSaving(false);
    }
  }

  const MAX_UPLOAD_BYTES = 500_000; // ~500KB — comfortably under the server's data: URI cap once base64-encoded

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets picking the same file again re-fire onChange
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That image is too large — please choose one under 500KB.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      // No upload endpoint needed — small enough to read as a data: URI
      // client-side and store directly, the same string field a Google
      // photo URL or a generated avatar already lives in.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await api.patch<ProfileView>("/profile/avatar", { avatarUrl: dataUrl });
      onUpdated(res.data);
    } catch {
      setError("Couldn't upload that image. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      {profile.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatarUrl is either a data: URI or an arbitrary external URL (Google's photo, or a student-pasted link), neither of which next/image's optimizer can handle generically.
        <img src={profile.avatarUrl} alt="" className="size-20 rounded-full object-cover border-[3px] border-surface-container-lowest shadow-md" />
      ) : (
        <div className="flex size-20 items-center justify-center rounded-full bg-surface-container-lowest/60 backdrop-blur-md text-on-surface-variant font-bold text-2xl shadow-inner border border-outline-variant/30">?</div>
      )}

      <div className="flex flex-1 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="rounded-full bg-surface-container-lowest/50 backdrop-blur-sm border-outline-variant/30 hover:bg-surface-container-low hover:border-primary/40 transition-all" disabled={saving} onClick={regenerate}>
            <RefreshCw className="size-3.5" />
            Regenerate
          </Button>
          <Button type="button" variant="outline" size="sm" className="rounded-full bg-surface-container-lowest/50 backdrop-blur-sm border-outline-variant/30 hover:bg-surface-container-low hover:border-primary/40 transition-all" disabled={saving} asChild>
            <label className="cursor-pointer">
              Upload photo
              <input type="file" accept="image/*" onChange={handleFileUpload} disabled={saving} className="hidden" />
            </label>
          </Button>
        </div>
        <div className="flex gap-2">
          <input
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="Or paste an image URL"
            className="flex-1 rounded-lg border border-outline-variant/40 bg-surface-container-low border-outline-variant/40 px-3 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-primary/50"
          />
          <Button type="button" size="sm" className="rounded-full bg-primary hover:bg-primary-container text-on-primary shadow-md hover:shadow-lg transition-all" disabled={saving || !customUrl.trim()} onClick={useCustomUrl}>
            Use
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/* ── Profile fields ────────────────────────────────────────────────────── */

function ProfileForm({ profile, onUpdated }: { profile: ProfileView; onUpdated: (p: ProfileView) => void }) {
  const [name, setName] = useState(profile.name);
  const [address, setAddress] = useState(profile.address ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const response = await api.patch<ProfileView>("/profile/me", {
        name,
        address: address || null,
        phone: phone || null,
      });
      onUpdated(response.data);
      setSaved(true);
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "Couldn't save your changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
        Email
        <input
          disabled
          value={profile.email}
          className="w-full rounded-2xl bg-surface-container-lowest/30 border border-outline-variant/20 px-4 py-3 text-[15px] text-on-surface-variant outline-none cursor-not-allowed opacity-70"
        />
        {!profile.emailVerified && (
          <span className="text-xs text-amber-600">
            Not verified —{" "}
            <a href="/verify-email" className="underline">
              verify now
            </a>
          </span>
        )}
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Phone
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Optional"
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
        Address
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Optional"
          className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
        />
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-primary">Saved.</p>}

      <Button type="submit" disabled={saving} className="w-full sm:w-auto sm:self-start rounded-full px-8 py-6 text-[15px] font-label-lg bg-gradient-to-r from-primary to-tertiary hover:shadow-[0_4px_20px_rgba(0,104,95,0.3)] transition-all hover:-translate-y-0.5">
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}

/* ── Preferences (the "a lot more settings" ask) ──────────────────────── */

const SUBJECT_OPTIONS = ["Physics", "Chemistry", "Biology", "General Math", "Higher Math", "English", "Bangla"];

function PreferencesForm({ profile, onUpdated }: { profile: ProfileView; onUpdated: (p: ProfileView) => void }) {
  const s = profile.settings;
  const [theme, setTheme] = useState(s.theme);
  const [emailNotifications, setEmailNotifications] = useState(s.emailNotifications);
  const [dailyXpGoal, setDailyXpGoal] = useState(s.dailyXpGoal);
  const [preferredSubject, setPreferredSubject] = useState(s.preferredSubject ?? "");
  const [timezone, setTimezone] = useState(s.timezone);
  const [reducedMotion, setReducedMotion] = useState(s.reducedMotion);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const response = await api.patch<ProfileView>("/profile/settings", {
        theme,
        emailNotifications,
        dailyXpGoal,
        preferredSubject: preferredSubject || null,
        timezone,
        reducedMotion,
      });
      onUpdated(response.data);
      applyTheme(theme);
      storeTheme(theme);
      setSaved(true);
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "Couldn't save your preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Theme
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as typeof theme)}
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          >
            <option value="SYSTEM">Match system</option>
            <option value="LIGHT">Light</option>
            <option value="DARK">Dark</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Default subject on the roadmap
          <select
            value={preferredSubject}
            onChange={(e) => setPreferredSubject(e.target.value)}
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          >
            <option value="">All subjects</option>
            {SUBJECT_OPTIONS.map((subj) => (
              <option key={subj} value={subj}>
                {subj}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Daily XP goal
          <input
            type="number"
            min={1}
            max={1000}
            value={dailyXpGoal}
            onChange={(e) => setDailyXpGoal(Number(e.target.value))}
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
          Timezone
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="e.g. Asia/Dhaka"
            className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
          />
          <span className="text-sm font-label-md text-on-surface-variant">Used to decide your daily study streak's day boundary.</span>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
        <input
          type="checkbox"
          checked={emailNotifications}
          onChange={(e) => setEmailNotifications(e.target.checked)}
          className="size-5 rounded-md border-2 border-outline-variant/40 bg-surface-container-lowest/50 text-primary focus:ring-primary/50 transition-all"
        />
        Email me progress updates
      </label>

      <label className="flex items-center gap-2 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => setReducedMotion(e.target.checked)}
          className="size-5 rounded-md border-2 border-outline-variant/40 bg-surface-container-lowest/50 text-primary focus:ring-primary/50 transition-all"
        />
        Reduce motion in video lessons
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-primary">Saved.</p>}

      <Button type="submit" disabled={saving} className="w-full sm:w-auto sm:self-start rounded-full px-8 py-6 text-[15px] font-label-lg bg-gradient-to-r from-primary to-tertiary hover:shadow-[0_4px_20px_rgba(0,104,95,0.3)] transition-all hover:-translate-y-0.5">
        {saving ? "Saving…" : "Save preferences"}
      </Button>
    </form>
  );
}

/* ── Class switch ──────────────────────────────────────────────────────── */

function ClassLevelForm(): JSX.Element {
  const { user, updateClassLevel } = useAuth();
  const [selected, setSelected] = useState(user?.classLevel ?? 9);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!user) return <></>;

  async function handleConfirm(): Promise<void> {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await updateClassLevel(selected);
      setSaved(true);
      setConfirming(false);
    } catch {
      setError("Couldn't change your class. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
        Class
        <select
          value={selected}
          onChange={(e) => {
            setSelected(Number(e.target.value));
            setConfirming(Number(e.target.value) !== user.classLevel);
            setSaved(false);
          }}
          className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((level) => (
            <option key={level} value={level}>
              Class {level}
            </option>
          ))}
        </select>
      </label>

      {confirming && (
        <div className="rounded-lg border border-outline-variant/40 bg-surface-container-low p-3 text-sm text-on-surface-variant">
          <p>
            Switching to Class {selected} changes which roadmap and chat content you see. Progress you&apos;ve made
            in Class {user.classLevel} isn&apos;t lost — it&apos;ll just be hidden until you switch back.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" className="rounded-full bg-primary hover:bg-primary-container text-on-primary shadow-md hover:shadow-lg transition-all" disabled={saving} onClick={handleConfirm}>
              {saving ? "Switching…" : `Confirm switch to Class ${selected}`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(user.classLevel);
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-primary">Class updated.</p>}
    </div>
  );
}

/* ── Security ──────────────────────────────────────────────────────────── */

function SecuritySection(): JSX.Element {
  const { logoutAllDevices } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleConfirm(): Promise<void> {
    setSigningOut(true);
    await logoutAllDevices(); // redirects to /login itself — no need to reset state after
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-on-surface-variant">
        Revoke every other logged-in session (other browsers, other devices) — you&apos;ll need to log back in here too.
      </p>
      {!confirming ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setConfirming(true)}>
          <ShieldAlert className="size-3.5" />
          Sign out of all devices
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={signingOut} onClick={handleConfirm}>
            {signingOut ? "Signing out…" : "Confirm — sign out everywhere"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/* ── Stats & per-class progression ────────────────────────────────────── */

function StatsPanel(): JSX.Element {
  const [stats, setStats] = useState<ProfileStatsResponse | null>(null);

  useEffect(() => {
    api.get<ProfileStatsResponse>("/profile/stats").then((res) => setStats(res.data));
  }, []);

  if (!stats) {
    return <p className="text-sm text-on-surface-variant">Loading your stats…</p>;
  }

  const goalProgress = Math.min(100, Math.round((stats.todayXp / stats.dailyXpGoal) * 100));
  const goalMet = stats.todayXp >= stats.dailyXpGoal;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total XP" value={stats.totalXp} />
        <StatTile label="Day streak" value={stats.streakDays} />
        <StatTile label="Levels completed" value={stats.completedNodesCount} />
        <StatTile
          label="Mastery pass rate"
          value={stats.masteryPassRate !== null ? `${stats.masteryPassRate}%` : "—"}
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="font-medium">
            Today&apos;s goal — {stats.todayXp} / {stats.dailyXpGoal} XP
          </span>
          {goalMet && <span className="text-xs font-semibold text-primary">Goal met! 🎉</span>}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-container-high">
          <div
            className={`h-full rounded-full transition-all ${goalMet ? "bg-primary" : "bg-amber"}`}
            style={{ width: `${goalProgress}%` }}
          />
        </div>
      </div>

      {stats.perClass.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-outline-variant/30 text-left text-on-surface-variant/70">
                <th className="py-2 pr-4 font-medium">Class</th>
                <th className="py-2 pr-4 font-medium">Completed</th>
                <th className="py-2 pr-4 font-medium">Avg. score</th>
                <th className="py-2 font-medium">XP earned</th>
              </tr>
            </thead>
            <tbody>
              {stats.perClass.map((c) => (
                <tr key={c.classLevel} className="border-b border-outline-variant/20">
                  <td className="py-2 pr-4 font-medium">Class {c.classLevel}</td>
                  <td className="py-2 pr-4 text-on-surface-variant">
                    {c.completedNodes} / {c.totalNodes}
                  </td>
                  <td className="py-2 pr-4 text-on-surface-variant">
                    {c.averageScore !== null ? `${c.averageScore}%` : "—"}
                  </td>
                  <td className="py-2 text-on-surface-variant">{c.xpEarned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-on-surface-variant/70">No progress recorded yet — complete a level to see it here.</p>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="rounded-[2rem] border border-outline-variant/30 bg-surface-container-lowest/40 backdrop-blur-md p-6 text-center shadow-[0_8px_32px_rgba(0,0,0,0.04)] hover:shadow-[0_8px_32px_rgba(0,0,0,0.08)] transition-all">
      <div className="text-3xl font-headline-lg text-primary mb-1">{value}</div>
      <div className="text-sm font-label-md text-on-surface-variant">{label}</div>
    </div>
  );
}

function BadgesPanel(): JSX.Element {
  const [badges, setBadges] = useState<EarnedBadgeView[] | null>(null);

  useEffect(() => {
    api.get<{ badges: EarnedBadgeView[] }>("/profile/badges").then((res) => setBadges(res.data.badges));
  }, []);

  if (!badges) {
    return <p className="text-sm text-on-surface-variant">Loading your badges…</p>;
  }
  if (badges.length === 0) {
    return <p className="text-sm text-on-surface-variant/70">No badges yet — pass a Mastery Check to earn your first.</p>;
  }

  return (
    <div className="flex flex-wrap gap-3">
      {badges.map((b) => (
        <div
          key={b.key}
          title={b.description}
          className="flex items-center gap-2 rounded-full border border-outline-variant/30 bg-surface-container-lowest/60 backdrop-blur-md px-4 py-2 text-sm shadow-sm hover:shadow-md transition-all hover:-translate-y-0.5 cursor-default"
        >
          <span className="text-lg">{b.icon}</span>
          {b.title}
        </div>
      ))}
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function SettingsPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<ProfileView>("/profile/me")
      .then((res) => {
        setProfile(res.data);
        applyTheme(res.data.settings.theme);
        storeTheme(res.data.settings.theme);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="p-8 text-sm text-on-surface-variant">Loading your profile…</p>;
  }
  if (!profile) {
    return <p className="p-8 text-sm text-destructive">Couldn&apos;t load your profile.</p>;
  }

  const glassPanelClass = "bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] p-8";

  return (
    <>
      {/* Animated Spatial Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 bg-background/50">
        <div 
          className="absolute top-[5%] right-[10%] w-[40vw] h-[40vw] rounded-full bg-primary/15 blur-[120px] animate-pulse" 
          style={{ animationDuration: '8s' }}
        />
        <div 
          className="absolute bottom-[10%] left-[5%] w-[45vw] h-[45vw] rounded-full bg-tertiary/15 blur-[120px] animate-pulse" 
          style={{ animationDuration: '12s', animationDelay: '2s' }}
        />
        {/* Subtle grid pattern overlay */}
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at center, currentColor 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      </div>

      <main className="relative z-10 mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12 mb-12">
        <header className="mb-2 px-2 text-center">
          <h1 className="text-4xl font-headline-lg font-bold text-on-surface mb-2 tracking-tight">Your Profile</h1>
          <p className="text-on-surface-variant">Manage your settings, progress, and preferences.</p>
        </header>

        <section className={glassPanelClass}>
          <h1 className="mb-6 text-2xl font-semibold text-on-surface">Personal Info</h1>
          <div className="mb-8">
            <AvatarPicker profile={profile} onUpdated={setProfile} />
          </div>
          <ProfileForm profile={profile} onUpdated={setProfile} />
        </section>

        <section className={glassPanelClass}>
          <h2 className="mb-1 text-2xl font-semibold text-on-surface">Preferences</h2>
          <p className="mb-6 text-sm text-on-surface-variant">Tune how ShikkhaAI looks and behaves for you.</p>
          <PreferencesForm profile={profile} onUpdated={setProfile} />
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <section className={`${glassPanelClass} flex flex-col`}>
            <h2 className="mb-1 text-2xl font-semibold text-on-surface">Class</h2>
            <p className="mb-6 text-sm text-on-surface-variant">Change which class&apos;s roadmap and chat content you see.</p>
            <div className="flex-1 flex flex-col justify-end">
              <ClassLevelForm />
            </div>
          </section>

          <section className={`${glassPanelClass} flex flex-col`}>
            <h2 className="mb-1 text-2xl font-semibold text-on-surface">Security</h2>
            <div className="mt-4 flex-1 flex flex-col justify-end">
              <SecuritySection />
            </div>
          </section>
        </div>

        <section className={glassPanelClass}>
          <h2 className="mb-6 text-2xl font-semibold text-on-surface">Progress &amp; statistics</h2>
          <StatsPanel />
        </section>

        <section className={glassPanelClass}>
          <h2 className="mb-6 text-2xl font-semibold text-on-surface">Badges</h2>
          <BadgesPanel />
        </section>
      </main>
    </>
  );
}
