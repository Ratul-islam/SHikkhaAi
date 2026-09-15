# DESIGN.md — ShikkhaAI Design System & UI Specification

This document defines the visual identity, design tokens, component library, and UX guidelines for **ShikkhaAI (`apps/web`)**. It is modeled after the sleek, localized, dark-mode-first aesthetic of **borno.ai**, combined with gamified learning UI patterns.

---

## 1. Visual Identity & Design Ethos

ShikkhaAI’s UI balances **cutting-edge AI sophistication** with **friendly, approachable Bangladeshi educational aesthetics**.

* **Sleek & Futuristic**: Dark-mode primary baseline, glassmorphism backdrop blurs, subtle glowing gradients, thin high-contrast borders.
* **Warm & Grounded (Bangladeshi Context)**: Emerald green accents (`#00F5A0` / `#00D68F` referencing Bangladeshi green), warm gold highlights (`#F59E0B` for XP/streaks), and crisp Bangla typography.
* **Gamified Scannability**: Visual hierarchy prioritizing quick actions, interactive canvas sandboxes, progress nodes, and low cognitive friction.

---

## 2. Color Palette & Design Tokens

### Tailwind CSS Configuration (`tailwind.config.js`)

```javascript
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Core Surface Colors (Dark Glass Baseline)
        surface: {
          900: '#0B0F19', // Deepest background
          800: '#111827', // Card surface
          700: '#1F2937', // Elevated component / hover surface
          600: '#374151', // Borders & dividers
        },
        // Primary Brand Accent (Borno Emerald / Bangladeshi Green)
        brand: {
          400: '#34D399',
          500: '#10B981', // Main primary CTA
          600: '#059669', // Hover state
          glow: 'rgba(16, 185, 129, 0.25)',
        },
        // Secondary AI Accent (Electric Violet / Indigo)
        ai: {
          400: '#A78BFA',
          500: '#8B5CF6',
          glow: 'rgba(139, 92, 246, 0.25)',
        },
        // Gamification Accents
        gamify: {
          xp: '#F59E0B',      // Warm Amber / Gold
          streak: '#EF4444',  // Flame Red/Orange
          unlocked: '#10B981',// Node Green
          locked: '#4B5563',  // Node Slate
        }
      },
      fontFamily: {
        sans: ['Inter', 'Hind Siliguri', 'sans-serif'],
        bangla: ['Hind Siliguri', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
        'glow-emerald': '0 0 20px -3px rgba(16, 185, 129, 0.4)',
        'glow-purple': '0 0 20px -3px rgba(139, 92, 246, 0.4)',
      },
      backdropBlur: {
        xs: '2px',
        glass: '16px',
      }
    }
  }
}