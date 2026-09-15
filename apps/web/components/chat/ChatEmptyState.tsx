import { Flame, Zap, MoveUpRight, History } from "lucide-react";
import { useAuth } from "../../lib/auth-context";
import type { ConversationSummary } from "../../lib/types";



export default function ChatEmptyState({
  onAsk,
  conversations = [],
  onOpenConversation,
}: {
  onAsk: (q: string) => void;
  /** Already loaded by the page for the sidebar — reused here so a returning student can resume without opening the sidebar. */
  conversations?: ConversationSummary[];
  onOpenConversation?: (c: ConversationSummary) => void;
}) {
  const { user } = useAuth();
  const recentConversations = conversations.slice(0, 3);

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-4xl mx-auto px-4 py-8 lg:py-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary-fixed/40 text-on-primary-fixed-variant mb-6 font-label-md text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-primary" />
        <span>Borno AI 3.5 Turbo • NCTB পাঠ্যক্রম ভিত্তিক সার্বক্ষণিক টিউটর</span>
      </div>

      <h1 className="text-3xl lg:text-4xl font-bold text-center text-on-surface mb-4">
        আজ তুমি <span className="text-primary">কী শিখতে চাও</span>{user?.name ? `, ${user.name}` : ""}?
      </h1>

      <p className="text-on-surface-variant text-center max-w-2xl mb-8 font-body-lg text-lg">
        তোমার ব্যক্তিগত এআই শিক্ষক যেকোনো কঠিন সমীকরণ, অনুধাবনমূলক প্রশ্ন ও জটিল থিওরি সহজ বাংলায় ধাপে ধাপে বুঝিয়ে দিতে প্রস্তুত।
      </p>

      {/* Suggestion Chips */}
      <div className="flex flex-wrap items-center justify-center gap-3 mb-10">
        {[
          { text: "নিউটনের সূত্র", icon: "✨" },
          { text: "পর্যায় সারণি ট্রিকস", icon: "🧪" },
          { text: "ত্রিকোণমিতি জ্যামিতি", icon: "📐" },
          { text: "কোষের শক্তির", icon: "🧬" },
        ].map((chip) => (
          <button
            key={chip.text}
            type="button"
            onClick={() => onAsk(chip.text)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-surface-container-lowest hover:bg-surface-container text-on-surface-variant font-label-md transition-colors shadow-sm border border-outline-variant/30"
          >
            <span>{chip.icon}</span>
            {chip.text}
          </button>
        ))}
      </div>

      <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6 mt-6">
        {/* Streak & XP — real numbers from the student's own profile, not a mockup placeholder */}
        <div className="bg-secondary-fixed/25 rounded-3xl p-6 border border-secondary-fixed/60 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-2xl bg-secondary-fixed/70 flex items-center justify-center shrink-0">
                <Flame className="w-6 h-6 text-secondary fill-current" />
              </div>
              <div>
                <h3 className="font-bold text-[17px] text-on-surface">{user?.streakDays ?? 0} দিনের ধারাবাহিকতা!</h3>
                <p className="text-sm text-secondary font-medium">
                  {user?.streakDays ? "দারুণ গতিতে এগিয়ে চলেছো" : "আজ থেকেই শুরু করো"}
                </p>
              </div>
            </div>
            <p className="text-sm text-on-surface-variant mb-4 leading-relaxed font-medium">
              প্রতিদিন কিছুক্ষণ পরিকল্পিত অনুশীলন তোমাকে বোর্ড পরীক্ষায় আত্মবিশ্বাস এনে দেবে।
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-on-surface-variant">
            <Zap className="w-3.5 h-3.5 text-secondary" />
            <span>সর্বমোট {user?.xp ?? 0} XP অর্জিত</span>
          </div>
        </div>

        {/* Recent conversations — same data the sidebar shows, surfaced here so a returning student can resume without opening it */}
        <div className="bg-primary-fixed/15 rounded-3xl p-6 border border-primary-fixed/50 flex flex-col justify-between">
          <div className="flex items-center gap-2 mb-3 text-on-surface">
            <div className="w-8 h-8 rounded-full bg-primary-fixed/60 flex items-center justify-center shrink-0">
              <History className="w-4 h-4 text-primary" />
            </div>
            <h3 className="font-bold text-[17px]">সাম্প্রতিক কথোপকথন</h3>
          </div>

          {recentConversations.length > 0 ? (
            <div className="flex flex-col gap-2">
              {recentConversations.map((c) => (
                <button
                  key={`${c.subject}::${c.chapter}::${c.conversationSlot}`}
                  type="button"
                  onClick={() => onOpenConversation?.(c)}
                  className="flex items-center justify-between gap-2 rounded-xl bg-surface-container-lowest/70 hover:bg-surface-container-lowest px-3 py-2 text-left transition-colors"
                >
                  <span className="min-w-0 truncate text-sm font-semibold text-on-surface">{c.title}</span>
                  <MoveUpRight className="w-3.5 h-3.5 shrink-0 text-primary" />
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant ml-10">
              এখনো কোনো কথোপকথন নেই — নিচে একটা প্রশ্ন জিজ্ঞেস করে শুরু করো।
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
