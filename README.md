<p align="center"><img src="web/assets/brand/logo-mark.png" alt="Zintra" width="96"></p>

# Zintra حاضر

Staff attendance, points and rewards for **زينترا / Zintra**: location-checked check-in and check-out, a points system with green, red and black points, a monthly green reward, leave and early-leave requests, Telegram alerts for the owner, and monthly payroll-ready reports.

> Status: **Step 1 done (design system and app shell).** Later steps add the Supabase backend, auth, attendance, points, jobs and reports. This README grows with each step.

## Stack

- **Frontend:** plain HTML, CSS and ES-module JavaScript in `web/`. No build step and no framework.
- **Backend:** Supabase (Postgres, RLS, Edge Functions, pg_cron). Added from Step 2.

## Layout

```
assets/brand/            logo source files (unmodified; source of truth)
web/                     static site root (deploy this folder)
  index.html             app entry (login + staff shell + owner shell)
  design/index.html      DEV ONLY design-system preview (exclude from production)
  manifest.webmanifest   PWA manifest
  css/tokens.css         ALL design tokens (colors, type, spacing, radii, shadows, z, motion; light + dark)
  css/base.css           reset, typography, focus, RTL/LTR utilities
  css/components.css     button, field, select, switch, segmented, card, badge, table,
                         progress, empty state, skeleton, modal, toast, alert
  css/shell.css          sidebar / top bar / bottom bar / drawer / page header / login
  i18n/ar.json, en.json  one messages file per language (the product name is the single key `app.name`)
  js/boot.js             sets language, direction and theme before first paint
  js/core/               i18n, theme, router, dom helpers, safe storage
  js/ui/                 reusable components
  js/shell/              app shell + separate staff / owner navigation trees
  js/pages/              login, placeholder pages, design preview
tools/                   quality checks (contrast, token lint, UI matrix, keyboard)
```

## Run locally

```bash
npm run serve            # http://127.0.0.1:8787  (any static server works)
# app:     http://127.0.0.1:8787/index.html#/login
# design:  http://127.0.0.1:8787/design/index.html
```

## Quality checks

The checks need Node 18 or later and Playwright with Chromium.

```bash
npm run check:tokens     # no raw colors / font sizes / px spacing outside tokens.css
npm run check:contrast   # every shipped text/background pair passes WCAG AA, both themes
npm run check:ui         # 6 pages x 360/1440 px x ar/en x light/dark: no console errors, no overflow
npm run check:keyboard   # tab order + visible focus, keyboard language switch, modal/drawer focus
```

## Brand and design notes

- **Name:** "Zintra حاضر" is rendered inside `<bdi dir="ltr">`. In `<title>` it is wrapped in LRI…PDI isolates, so it keeps the same visual order in Arabic and English layouts.
- **Palette:** colors come from the logo (brand blue `#0245A0`, navy `#011B5A`, cyan `#02B0C8`/`#0CE4EF`, gold `#E4AF48`).
- **Gold:** used only for rewards.
- **Status colors:** jade, burnt orange, crimson and violet. They are chosen to stay distinct from the brand colors and from the green, red and black point colors.
- **Dark mode:** follows the device setting by default. A manual toggle is stored per device in `localStorage`.
- **Font:** IBM Plex Sans Arabic (SIL OFL 1.1), self-hosted in `web/assets/fonts/`.
- **Icons:** favicons and PWA icons are generated from `assets/brand/zintra-logo-source.png` and are never recolored or stretched.
