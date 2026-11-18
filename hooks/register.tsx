import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { ContextReading, ContextSegment, Limit, McpServer, OrderToken, PromptMark, Reading, Section, Theme, WindowStart } from '../types'

const reading = atom({ plugin: 'usage-bars', key: 'reading' } as const, null)
const windowStart = atom({ plugin: 'usage-bars', key: 'windowStart' } as const, null)
const promptStart = atom({ plugin: 'usage-bars', key: 'promptStart' } as const, null)
const promptEnd = atom({ plugin: 'usage-bars', key: 'promptEnd' } as const, null)
const promptEndPending = atom({ plugin: 'usage-bars', key: 'promptEndPending' } as const, false)
const mcp = atom({ plugin: 'usage-bars', key: 'mcp' } as const, [])
const context = atom({ plugin: 'usage-bars', key: 'context' } as const, null)
const order = atom({ plugin: 'usage-bars', key: 'order' } as const, [])
const theme = atom({ plugin: 'usage-bars', key: 'theme' } as const, 'dark')

// The layout lives in the shared store so it survives restarts and reaches every open session within SYNC_MS.
const ORDER_KEY = 'order'
const THEME_KEY = 'theme'
const THEMES: Theme[] = ['dark', 'light']
const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme)
// State from a version without themes, or never set, reads as the default.
const readTheme = async ($: EngineInterface): Promise<Theme> => {
  const value = await read($, theme)
  return isTheme(value) ? value : 'dark'
}
const SECTIONS: Section[] = ['5h', 'week', 'fable', 'context', 'categories', 'mcp', 'caffeine']
// What an empty `order` draws.
const DEFAULT_LAYOUT: OrderToken[] = ['5h', 'week', 'mcp', '|', 'context', 'categories', 'categories']
const isSection = (value: unknown): value is Section => SECTIONS.includes(value as Section)
const isOrderToken = (value: unknown): value is OrderToken => value === '|' || isSection(value)
const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((s, i) => s === b[i])

const loadSettings = async ($: EngineInterface) => {
  const savedOrder = await $.store.get(ORDER_KEY)
  if (Array.isArray(savedOrder)) {
    const next = savedOrder.filter(isOrderToken)
    await update($, order, current => (sameList(current, next) ? current : next))
  }
  const savedTheme = await $.store.get(THEME_KEY)
  if (isTheme(savedTheme)) await update($, theme, current => (current === savedTheme ? current : savedTheme))
}

const HELP = `/usage-bars layout              show the current layout
/usage-bars layout <words>…     set the layout
/usage-bars layout reset        go back to the default layout
/usage-bars theme light|dark    colours for a light or dark editor theme
/usage-bars refresh             re-read MCP servers, context and usage limits now

Writing a layout
  Each word is one row. "c" (or "|") starts the next column.
  Repeat a section down a column to give it more rows, or on the same row of
  neighbouring columns to make it span them. Only the sections you list are shown.

Sections
  5h           5-hour limit, with the time until it resets; only what your last
               prompt used is bright, from its start to its end
  week         weekly limit, with the time until it resets; the part used
               before the current 5h window is drawn fainter
  fable        Fable limit ("—" until Claude Code reports it)
  context      context window bar, coloured by category as in /context
  categories   context categories, largest first; more rows show more of them
  mcp          MCP servers, connected or not
  caffeine     the cache-caffeine plugin, on or off (switch it with /caffeine)

Examples
  layout 5h week mcp c context categories categories      (the default)
    5h      Context
    Week    categories
    MCP     categories

  layout context 5h week c context categories mcp
    Context ──────────────
    5h      categories
    Week    MCP

  layout 5h context categories c week context categories
    5h      Week
    Context ──────────────
    categories ───────────

  layout context categories
    Context
    categories`

const describeSettings = (orderNow: readonly OrderToken[], themeNow: Theme) => {
  const effective = orderNow.length > 0 ? orderNow : DEFAULT_LAYOUT
  const notInLayout = SECTIONS.filter(s => !effective.includes(s))
  return [
    `Layout: ${effective.join(' ')}${orderNow.length > 0 ? '' : ' (default)'}.`,
    ...(notInLayout.length > 0 ? [`Not shown: ${notInLayout.join(', ')}.`] : []),
    `Theme: ${themeNow}.`,
    'Run "/usage-bars help" for how to change it.',
  ].join(' ')
}

const runCommand = async ($: EngineInterface, args: string) => {
  const [verb, ...rest] = args.replace(/\|/g, ' | ').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const current: OrderToken[] = await read($, order)
  const themeNow = await readTheme($)

  if (verb === undefined) return HELP
  if (verb === 'refresh' && rest.length === 0) return refreshAll($)
  if (verb === 'theme' && rest.length === 1 && isTheme(rest[0])) {
    const nextTheme = rest[0]
    await update($, theme, () => nextTheme)
    await $.store.set(THEME_KEY, nextTheme)
    return describeSettings(current, nextTheme)
  }
  if (verb !== 'layout') return HELP
  if (rest.length === 0) return describeSettings(current, themeNow)

  let next: OrderToken[]
  if (rest.length === 1 && rest[0] === 'reset') {
    next = []
  } else {
    // "c" is a column break too: quicker to type than "|".
    const words = rest.map(word => (word === 'c' ? '|' : word))
    const unknown = words.filter(word => !isOrderToken(word))
    if (unknown.length > 0) return `Unknown section: ${unknown.join(', ')}. Sections: ${SECTIONS.join(', ')}.`
    next = words.filter(isOrderToken)
    const problem = layoutProblem(next)
    if (problem) return `Layout not changed: ${problem}`
  }

  await update($, order, () => next)
  await $.store.set(ORDER_KEY, next)
  return describeSettings(next, themeNow)
}

// 'summary' estimates locally from the last response; 'full' would send a token-count request per tool and memory
// file on every turn, as /context does.
const refreshContext = async ($: EngineInterface) => {
  const window = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (!window) return
  const segments: ContextSegment[] = []
  for (const { name, tokens, color, kind } of window.categories) {
    if (kind !== 'deferred' && tokens > 0) segments.push({ name, tokens, color, kind })
  }
  const fresh: ContextReading = {
    segments,
    used: window.totalTokens,
    max: window.rawMaxTokens,
    percent: window.percentage,
  }
  await update($, context, () => fresh)
}

const compactTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

// Not real servers worth watching: the editor bridge and tools registered by mods.
const MCP_HIDDEN = new Set(['claude-vscode', 'plugin-authoring'])

// `mcp__<server>__<tool>` -> server; a plugin's server `plugin_<plugin>_<name>` shows as `<name>`.
const serverOf = (tool: string) => {
  const rest = tool.slice('mcp__'.length)
  const end = rest.lastIndexOf('__')
  return end > 0 ? rest.slice(0, end) : rest
}
const displayName = (server: string) => server.match(/^plugin_[^_]+_(.+)$/)?.[1] ?? server

// A mod can't read MCP connection status directly (WaitForMcpServers isn't exposed to mods), only the tools
// available now: a server with tools is connected, and one seen earlier in the session that lost them is down.
// `reset` forgets servers seen earlier, so one removed from the session drops out instead of reading "disconnected".
const refreshMcp = async ($: EngineInterface, { reset = false } = {}) => {
  const counts = new Map<string, number>()
  for (const tool of await $.tool.list()) {
    if (!tool.mcp) continue
    const server = serverOf(tool.name)
    if (!MCP_HIDDEN.has(server)) counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  await update($, mcp, previous => {
    const seen = new Set([...(reset ? [] : previous.map(s => s.name)), ...counts.keys()])
    const next: McpServer[] = [...seen]
      .map(name => ({ name, tools: counts.get(name) ?? 0, isConnected: counts.has(name) }))
      .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)))
    const isSame =
      next.length === previous.length &&
      next.every((s, i) => s.name === previous[i]?.name && s.isConnected === previous[i]?.isConnected && s.tools === previous[i]?.tools)
    return isSame ? previous : next
  })
}

const STORE_KEY = 'lastReading'
const CELLS = 12
// The Fable limit is the window the usage dialog labels "Fable limit". Claude Code doesn't always report it to mods,
// so its row is drawn with '—' until a reading has it.
const FABLE_KIND = 'seven_day_overage_included'
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week', [FABLE_KIND]: 'Fable', spend_limit: 'Spend' }
const ORDER = ['five_hour', 'seven_day', FABLE_KIND, 'spend_limit']
// Limits without a section (a gateway's spend limit) are always shown.
const SECTION_OF_KIND: Record<string, Section> = { five_hour: '5h', seven_day: 'week', [FABLE_KIND]: 'fable' }

const barCells = (percent: number) => Math.max(0, Math.min(CELLS, Math.round((percent / 100) * CELLS)))
const bar = (percent: number, span?: Span) => {
  const filled = barCells(percent)
  const from = span ? Math.min(filled, barCells(span.from)) : 0
  const to = span ? Math.min(filled, Math.max(from, barCells(span.to))) : filled
  return {
    before: '█'.repeat(from),
    span: '█'.repeat(to - from),
    after: '█'.repeat(filled - to),
    empty: '░'.repeat(CELLS - filled),
  }
}

// The VS Code /context dialog ignores the categories' theme keys and colours each non-empty, non-deferred row by its
// position among them with the webview's chart palette (--app-chart-1..8), Free space's slot included though it
// isn't drawn. A mod's Box can't use CSS variables (they drew transparent), and the mod API doesn't say whether the
// editor theme is light or dark, so each palette holds Dark+'s or Light+'s values and /usage-bars theme picks one.
type Palette = { chart: string[]; track: string; fill: string; fillHigh: string }
const PALETTES: Record<Theme, Palette> = {
  dark: {
    chart: ['#d18616', '#3794ff', '#89d185', '#cca700', '#b180d7', '#f14c4c', '#11a8cd', '#cccccc'],
    track: '#7f7f7f66', // --vscode-widget-border fallback
    fill: '#0e70c0', // --vscode-progressBar-background
    fillHigh: '#d97757', // --app-claude-orange
  },
  light: {
    chart: ['#d18616', '#1a85ff', '#388a34', '#bf8803', '#652d90', '#e51400', '#0598bc', '#616161'],
    track: '#cecece', // Light+ --vscode-input-border
    fill: '#0e70c0',
    fillHigh: '#d97757',
  },
}
const segmentFill = (palette: Palette, segment: ContextSegment, index: number) =>
  segment.kind === 'free' ? palette.track : (palette.chart[index % palette.chart.length] ?? palette.track)

const CONTEXT_CELLS = 20
// The cells every bar row shares, so bars in one column start and end at the same place. Cells count monospace
// characters. The panel's proportional font draws most letters narrower than a cell but W and M wider ("Week"
// overflowed 4 cells), so a label gets one cell of slack only when it has one; a cell for every label left visibly
// wide gaps. Digits are narrower than a cell, so the figures fit their character counts: "100%", and "6d 23h" or
// "153k/1M".
const labelCells = (label: string) => label.length + (/[WM]/.test(label) ? 1 : 0)
const PERCENT_CELLS = 4
const DETAIL_CELLS = 7
const CELL_CHAR: Record<ContextSegment['kind'], string> = { used: '█', buffer: '▒', free: '░' }

// Cumulative rounding so the cells always add up to CONTEXT_CELLS and a small row is never rounded away twice.
const contextCells = (ctx: ContextReading) => {
  const cells: { color: string; kind: ContextSegment['kind'] }[] = []
  let tokensSoFar = 0
  for (const segment of ctx.segments) {
    tokensSoFar += segment.tokens
    const end = Math.min(CONTEXT_CELLS, Math.round((tokensSoFar / ctx.max) * CONTEXT_CELLS))
    while (cells.length < end) cells.push({ color: segment.color, kind: segment.kind })
  }
  while (cells.length < CONTEXT_CELLS) cells.push({ color: 'inactive', kind: 'free' })
  return cells
}

const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')

