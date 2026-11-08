# Brianotron design system ("Ledger")

Owner: design lead. Consumers: pages lead (room pages, Agent Trail, Analytics, Credit) and anyone touching `apps/web`.
This file is the source of truth for tokens, type, primitives and layout patterns. If code and this file disagree, tell the
design lead (bottom section) rather than forking a style locally.

**Direction.** A precise, calm instrument panel for a family's money: cool neutral surfaces, near-black ink, one cobalt
accent, and depth from layering and hairline borders instead of shadows or glow. Numbers are the hero: they are set in a
wide, engineered display face with tabular figures; everything else is a quiet, highly legible UI face.

Never: glow, neon, gradients (beyond a 1-px hairline), glassmorphism/backdrop blur, emoji, drop shadows on cards, colour as
the only carrier of meaning, raw hex in components.

Status: **v2 tokens and primitives are in the tree** unless a line says *(planned)*.

---

## 1. Themes

- Light and dark are both first-class. Default is **system** (`prefers-color-scheme`); the shell has a three-way toggle
  (System / Light / Dark) in the sidebar footer and the phone menu, stored in `localStorage["cosign.theme"]`.
- An inline script in `app/layout.tsx` stamps `<html data-theme="light|dark">` before first paint (no flash). With no
  JavaScript the media query still applies.
- Tailwind's `dark:` variant follows the resolved theme (`[data-theme=dark]`). **You should almost never need it**: every
  token below already switches. Use `dark:` only for a genuinely different treatment, never to fix a hard-coded colour.
- `?theme=light|dark|system` on any URL sets and remembers the preference (e.g. open `/?theme=light` once on the projector laptop).
- Demo recommendation: leave it on **system** for judges' phones. Force **light** on the projector/demo laptop (projectors
  crush dark UIs); dark is the better look on a phone in hand.

## 2. Colour tokens

All tokens are CSS variables on `:root`, exposed to Tailwind as colours (`bg-surface`, `text-ink-2`, `border-line`...).

| Token | Tailwind | Light | Dark | Use |
|---|---|---|---|---|
| `--bg` | `bg-bg` | `#f4f5f7` | `#0b0c0f` | page canvas, sidebar |
| `--surface` | `bg-surface` | `#ffffff` | `#131519` | cards, sheets, popovers, inputs |
| `--surface-2` | `bg-surface-2` | `#f5f6f8` | `#1a1c21` | insets inside a card, hover fill, tracks, wells |
| `--surface-3` | `bg-surface-3` | `#eceef1` | `#22252a` | pressed / selected fill, skeleton |
| `--ink` | `text-ink` | `#0e1013` | `#eceef1` | primary text, figures |
| `--ink-2` | `text-ink-2` | `#464b53` | `#a7acb4` | secondary text |
| `--ink-3` | `text-ink-3` | `#6a707a` | `#7f858e` | muted text, axis labels, captions (≥4.5:1 on surface) |
| `--line` | `border-line` | `#e5e7eb` | `#24272c` | hairlines, card borders, dividers, grid |
| `--line-strong` | `border-line-strong` | `#d3d6dc` | `#33363c` | input borders, axis baseline, popover border |
| `--brand` | `bg-brand` | `#355edd` | `#426ce5` | **the accent**: primary button fill, active indicator, selected control, chart series 1 |
| `--brand-hover` | `bg-brand-hover` | `#284cc3` | `#5379ee` | primary button hover |
| `--brand-strong` | `text-brand-strong` | `#284cc3` | `#9bb3ff` | accent **text/icons** (links, eyebrows, active nav icon) |
| `--brand-soft` | `bg-brand-soft` | `#ebf0fd` | `#19223d` | selected row, soft accent chip |
| `--brand-ink` | `text-brand-ink` | `#ffffff` | `#ffffff` | text on `bg-brand` |
| `--dark` / `--dark-ink` | `bg-dark text-dark-ink` | `#0e1013` / `#fff` | `#eceef1` / `#0b0c0f` | the **inverse** fill (ink-coloured button, active segment) |
| `--focus` | – | `#355edd` | `#8aa5ff` | focus ring (applied globally) |
| `--rec` | `bg-rec` | `#d92d20` | `#ff5a4f` | recording indicator only |

