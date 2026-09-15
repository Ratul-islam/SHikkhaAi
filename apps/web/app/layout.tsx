import type { Metadata } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { Plus_Jakarta_Sans, Hind_Siliguri } from "next/font/google";
import { AuthProvider } from "../lib/auth-context";
import Header from "../components/Header";
import ThemeInit from "../components/ThemeInit";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const plusJakartaSans = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-plus-jakarta-sans" });
const hindSiliguri = Hind_Siliguri({ weight: ['400', '500', '600', '700'], subsets: ["bengali"], variable: "--font-hind-siliguri" });

export const metadata: Metadata = {
  title: "Shikkha",
  description: "Adaptive AI tutoring for the Bangladeshi NCTB curriculum",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" className={cn("font-sans", plusJakartaSans.variable, hindSiliguri.variable)}>
      <body className="bg-background text-on-surface antialiased">
        <ThemeInit />
        <TooltipProvider delayDuration={200}>
          <AuthProvider>
            <Header />
            {children}
          </AuthProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