// Graphical surfaces (VS Code, desktop, mobile) draw the bar from Boxes, styled like the extension's own
// "Account & usage" dialog: a thin track in the input-border color, a progress-bar fill, Claude orange from 80%.
// Not an Svg: the VS Code webview rasterizes an Svg in a shared queue, shows its alt text when that runs past a
// second, and bans that exact source for 5 minutes when it runs past two (a busy or backgrounded window does it).
// The bar then sat as text until the percentage moved. Boxes are plain DOM and always draw.
// Bars stretch to fill the row; this is the floor a narrow panel squeezes them to.
const MIN_BAR_WIDTH = 6
// Box heights are in line heights on these surfaces: about 6px against an 18px line.
const BAR_HEIGHT = 0.34
// Text's visual center sits below its line box's center. The row centers each item's margin box, so a top margin
// moves the bar down by half of it: about 1px.
const BAR_NUDGE = 0.11
// Height of every graphical row but the last, in line heights: 0.88 of the 18px line is about 16px (0.75 was too tight).
const ROW_HEIGHT = 0.88
// Space between grid columns, in cells.
const COLUMN_GAP = 1
const CLEAR = '#00000000'
const HIGH_AT = 80
// Alpha appended to the fill outside a bar's bright span (see limitRow): darker on a dark theme, paler on a light one,
// and still the fill's hue, unlike the grey track.
const FAINT_ALPHA = '80'

// The cache-caffeine plugin's session state, read to show it; it draws its own switch only in the terminal and the
// desktop app. Not a `dependencies` entry, which would make usage-bars require it, so its contract isn't typed here
// and the shape is checked instead. It writes `brew` only once it's switched, so no value (a new session, or the
// plugin not installed) reads as off.
type Brew = { isOn: boolean; until: number }
const CAFFEINE_BREW = { plugin: 'cache-caffeine', key: 'brew' }
const readBrew = async ($: EngineInterface): Promise<Brew> => {
  const read = (await $.state.get(CAFFEINE_BREW as never).catch(() => ({}))) as { value?: unknown }
  const value = read.value
  return typeof value === 'object' && value !== null && typeof (value as Brew).isOn === 'boolean'
    ? { isOn: (value as Brew).isOn, until: typeof (value as Brew).until === 'number' ? (value as Brew).until : 0 }
    : { isOn: false, until: 0 }
}

const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  // Reset snapped to its minute and the remainder rounded up, so the shown minutes tick over at each wall-clock
  // minute start, when the minute redraw lands, whatever second the reset falls on.
  const ms = Math.round(Date.parse(resetsAt) / 60_000) * 60_000 - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const toLimits = (rateLimits: SessionRateLimit[]): Limit[] =>
  rateLimits
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))

// The Fable row is drawn before any reading has the Fable window.
type LimitView = Limit & { isMissing?: true }

const isReading = (value: unknown): value is Reading =>
  typeof value === 'object' && value !== null && Array.isArray((value as Reading).limits) && typeof (value as Reading).at === 'number'

// A session only measures its own requests, so an idle one keeps showing what it saw last while other sessions
// spend the same plan. Every session saves its readings to the shared store; adopt a newer one from there.
const SYNC_MS = 15_000
const syncFromStore = async ($: EngineInterface) => {
  await loadSettings($)
  const savedStart = await $.store.get(WINDOW_START_KEY)
  if (isWindowStart(savedStart)) await adoptWindowStart($, savedStart)
  const saved = await $.store.get(STORE_KEY)
  if (!isReading(saved)) return
  await update($, reading, current => (current && current.at >= saved.at ? current : saved))
}

// The reset countdowns are computed while drawing, so nothing else would redraw them as time passes. Each wait is
// measured to the next wall-clock minute rather than repeated, so timer lateness never accumulates; the small offset
// keeps a slightly early firing from landing just before the boundary.
const MINUTE_MS = 60_000
const PAST_BOUNDARY_MS = 50
const redrawEachMinute = async ($: EngineInterface) => {
  const now = await $.clock.now()
  $.clock.after(MINUTE_MS - (now % MINUTE_MS) + PAST_BOUNDARY_MS, () => {
    $.ui.invalidate('ui.render')
    return redrawEachMinute($)
  })
}

// Claude Code doesn't report every window in every reading (a reading with only `seven_day` hid the 5h bar), so a
// window missing from the fresh one keeps its last value; once its reset has passed it reads 0% until reported again.
const expire = (limit: Limit, at: number): Limit =>
  limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= at ? { kind: limit.kind, percentUsed: 0 } : limit

const mergeLimits = (previous: readonly Limit[], fresh: readonly Limit[], at: number): Limit[] => {
  const reported = new Set(fresh.map(l => l.kind))
  const carried = previous.filter(l => !reported.has(l.kind)).map(l => expire(l, at))
  return [...fresh, ...carried].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

const WINDOW_START_KEY = 'windowStart'
// One window's reset time can differ by seconds between readings; two 5h windows' resets are at least 5h apart.
const SAME_RESET_MS = 30 * 60_000
const sameReset = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) < SAME_RESET_MS

const isWindowStart = (value: unknown): value is WindowStart =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as WindowStart).fiveHourResetsAt === 'string' &&
  typeof (value as WindowStart).weekResetsAt === 'string' &&
  typeof (value as WindowStart).weekPercent === 'number'

const isSameStart = (a: WindowStart | null, b: WindowStart | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.fiveHourResetsAt === b.fiveHourResetsAt &&
    a.weekResetsAt === b.weekResetsAt &&
    a.weekPercent === b.weekPercent)

const adoptWindowStart = ($: EngineInterface, value: WindowStart | null) =>
  update($, windowStart, current => (isSameStart(current, value) ? current : value))

// A 5h window opens with the first request after the previous one closed, so the last weekly figure read before a new
// window shows up is the week as it stood when that window began. Without one from the same week (first run, or the
// week reset since) the first figure inside the window stands in, which can only understate what the window added.
const nextWindowStart = (saved: WindowStart | null, previous: readonly Limit[], fresh: readonly Limit[]): WindowStart | null => {
  const fiveHour = fresh.find(l => l.kind === 'five_hour')
  const week = fresh.find(l => l.kind === 'seven_day')
  if (!fiveHour?.resetsAt || !week?.resetsAt) return saved
  if (saved && sameReset(saved.fiveHourResetsAt, fiveHour.resetsAt)) {
    // A week that reset inside this window was all used inside it.
    return sameReset(saved.weekResetsAt, week.resetsAt) ? saved : { ...saved, weekResetsAt: week.resetsAt, weekPercent: 0 }
  }
  const before = previous.find(l => l.kind === 'seven_day')
  const weekPercent = before && sameReset(before.resetsAt, week.resetsAt) ? before.percentUsed : week.percentUsed
  return { fiveHourResetsAt: fiveHour.resetsAt, weekResetsAt: week.resetsAt, weekPercent }
}