**Semantic scale** (reserved for meaning; never for decoration or "series 4"). Always pair with text or an icon.

| Tone | text / fill | soft bg | Dark text | Dark soft |
|---|---|---|---|---|
| `good` | `#007e46` | `#e6f6ec` | `#5ccb89` | `#11271b` |
| `watch` | `#ad5c00` | `#fef6ea` | `#e9b452` | `#2a210f` |
| `risk` | `#c9302d` | `#fdebe9` | `#f97770` | `#321716` |
| `info` | `#4b677e` | `#eef3f8` | `#95b6ce` | `#172129` |

`info` is a desaturated steel blue on purpose, so it never reads as the cobalt accent.

**Chart series** (validated with the dataviz CVD checker in both modes; adjacent ΔE ≥ 12, see §8):

| Var | Light | Dark | Name |
|---|---|---|---|
| `--chart-1` | `#355edd` | `#5b7ef2` | cobalt (= accent) |
| `--chart-2` | `#e07a2e` | `#d66f28` | orange |
| `--chart-3` | `#14a394` | `#18998b` | teal |
| `--chart-4` | `#9b5bd6` | `#9468dc` | violet |
| `--chart-5` | `#d9a400` | `#b8881a` | ochre |
| `--chart-6` | `#d9548f` | `#d0558a` | magenta |
| `--chart-muted` | `#a3a9b2` | `#4d525a` | baseline / "other" / comparison series |
| `--chart-grid` | `#eceef1` | `#1f2226` | gridlines |
| `--chart-axis` | `#d3d6dc` | `#33363c` | axis baseline |

Old names still work: `--c1..--c5` alias the first chart colours; `--side*` alias the new sidebar values.

## 3. Type

| Family | Tailwind | Face | Use |
|---|---|---|---|
| UI | `font-sans` (default) | **Instrument Sans** | everything readable; crisp at 12–14 px, plain tabular zeros |
| Display / figures | `font-display` | **Archivo**, set expanded (`font-stretch` 110–116 %) | page titles (`.display`), KPI figures (`.figure`), the wordmark |
| Mono | `font-mono` | **Geist Mono** | ids, model names, tokens/latency, code |

Tabular numerals: add `num` to anything numeric (tables, inputs and `.figure` get it automatically). `.figure` = display
face at 116 % width + tabular + tight tracking; use it for every headline number. `.display` = the same face at 110 % for
titles. (Mona/Hubot Sans were tried first and dropped: their tabular zero is slashed, which reads as "θ" in money.)

**Type scale** (named Tailwind sizes; line height is built in). Prefer these over `text-[0.84rem]`-style one-offs.

| Class | Size / line | Typical use |
|---|---|---|
| `text-2xs` | 11 / 14 | axis ticks, eyebrows (`.eyebrow` adds caps + tracking) |
| `text-caption` | 12 / 16 | meta lines, chips, table headers, legend |
| `text-label` | 13 / 18 | secondary body, list subtitles, form hints |
| `text-body` | 14 / 20 | body (the `<body>` default) |
| `text-lead` | 15 / 22 | wizard/landing body, card title (`font-semibold`) |
| `text-h3` | 17 / 22 | section titles in sheets |
| `text-h2` | 22 / 28 | page title (`font-display`) |
| `text-h1` | 28 / 32 | wizard step title, room name on desktop |
| `text-display` | 44 / 46 | landing hero only |
| `text-kpi` | 32 / 34 | hero figure (one per page) |
| `text-kpi-sm` | 22 / 26 | secondary figures in stat tiles |

Weights: 400 body, 500 labels/nav, 600 titles and figures. No 700+ outside the landing hero.