// Kept in the shared store like the readings, so every session splits the week bar at the same place.
const saveWindowStart = async ($: EngineInterface, previous: readonly Limit[], fresh: readonly Limit[]) => {
  const stored = await $.store.get(WINDOW_START_KEY)
  const saved = isWindowStart(stored) ? stored : null
  const next = nextWindowStart(saved, previous, fresh)
  if (!isSameStart(saved, next)) await $.store.set(WINDOW_START_KEY, next)
  await adoptWindowStart($, next)
}

// The share of the week used before the current 5h window; undefined when unknown, and the bar is one colour.
const weekBeforeWindow = (limits: readonly Limit[], start: WindowStart | null, now: number): number | undefined => {
  const week = limits.find(l => l.kind === 'seven_day')
  const fiveHour = limits.find(l => l.kind === 'five_hour')
  if (!week || !fiveHour || !start || !sameReset(start.weekResetsAt, week.resetsAt)) return undefined
  // No 5h window is open, so nothing in the week belongs to one.
  if (!fiveHour.resetsAt || Date.parse(fiveHour.resetsAt) <= now) return week.percentUsed
  if (!sameReset(start.fiveHourResetsAt, fiveHour.resetsAt)) return undefined
  return Math.min(start.weekPercent, week.percentUsed)
}

// The latest 5h figure: at a prompt's start, the last reading before its first request, which holds everything used
// before it; at its end, the reading of its last response. Per session, as prompts are.
const fiveHourMark = async ($: EngineInterface): Promise<PromptMark | null> => {
  const fiveHour = (await read($, reading))?.limits.find(l => l.kind === 'five_hour')
  return fiveHour
    ? { ...(fiveHour.resetsAt ? { fiveHourResetsAt: fiveHour.resetsAt } : {}), percent: fiveHour.percentUsed }
    : null
}

// Where a mark sits on the current 5h bar. One from an earlier window sits at the start: all of this one came after.
const markPosition = (mark: PromptMark, fiveHour: Limit) =>
  sameReset(mark.fiveHourResetsAt, fiveHour.resetsAt) ? Math.min(mark.percent, fiveHour.percentUsed) : 0

// The stretch of a bar to draw bright, in percent of the limit; the fill outside it is drawn faint.
type Span = { from: number; to: number }

// What this session's last prompt used of the 5h window: from its start to its end, or to now while it runs. What
// other sessions use after it ends falls past `to`. Before the first prompt none of the fill is this session's.
const fiveHourPromptSpan = (limits: readonly Limit[], start: PromptMark | null, end: PromptMark | null): Span | undefined => {
  const fiveHour = limits.find(l => l.kind === 'five_hour')
  if (!fiveHour) return undefined
  if (!start) return { from: 0, to: 0 }
  const from = markPosition(start, fiveHour)
  return { from, to: end ? Math.max(from, markPosition(end, fiveHour)) : fiveHour.percentUsed }
}

// The marks are kept in the store too, under the session's id: $.state came back empty after /reload-plugins, and a
// resumed session runs in a new process. A mark older than a 5h window sits at 0 on any current bar, so it's dropped.
const PROMPT_MARKS_KEY = 'promptMarks'
const MARKS_KEPT_MS = 6 * 60 * MINUTE_MS
type SavedMarks = { start: PromptMark | null; end: PromptMark | null; at: number }

const isMarkOrNull = (value: unknown): value is PromptMark | null =>
  value === null || (typeof value === 'object' && typeof (value as PromptMark).percent === 'number')
const isSavedMarks = (value: unknown): value is SavedMarks =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as SavedMarks).at === 'number' &&
  isMarkOrNull((value as SavedMarks).start) &&
  isMarkOrNull((value as SavedMarks).end)
const savedMarksOf = (stored: unknown): [string, SavedMarks][] =>
  typeof stored === 'object' && stored !== null
    ? Object.entries(stored).filter((entry): entry is [string, SavedMarks] => isSavedMarks(entry[1]))
    : []

const setPromptMarks = async ($: EngineInterface, start: PromptMark | null, end: PromptMark | null) => {
  await update($, promptStart, () => start)
  await update($, promptEnd, () => end)
  const now = await $.clock.now()
  const kept = savedMarksOf(await $.store.get(PROMPT_MARKS_KEY)).filter(([, marks]) => now - marks.at < MARKS_KEPT_MS)
  await $.store.set(PROMPT_MARKS_KEY, { ...Object.fromEntries(kept), [await $.session.id()]: { start, end, at: now } })
}