## 4. Radius, spacing, elevation, iconography

- **Radius** (Tailwind names, retuned): `rounded-sm` 4 (chips, ticks) · `rounded-md` 6 (buttons, inputs, nav items) ·
  `rounded-lg` 10 (cards, panels) · `rounded-xl` 14 (sheets, dialogs, the wizard card) · `rounded-full` (avatars, pills).
- **Spacing**: 4-px grid. Gaps: `gap-2` inside rows, `gap-3` between cards (phones and desktop), `gap-6` between page
  sections. Card padding `p-4` (16) everywhere; `p-5` on hero cards from `lg`. Page gutter `px-4 sm:px-6`.
- **Elevation is layering, not shadow.** Four layers: canvas `bg-bg` → card `bg-surface` + `border-line` → inset
  `bg-surface-2` (no border) → floating (popover/sheet/tooltip) `bg-surface` + `border-line-strong` + `shadow-pop`.
  Cards never get a shadow. In dark mode cards also get a 1-px top highlight via `.card` (built into `Card`/`Panel`).
- **Icons**: 24-px grid, 1.6 stroke (auto 1.8 at ≤16 px), round caps. 16 px inline with text, 18 px in buttons, 20 px in
  nav. Icons are `currentColor`; tint them with text tokens, accent only for the active state.
- **Focus**: a 2-px `--focus` outline, 2-px offset, on every focusable element (global). Never remove it; inputs use a
  1-px accent border + 3-px soft ring instead.

## 5. Motion

One easing family (`--ease-out`), three durations (`--dur-1` 140 ms hover/press, `--dur-2` 240 ms enter, `--dur-3`
400 ms hero). Opacity and transform only. All collapse under `prefers-reduced-motion`.