// Whether any of the session's agents is still at work, leaving out the one whose turn just ended. An idle teammate
// waits for a message and isn't.
const isAgentWorking = async ($: EngineInterface, except?: string) =>
  (await $.agent.list().catch(() => [])).some(
    agent => agent.id !== except && (agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting'),
  )

const restorePromptMarks = async ($: EngineInterface) => {
  if (await read($, promptStart)) return
  const id = await $.session.id()
  const saved = savedMarksOf(await $.store.get(PROMPT_MARKS_KEY)).find(([sessionId]) => sessionId === id)?.[1]
  if (!saved) return
  await update($, promptStart, () => saved.start)
  await update($, promptEnd, () => saved.end)
}

const saveReading = async ($: EngineInterface, measured: Reading) => {
  const previous = (await read($, reading))?.limits ?? []
  const fresh: Reading = { limits: mergeLimits(previous, measured.limits, measured.at), at: measured.at }
  await update($, reading, () => fresh)
  const saved = await $.store.get(STORE_KEY)
  if (!isReading(saved) || saved.at <= fresh.at) await $.store.set(STORE_KEY, fresh)
  await saveWindowStart($, previous, fresh.limits)
}

// Readings arrive with this session's API responses and, through the store, other sessions'. While every session is
// idle none arrive, though the plan may be in use elsewhere (claude.ai, another machine), so once the newest reading is
// STALE_MS old one session asks the endpoint Claude Code's /usage reads. A claim in the store keeps the other open
// sessions from asking too.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_BETA = 'oauth-2025-04-20'
// The windows the endpoint reports as the response headers do; its other keys (per-model weekly windows, extra
// usage) have no bar.
const FETCHED_KINDS = ['five_hour', 'seven_day']
const STALE_MS = 2 * MINUTE_MS
// After a failed request: a window opened moments ago may not have refreshed its credential yet.
const RETRY_MS = 30_000
const RATE_LIMITED_MS = 10 * MINUTE_MS
const CLAIM_KEY = 'fetchClaimedUntil'

type UsageWindow = { utilization?: unknown; resets_at?: unknown } | null | undefined

// `utilization` is a percentage; a window that isn't running has no `resets_at`.
const parseUsage = (text: string): Limit[] => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof body !== 'object' || body === null) return []
  return FETCHED_KINDS.flatMap(kind => {
    const window = (body as Record<string, UsageWindow>)[kind]
    if (!window || typeof window.utilization !== 'number') return []
    const resetsAt = typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}
    return [{ kind, percentUsed: window.utilization, ...resetsAt }]
  })
}

// Resolves the HTTP status, 0 when the request didn't complete.
const fetchUsage = async ($: EngineInterface, auth: string): Promise<number> => {
  try {
    const response = await $.http.fetch(USAGE_URL, { auth, headers: { 'anthropic-beta': USAGE_BETA } })
    const limits = response.ok ? parseUsage(response.text) : []
    if (limits.length > 0) await saveReading($, { limits, at: await $.clock.now() })
    return response.status
  } catch {
    return 0
  }
}

const refreshUsage = async ($: EngineInterface, now: number): Promise<number | undefined> => {
  // Plan windows exist only behind a subscription login; an API key or another provider has none to ask about.
  const credential = await $.session.authorize()
  if (credential?.kind !== 'bearer') return undefined
  await $.store.set(CLAIM_KEY, now + STALE_MS)
  const status = await fetchUsage($, credential.handle)
  if (status === 429) await $.store.set(CLAIM_KEY, now + RATE_LIMITED_MS)
  else if (status < 200 || status >= 300) await $.store.set(CLAIM_KEY, now + RETRY_MS)
  return status
}

const refreshIfStale = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const newest = await read($, reading)
  if (newest && now - newest.at < STALE_MS) return
  const claimedUntil = await $.store.get(CLAIM_KEY)
  if (typeof claimedUntil === 'number' && now < claimedUntil) return
  await refreshUsage($, now)
}

const refreshAll = async ($: EngineInterface) => {
  await refreshMcp($, { reset: true })
  await refreshContext($)
  const status = await refreshUsage($, await $.clock.now())
  const usage =
    status === undefined
      ? 'Usage limits: no subscription login to ask with.'
      : status >= 200 && status < 300
        ? 'Usage limits refreshed.'
        : `Usage limits not refreshed (${status === 0 ? 'request failed' : `HTTP ${status}`}); showing the last reading.`
  return `MCP servers and context refreshed. ${usage}`
}

// The layout is a grid: each "|" starts a column, each word is one row of it. A section written in consecutive rows
// of a column, or on the same row of neighbouring columns, spans those cells.
type Cell = Section | null
type Grid = Cell[][] // [row][column]
type Rect = { r0: number; r1: number; c0: number; c1: number } // half-open
type LayoutNode =
  | { kind: 'leaf'; section: Cell; rect: Rect }
  | { kind: 'bands'; children: LayoutNode[] }
  | { kind: 'stripes'; children: { node: LayoutNode; c0: number; c1: number }[] }

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)

const toGrid = (tokens: readonly OrderToken[]): Grid => {
  const columns: Section[][] = [[]]
  for (const token of tokens) {
    if (token === '|') columns.push([])
    else columns[columns.length - 1]?.push(token)
  }
  const used = columns.filter(column => column.length > 0)
  const rows = Math.max(0, ...used.map(column => column.length))
  return range(0, rows).map(r => used.map(column => column[r] ?? null))
}

const spanProblem = (grid: Grid): string | undefined => {
  const boxes = new Map<Section, Rect & { count: number }>()
  grid.forEach((row, r) =>
    row.forEach((section, c) => {
      if (!section) return
      const box = boxes.get(section)
      boxes.set(
        section,
        box
          ? {
              r0: Math.min(box.r0, r),
              r1: Math.max(box.r1, r + 1),
              c0: Math.min(box.c0, c),
              c1: Math.max(box.c1, c + 1),
              count: box.count + 1,
            }
          : { r0: r, r1: r + 1, c0: c, c1: c + 1, count: 1 },
      )
    }),
  )
  for (const [section, box] of boxes) {
    if ((box.r1 - box.r0) * (box.c1 - box.c0) !== box.count) {
      return `"${section}" doesn't form a rectangle. A section spans by being repeated in consecutive rows of one column, or on the same row of neighbouring columns.`
    }
  }
  return undefined
}