| Class / API | What |
|---|---|
| `motion-page` | room page fade-in (on `<main>` in the shell; don't add your own) |
| `<Reveal i>` / `motion-rise` + `--i` | staggered entrance for heroes and bento tiles (45 ms step) |
| `motion-fade` + `--i` | dense list rows |
| `<CountUp value format>` | KPI figures on first show |
| `press` | press feedback (built into `Button`, `ListRow`, interactive `Card`) |
| `bar-fill` | progress / meter fill: set `transform: scaleX(v)` |
| `anim-blink` | live / running dot |

Purposeful micro-interactions only: hover changes a border or fill (never lifts), tooltips fade in 120 ms, a live value
pulses once when it changes (`<CountUp>`). No looping decoration.

## 6. Primitives (`@/components/ui`)

Existing APIs are unchanged unless marked **new** or **changed**. All take `className`.

| Component | Props | Notes |
|---|---|---|
| `Card` | `interactive?` **new** + div props | surface + hairline + radius-lg. `interactive` adds hover border and press. |
| `Panel` | `title, info?, sub?, right?, footer?` **new**, `flush?` **new**, `id?, bodyClassName?` | titled card (h2). `footer` = one trailing link row ("All accounts →"). `flush` removes body padding (tables, `List`). |
| `PageHeader` | `title, sub?, right?, eyebrow?` **new** | page title in `font-display text-h2`. One per page. |
| `SectionTitle` | `title, sub?, right?, id?` | in-page group heading (h3). |
| `Stat` | `label, value, sub?, info?, size?: "sm"\|"md"\|"lg"` **new**, `delta?` **new**, `tone?` **new** | label over a `.figure` value. `tone` colours the value (good/watch/risk only). |
| `StatCard` **new** | `label, value, sub?, info?, delta?, tone?, size?, chart?, footer?, href?` | a bento KPI tile: `Card` + `Stat` + optional sparkline slot (`chart`) on the right/bottom. `href` makes the whole tile a link. |
| `Delta` | `value, text?, good?, plain?` **new** | signed change. `plain` = coloured text + arrow, no pill (use inside dense rows). |
| `Chip` | `tone?: Tone, title?` | status chip. `neutral` is borderless grey. `Tone` = `neutral good watch risk info brand` (`accent` now = `brand`). |
| `StatusDot` | `tone` | 8-px dot; always next to a word. |
| `Button` | `variant: primary\|dark\|secondary\|ghost\|danger`, `size: sm\|md\|lg` | one primary per view. `dark` is the inverse (ink) fill. |
| `IconButton` | `label` (required), button props | 36-px square, ghost. |
| `Segmented` | `value, onChange, options, label, size?: "sm"\|"md"` **new** | segmented control; active segment is a raised surface. |
| `Tabs` **new** | `items: {value, label, href?, count?}[], value, onChange?, label` | underline tabs; `href` items render as `Link` (URL-driven tabs like My Picture). |
| `ListRow` **new** | `title, sub?, leading?, trailing?, meta?, href?, onClick?, chevron?` | the one list row: 56-px min height, hover fill when interactive, chevron when it navigates. |
| `List` **new** | `children, inset?` | `<ul>` with hairline dividers; `inset` = rounded bordered box (outside a Panel). |
| `Progress` | `value, tone?, label?, height?` | thin bar on a `surface-3` track. |
| `Meter` **new** | `value, max?, bands?: {to, tone}[], label` | a bar with threshold ticks (utilization, DTI). |
| `Avatar` | `name, size?, ring?, dot?` | hue from name, theme-aware. |
| `IconTile` | `tone?, size?` | soft tinted square for an icon. |
| `Empty` | `title, children?, icon?` **new**, `action?` **new** | the one empty state. |
| `ErrorNote` | `children, action?` | the one error state. |
| `Notice` **new** (moved from onboarding) | `tone: info\|warn\|error\|good, children, action?, live?` | inline callout with icon. `fields.tsx` re-exports it. |
| `Skeleton` | `className` | loading block; size it like the content. |
| `Spinner` | `size?` | only inside buttons and tiny inline waits. |
| `Disclosure` | `summary, children, defaultOpen?` | styled `<details>`. |
| `LivePill` | `label?` (`dark` is accepted and ignored) | live / recording state. |
| `TableScroll` | children | horizontal scroll for a `.tbl`. |
| `InfoTip` | `text, label?` | info popover; only on computed numbers. |
| `Money` | children | tabular span. |
| class strings | `inputCls`, `selectCls`, `labelCls`, `BENTO` **new** | see §7. |

Motion: `@/components/motion` (`Reveal`, `StepTransition`, `CountUp`, `useTween`, `leaveThen`) is unchanged.

## 7. Layout patterns

**Page.** The shell renders the room header (household name, people, actions). A page starts with an optional
`PageHeader` (title + one short sub + right-aligned controls), then sections separated by `space-y-6`, cards by `gap-3`.

**Bento grid.** A 12-column grid from `md`, single column on phones:
```tsx
<div className="grid grid-cols-12 gap-3">
  <StatCard className={BENTO.quarter} ... />      {/* 6 cols on phones (2-up), 3 from xl */}
  <Panel className={BENTO.twoThirds} ... />        {/* full on phones, 8 from xl */}
  <Panel className={BENTO.third} ... />
</div>
```
`BENTO` = `{ full, half, third, twoThirds, quarter, hero }` → `col-span-12`, `col-span-12 md:col-span-6`,
`col-span-12 md:col-span-6 xl:col-span-4`, `col-span-12 xl:col-span-8`, `col-span-6 xl:col-span-3`,
`col-span-12 xl:col-span-6`. Rules: one hero tile per page (the first, largest number); tiles in a row share a height
(`h-full` on the card); a row never mixes more than three widths; phones get at most one 2-up row (KPIs).

**Stat tile.** `StatCard` (label `text-caption text-ink-3`, value `.figure text-kpi-sm`, delta + context in one line).
Hero tile: `size="lg"` (value `text-kpi`) with a sparkline `chart`.

**Chart card.** `Panel` with title + one-line `sub` holding the headline number or state, `right` = a `Segmented`
range/series control if any, body = legend (`ChartLegend`) then the chart. Charts never sit in a bare card without a title.

**List rows.** `Panel flush` + `List` of `ListRow`s; a trailing `footer` link ("All bills") when the list is truncated.
Money right-aligned and tabular in `trailing`; status as a `Chip` or `StatusDot` + word in `meta`.

**Tables.** `.tbl` inside `TableScroll`; headers `text-caption text-ink-3`, numbers `.r` (right) and tabular.

**States.** Loading: `Skeleton`s shaped like the content (the same grid), never a page spinner. Empty: `Empty` with one
line of what is missing and, if possible, one `action`. Error: `ErrorNote` with a retry `action`. A card with nothing to
say is omitted, not shown empty (Dashboard rule).

**Copy.** Sentence case. A subtitle only when it carries a number or state. No exclamation marks.

## 8. Charts (`@/components/charts`)

| Export | Props | Notes |
|---|---|---|
| `TrendChart` (lazy) | `model, height?, mobileHeight?` | net worth: actual (solid cobalt + 8 % wash), forecast (dashed), best–worst **range band** |
| `CashFlowChart` (lazy) | `months, height?` | income / expense columns + net line; forecast months hatched-light |
| `Sparkline` | `values, width?, height?, label?, color?` | 1.75-px line, end dot with surface ring |
| `ScoreGauge` **new** | `value, min, max, bands: {to, tone, label}[], label, size?, format?` | 240° arc gauge for health (0–100) and credit (300–850); bands drawn as segments with 2-px gaps |
| `BarList` **new** | `items: {key, label, value, display?, color?, href?}[], max?, format?` | horizontal bars for categories / merchants; labels and values in text tokens |
| `ChartLegend` **new** | `items: {label, color, kind: "line"\|"dash"\|"bar"\|"dot"\|"band"}[]` | legend row above a chart (always for ≥2 series) |
| `ChartTooltip` **new** | `title, rows: {label, value, color?, kind?}[], note?` | the one tooltip card; use inside Recharts `content` |
| `chartTheme` **new** (`charts/theme.ts`) | `axisX, axisY, grid, cursorLine, cursorBand, SERIES, tickUsd` | spread into Recharts: `<XAxis {...chartTheme.axisX} />` |

Rules (from the dataviz method): one y-axis per chart; lines 2 px; bars ≤ 24 px with 4-px rounded data end and a 2-px
surface gap; recessive solid 1-px grid (`--chart-grid`), no vertical grid; axis text `text-2xs` `--ink-3`; series colours
in fixed order (`SERIES[0..5]`), never cycled, never by rank; status colours only for status (a "worst case" line may use
`risk`); text never wears a series colour; every chart has a `role="img"` summary and a legend for ≥ 2 series.
New Recharts charts go through `charts/lazy.tsx` (`next/dynamic`, `ssr: false`).

## 9. Shell and navigation

- Sidebar (md+): canvas-coloured, hairline right border, wordmark + household, three nav groups, footer with the
  connection line and the theme toggle. Active item: raised surface pill, ink text, accent icon.
- Phones: canvas top bar (menu, wordmark, Ask, Call, activity, bell); bottom tab bar Home · Table · Talk · What-If ·
  Goals · More. "More" opens the drawer (full nav + theme toggle).
- **Nav** (`components/shell/nav.ts`): Dashboard, My Picture, **Analytics** (`/room/[id]/analytics`), **Credit**
  (`/room/[id]/credit`), Household / *Plan together*: Table Mode, What-If Studio, Goals / *Under the hood*: Agent Trail.
  The Advisor Console entry is gone (contracts §11).
- `/agents` renders inside the shell the same way it does today.

## 10. Migrations for existing code (pages lead)

Nothing is removed. These spots hard-code colours that break in dark mode:

| Where | Today | Use instead |
|---|---|---|
| `AgentTrail.tsx:179` filter pills | `bg-dark text-white on-dark` | `bg-dark text-dark-ink` (or `Segmented`) |
| `AgentTrail.tsx:183` | `text-white` | `text-dark-ink` / `text-brand-ink` on `bg-brand` |
| `TableMode.tsx:269` | `bg-brand-strong text-white` | `bg-brand text-brand-ink` (`brand-strong` is now a **text** colour; in dark mode it is light) |
| `VoteBar.tsx:16,24` | `#aab6b0` | `bg-chart-muted` |
| any `hover:bg-brand-strong` | | `hover:bg-brand-hover` |
| any `bg-white` / `text-black` / hex | | a token |

## 11. Requests for the pages lead

1. Please build Analytics and Credit on `BENTO` + `StatCard` + `Panel`; credit score = `ScoreGauge` (bands from
   contracts §9: 580 / 670 / 740 / 800) with the history as a `Sparkline` or a small line chart using `chartTheme`.
2. Swap hand-rolled list rows for `ListRow` where you rebuild cards, and `Notice` for inline callouts.
3. Fix the four dark-mode spots in §10 when you touch those files.
4. Use `font-display`/`.figure` for headline numbers only; body numbers stay in the UI face with `num`.
5. `CoachPanel` (Ask Brianotron) prints the model's markdown raw (`**$35,700 in savings**` shows the asterisks). Render bold/lists, or
   strip `**` before display. The slide-over frame around it is mine and is done.
6. When you need a new primitive, add the request in §12 rather than a local copy; small one-offs can live in your file.

## 12. Requests for the design lead

_(Pages lead: write requests here. I check this section regularly.)_

From the pages lead (21:06):
1. **Blocking, right now:** every page is a 500 in `next dev`: `components/shell/theme.ts` uses `useSyncExternalStore` and is imported
   by the server `app/layout.tsx` (needs `"use client"` or a split). `tsc` also flags `AppShell.tsx:125` (`compact` prop) and
   `charts/ScoreGauge.tsx:74,95`. I can't screenshot until these are fixed; please ping here when green.
2. Routes are in: `/room/[id]/analytics` (no redirect any more) and `/room/[id]/credit`. `/advisor` now redirects to `/`.
   Please add both to `nav.ts` as in §9 and drop the Advisor entry (I have not touched the shell).
3. My Picture's tabs are now **Accounts · Bills · Activity** (`?tab=activity`, the transaction ledger). `?tab=spending`
   redirects to Analytics. If the shell links to `picture?tab=spending` anywhere, point it at `/analytics`.
4. Alert `kind` gains `credit` (contracts §9). If `NotificationsBell` maps kinds to labels or icons, add it.

**Design lead replies:**
1. Green. `theme.ts` is split: server-safe constants + inline script in `components/shell/theme-script.ts`, the hooks and
   `setThemePref` in `components/shell/theme.ts` (`"use client"`). `tsc --noEmit` is clean; `/` and `/room/hh_rivera` are 200.
2. Done: nav is Dashboard, My Picture, Analytics, Credit, Household / Table Mode, What-If Studio, Goals / Agent Trail. No Advisor entry.
3. The shell has no `picture?tab=spending` links. Noted for any I add.
4. The bell does not map kinds (it uses severity: critical = risk dot, warn = watch, info = info), so `credit` alerts already show.

From the pages lead (21:13): thanks, all green here. One left: `npm run lint` fails on `charts/ScoreGauge.tsx:65`
(`react-hooks/immutability`, "Cannot reassign `from`"): computing each band's start from `bands[i - 1]?.to ?? min` instead of
the mutable `from` fixes it. I use `ScoreGauge` on Credit (with `CREDIT_BANDS`) and on the Dashboard health card (bands that
match `scoreLabel` in lib/finance.ts: At risk / Needs attention / Fair / Good / Excellent), and `BarList` on Analytics.

**Design lead reply (21:30):** fixed (`from` is now `bands[i - 1].to`); `npm run lint` and `npm run build` are green. Also new
since 21:13: `.card`, `.pop`, `.figure`, `.display`, `.eyebrow`, `.scrim` are Tailwind `@utility`s now, so `sm:card` etc. work
and a plain `rounded-xl` beats `card`'s radius without `!`. The light `--watch` is a brighter amber (`#ad5c00`); bars read as
amber instead of brown.

From the pages lead (final):
5. Room pages are on the kit: `BENTO`, `StatCard`, `Panel` footers with `PanelLink`, `List`/`ListRow`, `Tabs` (My Picture), `Notice`,
   `ScoreGauge` (Credit, Dashboard health), `BarList` (Analytics), `chartTheme` + `ChartLegend` + `ChartTooltip` (What-If chart).
6. Nice to have: `Sparkline` takes a fixed pixel width, so in `StatCard`'s phone slot it stops at 176 px; a `width="100%"` mode
   (viewBox + `preserveAspectRatio="none"` on the paths, dot drawn in HTML) would let the hero tile's trend span the card.
7. Coach answers arrive with `**bold**` and `【tool】` tags; `CoachPanel` now renders them (bold, and a quiet mono tag). If the
   call sheet shows model text anywhere, it may want the same treatment.

## 13. Voice controls API

_(Reserved for the voice agent's push-to-talk / half-duplex API notes.)_

**Call sheet UI (design lead, built on `lib/voiceCall` `setPushToTalk` / `pressTalk` / `releaseTalk` / `interrupt` and
`holdToTalkProps` from `lib/voiceCall/hold`):** a "Noisy room? Hold to talk" switch in the idle view and the live footer;
when it is on, a 64-px "Hold to talk" button (pointer, touch, Space/Enter held) replaces Mute and turns `--rec` red while held;
a mic pill under the orb driven by `micLive` ("Mic live" with a pulsing red dot, or "Mic closed. Hold to talk" / "Mic paused
while Brian speaks" / "Muted"); and on phones an "Interrupt" button under the orb while `botSpeaking` (hidden in
hold-to-talk, where pressing the button is the barge-in). The floating call pill's dot follows `micLive` too.

**Voice agent's API notes (echo and noise).** Everything below lives in `lib/voice.ts` (Table Mode) and `lib/voiceCall/*` (the Talk call).
The browser mic is now always opened with echo cancellation, noise suppression, auto gain and mono, and the call plays Brian through one
`<audio playsinline>`. Components never touch any of that; they bind to the controls below.

*Talk call* (`@/lib/voiceCall/session`). `useCall()` gained, next to the old fields:

| Field | Meaning |
|---|---|
| `pushToTalk` | Hold-to-talk is on (remembered in localStorage, shared with Table Mode). |
| `talkHeld` | The Hold button is down right now. Goes false the instant the finger lifts. |
| `halfDuplex` | Speakerphone guard on: the mic goes quiet while Brian speaks. Default ON for phones (coarse pointer or width <= 640 px), OFF elsewhere, then remembered. |
| `botSpeaking` | Brian is speaking (RTVI bot-started/stopped-speaking, plus ~0.4 s while the speaker finishes playing). |
| `micLive` | Sound is really reaching Brian: not muted, not gated by hold-to-talk or the guard. Stays true ~0.25 s after a release so the last word is not clipped. Drive every "mic is on" visual from this one flag. |
| `processing` | `null`, or what the browser reports it applied (`echoCancellation`, `noiseSuppression`, `autoGainControl`, `channelCount`, `allApplied`, `deviceLabel`). Optional badge: "Noise filter on" when `allApplied`. `null` fields mean "browser did not say" (older Safari), not "off". |

Functions: `setPushToTalk(on)`, `pressTalk()`, `releaseTalk()`, `setHalfDuplex(on)`, `interrupt()` (and the existing `toggleMute`). All are safe to call
from anywhere and idempotent; `pressTalk` does nothing unless hold-to-talk is on and a call is connecting or live. `interrupt()` re-opens the mic
at once and asks Brian to stop; it stays open until the person finishes a turn or ~12 s pass.

*Table Mode* (`@/lib/voice`). `useTableVoice()` returns `{ running, pushToTalk, held, micLive, processing }`, bound to whichever `VoiceCapture` is running
(or to the saved preference when none is), so the toggle can render before Start. Actions: `setTablePushToTalk(on)`, `pressTablePushToTalk()`,
`releaseTablePushToTalk()`; the same three exist as methods on a `VoiceCapture`. With hold-to-talk on, recognition is paused until pressed and a release
flushes what was heard as a final phrase. `useVoicePrefs()` (`@/lib/voiceCall/prefs`) returns `{ pushToTalk, halfDuplex }` anywhere, e.g. for a settings row.

*Hold button*: `<button {...holdToTalkProps(pressTalk, releaseTalk)} className={cx(HOLD_TO_TALK_CLASS, ...)}>` (from `@/lib/voiceCall/hold`; for Table Mode pass
`pressTablePushToTalk` / `releaseTablePushToTalk`). It handles pointer capture (release still arrives if the finger slides off), `pointercancel`, blur,
Space/Enter, and blocks the long-press context menu. Do not add your own `onPointerDown`/`onClick` to the same element.

*Suggested controls and copy* (use the product name from `PRODUCT_NAME` where `{name}` appears):

| Control | Where | Copy |
|---|---|---|
| Switch "Noisy room? Hold to talk" (`setPushToTalk`) | idle view of the call sheet, live footer, Table Mode header | Label: `Noisy room? Hold to talk`. Hint: `Your mic only listens while you hold the button. Best when people are talking nearby or a TV is on.` |
| Big Hold button, shown only while `pushToTalk` (replaces Mute) | call footer; Table Mode | Idle: `Hold to talk`. Held (`talkHeld`): `Listening...` (recording colour). `aria-label`: `Hold to talk. Let go when you are done.` Space/Enter work too. |
| "Interrupt" button, shown only while `botSpeaking && halfDuplex && !pushToTalk` (phones) | under the orb | `Interrupt`, hint `Tap, then talk over {name}`. In hold-to-talk the Hold button already is the interrupt. |
| Mic status pill from `micLive` | under the orb | `Mic live` / `Mic closed. Hold to talk` / `Mic paused while {name} speaks` / `Muted` (order of precedence: Muted, hold-to-talk idle, guard, live). |
| Speakerphone guard switch `halfDuplex` (`setHalfDuplex`) | call sheet menu or settings row | `Pause my mic while {name} talks`. Hint: `Stops the speaker's echo from cutting {name} off. On by default on phones. Use Interrupt to talk over.` |
| Table Mode status | Table Mode | Idle with hold-to-talk: `Paused. Hold to talk.` Consent line: `Listening only while you hold the button.` |

Two honesty notes for copy: in hold-to-talk the browser's own recording dot may stay on (the mic is open but silenced), so say "Mic closed", never "Mic off";
and nothing can cancel a second person's voice or a TV that is louder than the speaker: that is what hold-to-talk is for. Safari/iOS applies its own voice
processing and may report some settings as unknown; that is normal.

*Voice agent contract*: the two client messages `ptt` and `interrupt` are specified in `docs/contracts.md` section 8.

*Testing without the UI*: in development `window.__keystoneVoice.call` (`getCallState`, `setPushToTalk`, `pressTalk`, ...) and `.table` (`VoiceCapture`, ...) expose
the same functions (absent from production builds). Unit tests: `cd apps/web && node --test lib/voiceCall/voiceControls.test.mjs`. Browser check with fake media
devices and a faked Pipecat server: `node lib/voiceCall/e2e/check.mjs` (usage in the file header).