// Splits the grid into bands (rows) wherever no span crosses between them, else into stripes (columns), and recurses,
// so rows stay level across columns. Null when spans interlock and no straight cut exists (a pinwheel).
const splitGrid = (grid: Grid, rect: Rect): LayoutNode | null => {
  const id = (r: number, c: number) => grid[r]?.[c] ?? `empty ${r} ${c}`
  const { r0, r1, c0, c1 } = rect
  const first = id(r0, c0)
  if (range(r0, r1).every(r => range(c0, c1).every(c => id(r, c) === first))) {
    return { kind: 'leaf', section: grid[r0]?.[c0] ?? null, rect }
  }
  const rowCuts = range(r0 + 1, r1).filter(k => range(c0, c1).every(c => id(k - 1, c) !== id(k, c)))
  if (rowCuts.length > 0) {
    const edges = [r0, ...rowCuts, r1]
    const children = range(0, edges.length - 1).map(i => splitGrid(grid, { r0: edges[i] ?? r0, r1: edges[i + 1] ?? r1, c0, c1 }))
    return children.every(child => child !== null) ? { kind: 'bands', children: children as LayoutNode[] } : null
  }
  const columnCuts = range(c0 + 1, c1).filter(k => range(r0, r1).every(r => id(r, k - 1) !== id(r, k)))
  if (columnCuts.length > 0) {
    const edges = [c0, ...columnCuts, c1]
    const children = range(0, edges.length - 1).map(i => {
      const from = edges[i] ?? c0
      const to = edges[i + 1] ?? c1
      const node = splitGrid(grid, { r0, r1, c0: from, c1: to })
      return node ? { node, c0: from, c1: to } : null
    })
    return children.every(child => child !== null)
      ? { kind: 'stripes', children: children as { node: LayoutNode; c0: number; c1: number }[] }
      : null
  }
  return null
}

const layoutProblem = (tokens: readonly OrderToken[]): string | undefined => {
  const grid = toGrid(tokens)
  const problem = spanProblem(grid)
  if (problem) return problem
  const width = grid[0]?.length ?? 0
  if (grid.length > 0 && !splitGrid(grid, { r0: 0, r1: grid.length, c0: 0, c1: width })) {
    return 'These spans interlock, so the layout has no straight row or column to split along. Make one span shorter.'
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'usage-bars',
      description: 'Show or set the usage-bars layout, or refresh what it shows',
      argumentHint: '[layout <section>… c <section>… | layout reset | theme light|dark | refresh | help]',
      immediate: true,
    })

    await syncFromStore($)
    await restorePromptMarks($)
    // Before this session's first response the engine's figures may be old, so they stand in only when nothing else
    // is known, dated 0 so that the refresh replaces them.
    const { rateLimits } = await $.session.usage()
    if (rateLimits.length > 0 && !(await read($, reading))) {
      await saveReading($, { limits: toLimits(rateLimits), at: 0 })
    }
    $.clock.every(SYNC_MS, async () => {
      await syncFromStore($)
      await refreshIfStale($)
      await refreshMcp($)
    })
    // Not awaited here: the request would hold up the session's start.
    $.clock.after(0, () => refreshIfStale($))
    redrawEachMinute($)

    await refreshMcp($)
    await refreshContext($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await saveReading($, { limits: toLimits(e.rateLimits), at: await $.clock.now() })
    }

    const result = await next(e)
    if (e.changed.includes('context')) await refreshContext($)
    return result
  })

  // Servers also connect and drop between turns (/mcp, /reload-plugins); the SYNC_MS timer catches those.
  on('turn.start', async ($, e, next) => {
    await syncFromStore($)
    if (e.agentId === undefined) {
      // Typed prompts only move the start: a continuation is part of the prompt that started it, and runs again. So is
      // a prompt sent while the last one's subagents still work: the span goes on from where that one began.
      const current = await read($, promptStart)
      const isLastStillWorking = current !== null && ((await read($, promptEndPending)) === true || (await isAgentWorking($)))
      const start = e.text !== '' && !isLastStillWorking ? await fiveHourMark($) : current
      await update($, promptEndPending, () => false)
      await setPromptMarks($, start, null)
    }
    await refreshMcp($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent still at work when the main turn ends (a background one, or one sent to the background) is part of
    // the prompt, so the end waits for the last of them.
    const endPrompt = async () => {
      await update($, promptEndPending, () => false)
      await setPromptMarks($, await read($, promptStart), await fiveHourMark($))
    }
    if (e.agentId === undefined) {
      if (await isAgentWorking($)) await update($, promptEndPending, () => true)
      else await endPrompt()
    } else if ((await read($, promptEndPending)) === true && !(await isAgentWorking($, e.agentId))) {
      await endPrompt()
    }
    await refreshMcp($)
    return result
  })

  on('command.run', { command: 'usage-bars' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, reading)
    const servers = await read($, mcp)
    const ctx = await read($, context)
    if (e.props.hasSurvey || (!current && servers.length === 0 && !ctx)) {
      return next(e)
    }
    const savedOrder = await read($, order)
    // A layout saved before spans existed may break their rules (a section written twice apart); draw the default.
    const tokens: OrderToken[] = savedOrder.length > 0 && !layoutProblem(savedOrder) ? savedOrder : DEFAULT_LAYOUT

    const palette = PALETTES[await readTheme($)]
    const now = await $.clock.now()
    const brew = await readBrew($)
    const { Box, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'

    // Cells line labels, bars and figures up down each column. A minimum, not a fixed width: the panel's proportional
    // font makes text like "2h 13m" wider than its character count, and a fixed width wrapped it onto a second line.
    const cell = (minWidth: number, text: string, dim = false, key?: string) => (
      <Box key={key} minWidth={minWidth} flexShrink={0}>
        <Text dimColor={dim} wrap="truncate-end">{text}</Text>
      </Box>
    )

    // `borderStyle="round"` is the only way to round a Box's corners on graphical surfaces. The border is transparent
    // and the outer Box only clips: the webview sizes Boxes content-box, so a visible border would add 2px outside
    // BAR_HEIGHT. Segments sit side by side inside it, the same height, none drawn over another.
    const track = (children: RenderChildren) => (
      <Box
        width={0}
        flexGrow={1}
        flexShrink={1}
        minWidth={MIN_BAR_WIDTH}
        height={BAR_HEIGHT}
        marginTop={BAR_NUDGE}
        borderStyle="round"
        borderColor={CLEAR}
        overflow="hidden"
      >
        {children}
      </Box>
    )

    // `span`: the stretch drawn bright (the current 5h window for the week, the last prompt for the 5h window); the
    // fill before and after it is drawn faint. Without one the whole fill is bright.
    const limitRow = (limit: LimitView, labelCells: number, span?: Span) => {
      const label = cell(labelCells, LABELS[limit.kind] ?? limit.kind, true)
      if (limit.isMissing) {
        return (
          <Box key={limit.kind} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
            {label}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor>—</Text>
            </Box>
          </Box>
        )
      }
      // The dialog floors the percentage; match it so both show the same number.
      const percent = `${Math.floor(limit.percentUsed)}%`
      const filled = Math.max(0, Math.min(100, Math.round(limit.percentUsed)))
      const from = span ? Math.max(0, Math.min(filled, Math.round(span.from))) : 0
      const to = span ? Math.max(from, Math.min(filled, Math.round(span.to))) : filled
      const fill = filled >= HIGH_AT ? palette.fillHigh : palette.fill
      const faint = `${fill}${FAINT_ALPHA}`
      const color = colorFor(limit.percentUsed)
      const cells = bar(limit.percentUsed, span)
      return (
        <Box key={limit.kind} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
          {label}
          {isTerminal ? (
            <Text color={color}>
              <Text color={color} dimColor>{cells.before}</Text>
              {cells.span}
              <Text color={color} dimColor>{cells.after}</Text>
              {cells.empty}
            </Text>
          ) : (
            track([
              from > 0 ? <Box key="before" width={`${from}%`} height="100%" backgroundColor={faint} /> : null,
              to > from ? <Box key="fill" width={`${to - from}%`} height="100%" backgroundColor={fill} /> : null,
              filled > to ? <Box key="after" width={`${filled - to}%`} height="100%" backgroundColor={faint} /> : null,
              <Box key="rest" flexGrow={1} height="100%" backgroundColor={palette.track} />,
            ])
          )}
          {cell(PERCENT_CELLS, percent)}
          {cell(DETAIL_CELLS, untilReset(limit.resetsAt, now), true)}
        </Box>
      )
    }

    const contextRow = (ctx: ContextReading, labelCells: number) => (
      <Box key="context" flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
        {cell(labelCells, 'Context', true)}
        {isTerminal ? (
          <Text>
            {contextCells(ctx).map(c => (
              <Text color={c.color} dimColor={c.kind === 'free'}>{CELL_CHAR[c.kind]}</Text>
            ))}
          </Text>
        ) : (
          // Sized by flexGrow in thousandths of the window: the webview refuses a fractional percentage width and a
          // flexGrow over 10000, and whole percentages would round small rows away.
          track(
            ctx.segments.map((segment, i) => (
              <Box
                key={`seg-${i}`}
                width={0}
                flexGrow={Math.min(10000, Math.round((segment.tokens / ctx.max) * 1000))}
                height="100%"
                backgroundColor={segmentFill(palette, segment, i)}
              />
            )),
          )
        )}
        {cell(PERCENT_CELLS, `${ctx.percent}%`)}
        {cell(DETAIL_CELLS, `${compactTokens(ctx.used)}/${compactTokens(ctx.max)}`, true)}
      </Box>
    )

    const caffeineRow = (state: Brew, labelCells: number) => {
      // `until` is 0 while caffeine runs until it's switched off or goes idle.
      const left = state.isOn && state.until > now ? untilReset(new Date(state.until).toISOString(), now) : ''
      return (
        <Box key="caffeine" flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
          {cell(labelCells, 'Caffeine', true)}
          <Text color={state.isOn ? 'success' : undefined} dimColor={!state.isOn}>●</Text>
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor={!state.isOn} wrap="truncate-end">{left ? `on · ${left} left` : state.isOn ? 'on' : 'off'}</Text>
          </Box>
        </Box>
      )
    }

    const mcpRow = (labelCells: number) => (
      <Box key="mcp" flexDirection="row" flexWrap="nowrap" gap={1}>
        {cell(labelCells, 'MCP', true)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={1}>
          {servers.map(server => (
            <Box key={`mcp-${server.name}`} flexDirection="row" gap={1} flexShrink={0}>
              <Text color={server.isConnected ? 'success' : 'error'}>●</Text>
              <Text dimColor={server.isConnected}>
                {server.isConnected ? displayName(server.name) : `${displayName(server.name)} (disconnected)`}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )

    // The /context dialog's legend, largest category first, in exactly `lines` lines: what doesn't fit is cut off, so
    // the smallest go first. Free space is left out as the dialog leaves it out; each swatch keeps the colour of its
    // segment in the bar. It starts at the column's left edge, not under the bar, to fit more categories per line.
    // Its lines are packed as tightly as the other rows (ROW_HEIGHT each, the last a full line so its text isn't
    // clipped), so it stays level with the column beside it.
    const categoriesRow = (ctx: ContextReading, lines: number) => {
      const entries = ctx.segments
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment }) => segment.kind !== 'free')
        .sort((a, b) => b.segment.tokens - a.segment.tokens)
      return (
        <Box key="categories" flexDirection="row" flexWrap="nowrap">
          <Box
            flexDirection="row"
            flexWrap="wrap"
            columnGap={2}
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            height={isTerminal ? lines : (lines - 1) * ROW_HEIGHT + 1}
            overflow="hidden"
          >
            {entries.map(({ segment, index }) => (
              <Box
                key={`category-${index}`}
                flexDirection="row"
                gap={1}
                flexShrink={0}
                alignItems="flex-start"
                height={isTerminal ? undefined : ROW_HEIGHT}
              >
                {/* A glyph, not a Box: it sits on the text line by itself, where a Box sized in line heights stretched
                    and sat off the text's centre. */}
                <Text color={isTerminal ? segment.color : segmentFill(palette, segment, index)}>●</Text>
                <Text dimColor>{segment.name}</Text>
                <Text>{compactTokens(segment.tokens)}</Text>
                <Text dimColor>{`${((segment.tokens / ctx.max) * 100).toFixed(1)}%`}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // What each section draws, given its column's label width and the rows its cell spans; a section with nothing to
    // show (no context yet, no MCP servers) has none and its cells stay empty.
    type Block = { label: string; draw: (labelCells: number, rows: number) => RenderChildren }
    // A window whose reset has passed since the reading is empty now, whatever it last read.
    const limits: Limit[] = (current?.limits ?? []).map(l => expire(l, now))
    const weekBefore = weekBeforeWindow(limits, await read($, windowStart), now)
    const week = limits.find(l => l.kind === 'seven_day')
    const weekSpan = weekBefore !== undefined && week ? { from: weekBefore, to: week.percentUsed } : undefined
    const fiveHourSpan = fiveHourPromptSpan(limits, await read($, promptStart), await read($, promptEnd))
    const limitBlock = (kind: string): Block => {
      const limit: LimitView = limits.find(l => l.kind === kind) ?? { kind, percentUsed: 0, isMissing: true }
      const span = kind === 'seven_day' ? weekSpan : kind === 'five_hour' ? fiveHourSpan : undefined
      return { label: LABELS[kind] ?? kind, draw: labelCells => limitRow(limit, labelCells, span) }
    }
    const blockOf = (section: Section): Block | null => {
      switch (section) {
        case '5h':
          return limitBlock('five_hour')
        case 'week':
          return limitBlock('seven_day')
        case 'fable':
          return limitBlock(FABLE_KIND)
        case 'context':
          return ctx ? { label: 'Context', draw: cells => contextRow(ctx, cells) } : null
        case 'categories':
          return ctx ? { label: '', draw: (_, rows) => categoriesRow(ctx, rows) } : null
        case 'mcp':
          return servers.length > 0 ? { label: 'MCP', draw: cells => mcpRow(cells) } : null
        case 'caffeine':
          return { label: 'Caffeine', draw: cells => caffeineRow(brew, cells) }
      }
    }
    const blocks = new Map<Section, Block>()
    for (const section of SECTIONS) {
      const block = blockOf(section)
      if (block) blocks.set(section, block)
    }

    // A section with nothing to show yet (MCP before its servers connect, context before the first response) keeps its
    // cells, empty: the panel's height depends on the layout alone. While Claude works the extension freezes the
    // height of the area above the prompt, so a row appearing mid-turn pushed the frame's bottom edge out of view.
    const grid = toGrid(tokens).map(row => row.map(cell => (cell && blocks.has(cell) ? cell : null)))
    // Windows with no section of their own (a gateway's spend limit) get full-width rows under the grid.
    const extraLimits = limits.filter(l => SECTION_OF_KIND[l.kind] === undefined)
    const width = grid[0]?.length ?? 0
    const hasContent = grid.some(row => row.some(cell => cell !== null)) || extraLimits.length > 0
    if (!hasContent) return next(e)
    const root = grid.length > 0 ? splitGrid(grid, { r0: 0, r1: grid.length, c0: 0, c1: width }) : null

    // Labels line up down each grid column, spanning sections included, so every bar starting in a column starts at
    // the same x: the column's label cell fits the longest label of the sections that start in it.
    const firstColumn = new Map<Section, number>()
    grid.forEach(row => row.forEach((cell, c) => cell && !firstColumn.has(cell) && firstColumn.set(cell, c)))
    const labelCellsAt = range(0, Math.max(width, 1)).map(c =>
      Math.max(
        0,
        ...[...firstColumn].filter(([, at]) => at === c).map(([section]) => labelCells(blocks.get(section)?.label ?? '')),
      ),
    )

    // Graphical rows are a full text line tall but each cell gets ROW_HEIGHT per row, so the next starts sooner, the
    // text overflowing downward into the gap (a negative margin was ignored there). Inside, the content box is as tall
    // as its text and clips what doesn't fit: the categories or MCP list past its rows, a bar squeezed past its width.
    // Column boxes share the width by span alone, and the space between columns is padding on each cell that doesn't
    // end at the right edge. Padding on the column boxes was taken out before the width was shared, so a row split in
    // three put its boundaries a gap's share off from a row split in two. The terminal only has whole rows.
    const rowsHeight = (rows: number) => (isTerminal ? rows : rows * ROW_HEIGHT)
    const contentHeight = (rows: number) => (isTerminal ? rows : (rows - 1) * ROW_HEIGHT + 1)
    const drawNode = (node: LayoutNode, key: string): RenderChildren => {
      if (node.kind === 'leaf') {
        const rows = node.rect.r1 - node.rect.r0
        const block = node.section ? blocks.get(node.section) : undefined
        return (
          <Box key={key} flexDirection="column" height={rowsHeight(rows)} paddingRight={node.rect.c1 < width ? COLUMN_GAP : 0}>
            {block ? (
              <Box flexDirection="column" height={contentHeight(rows)} overflow="hidden">
                {block.draw(labelCellsAt[node.rect.c0] ?? 0, rows)}
              </Box>
            ) : null}
          </Box>
        )
      }
      if (node.kind === 'bands') {
        return (
          <Box key={key} flexDirection="column">
            {node.children.map((child, i) => drawNode(child, `${key}.${i}`))}
          </Box>
        )
      }
      return (
        <Box key={key} flexDirection="row" flexWrap="nowrap">
          {node.children.map(({ node: child, c0, c1 }) => (
            <Box
              key={`column-${c0}`}
              flexDirection="column"
              width={0}
              flexGrow={c1 - c0}
              flexShrink={1}
              minWidth={0}
            >
              {drawNode(child, `${key}.${c0}`)}
            </Box>
          ))}
        </Box>
      )
    }

    // The panel is a whole number of lines tall. Packed rows make its natural height fractional (3 rows: 2.76 lines),
    // and where that fraction lands decides whether the frame's inside, rounded to a pixel, paints over the frame's
    // bottom border line: it did for some layouts and not others. Rounding up to a whole line keeps the edge in every
    // layout, at the cost of up to a line's fraction of blank space under the last row. The root clips: the last
    // row's text runs past its packed box into that space, and nothing may run past the root.
    const lines = grid.length + extraLimits.length
    const panelHeight = isTerminal ? undefined : Math.ceil(lines > 0 ? (lines - 1) * ROW_HEIGHT + 1 : 0)
    return (
      <Box key={`grid-${width}-columns`} width="100%" height={panelHeight} flexDirection="column" overflow="hidden">
        {root ? drawNode(root, 'cell') : null}
        {extraLimits.map(limit => (
          <Box key={`extra-${limit.kind}`} height={rowsHeight(1)}>
            {limitRow(limit, labelCellsAt[0] ?? 0)}
          </Box>
        ))}
      </Box>
    )
  })
}
