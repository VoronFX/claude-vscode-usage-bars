import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionRateLimit } from 'claude-code'

import type { ContextReading, ContextSegment, Limit, McpServer, Reading } from '../types'

const reading = atom({ plugin: 'claude-vscode-usage-bars', key: 'reading' } as const, null)
const mcp = atom({ plugin: 'claude-vscode-usage-bars', key: 'mcp' } as const, [])
const context = atom({ plugin: 'claude-vscode-usage-bars', key: 'context' } as const, null)

// 'summary' estimates locally from the last response; 'full' would send a token-count request per tool and memory
// file on every turn, as /context does.
const refreshContext = async ($: EngineInterface) => {
  const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
  if (!breakdown) return
  const segments: ContextSegment[] = []
  for (const { name, tokens, color, kind } of breakdown.categories) {
    if (kind !== 'deferred' && tokens > 0) segments.push({ name, tokens, color, kind })
  }
  const fresh: ContextReading = {
    segments,
    used: breakdown.totalTokens,
    max: breakdown.rawMaxTokens,
    percent: breakdown.percentage,
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
const refreshMcp = async ($: EngineInterface) => {
  const counts = new Map<string, number>()
  for (const tool of await $.tool.list()) {
    if (!tool.mcp) continue
    const server = serverOf(tool.name)
    if (!MCP_HIDDEN.has(server)) counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  await update($, mcp, previous => {
    const seen = new Set([...previous.map(s => s.name), ...counts.keys()])
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
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week', spend_limit: 'Spend' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

const bar = (percent: number) => {
  const filled = Math.max(0, Math.min(CELLS, Math.round((percent / 100) * CELLS)))
  return '█'.repeat(filled) + '░'.repeat(CELLS - filled)
}

// The VS Code /context dialog ignores the categories' theme keys and colours each non-empty, non-deferred row by its
// position among them with the webview's chart palette (--app-chart-1..8), Free space's slot included though it
// isn't drawn. A mod's Box can't use CSS variables (they drew transparent), so these are Dark+'s values for them.
const CHART_COLORS = ['#d18616', '#3794ff', '#89d185', '#cca700', '#b180d7', '#f14c4c', '#11a8cd', '#cccccc']
const segmentFill = (segment: ContextSegment, index: number) =>
  segment.kind === 'free' ? TRACK : (CHART_COLORS[index % CHART_COLORS.length] ?? TRACK)

const CONTEXT_CELLS = 20
// Widest content of each aligned cell: "Spend", "Context", "100%", "6d 23h".
const LEFT_LABEL_CELLS = 5
const RIGHT_LABEL_CELLS = 7
const PERCENT_CELLS = 4
const RESET_CELLS = 6
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
const TRACK = '#7f7f7f66' // --vscode-widget-border fallback
const CLEAR = '#00000000'
const FILL = '#0e70c0' // VS Code's default --vscode-progressBar-background
const FILL_HIGH = '#d97757' // --app-claude-orange
const HIGH_AT = 80

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

const isReading = (value: unknown): value is Reading =>
  typeof value === 'object' && value !== null && Array.isArray((value as Reading).limits) && typeof (value as Reading).at === 'number'

// A session only measures its own requests, so an idle one keeps showing what it saw last while other sessions
// spend the same plan. Every session saves its readings to the shared store; adopt a newer one from there.
const SYNC_MS = 15_000
const syncFromStore = async ($: EngineInterface) => {
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

const saveReading = async ($: EngineInterface, fresh: Reading) => {
  await update($, reading, () => fresh)
  const saved = await $.store.get(STORE_KEY)
  if (!isReading(saved) || saved.at <= fresh.at) await $.store.set(STORE_KEY, fresh)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    const { rateLimits } = await $.session.usage()
    if (rateLimits.length > 0) {
      await saveReading($, { limits: toLimits(rateLimits), at: await $.clock.now() })
    }
    // Also covers a session with no reading yet, so the bars are there from the start.
    await syncFromStore($)
    $.clock.every(SYNC_MS, () => syncFromStore($))
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

  // Servers connect and drop between turns too, but a turn boundary is the cheapest regular moment to look.
  on('turn.start', async ($, e, next) => {
    await syncFromStore($)
    await refreshMcp($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshMcp($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, reading)
    const limits = current?.limits ?? []
    const servers = await read($, mcp)
    const ctx = await read($, context)
    if (e.props.hasSurvey || (limits.length === 0 && servers.length === 0 && !ctx)) {
      return next(e)
    }

    const now = await $.clock.now()
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

    const limitRow = (limit: Limit) => {
      // The dialog floors the percentage; match it so both show the same number.
      const percent = `${Math.floor(limit.percentUsed)}%`
      const filled = Math.max(0, Math.min(100, Math.round(limit.percentUsed)))
      return (
        <Box key={limit.kind} flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
          {cell(LEFT_LABEL_CELLS, LABELS[limit.kind] ?? limit.kind, true)}
          {isTerminal ? (
            <Text color={colorFor(limit.percentUsed)}>{bar(limit.percentUsed)}</Text>
          ) : (
            track([
              filled > 0 ? <Box key="fill" width={`${filled}%`} height="100%" backgroundColor={filled >= HIGH_AT ? FILL_HIGH : FILL} /> : null,
              <Box key="rest" flexGrow={1} height="100%" backgroundColor={TRACK} />,
            ])
          )}
          {cell(PERCENT_CELLS, percent)}
          {cell(RESET_CELLS, untilReset(limit.resetsAt, now), true)}
        </Box>
      )
    }

    const contextRow = (ctx: ContextReading) => (
      <Box key="context" flexDirection="row" flexWrap="nowrap" gap={1} alignItems="center">
        {cell(RIGHT_LABEL_CELLS, 'Context', true)}
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
                backgroundColor={segmentFill(segment, i)}
              />
            )),
          )
        )}
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Text>{`${ctx.percent}%`}</Text>
          <Text dimColor>{`${compactTokens(ctx.used)}/${compactTokens(ctx.max)}`}</Text>
        </Box>
      </Box>
    )

    const mcpRow = (
      <Box key="mcp" flexDirection="row" flexWrap="nowrap" gap={1}>
        {cell(RIGHT_LABEL_CELLS, 'MCP', true)}
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

    // Graphical rows are a full text line tall; every row but the last gets a shorter box so the next one starts
    // sooner, its text overflowing downward into the gap. A negative margin was ignored there. The terminal only has
    // whole rows.
    const column = (key: string, rows: RenderChildren[]) => (
      <Box key={key} flexDirection="column" width={0} flexGrow={1} flexShrink={1} overflow="hidden">
        {rows.map((row, i) => (
          <Box
            key={`row-${i}`}
            flexDirection="column"
            height={!isTerminal && i < rows.length - 1 ? ROW_HEIGHT : undefined}
          >
            {row}
          </Box>
        ))}
      </Box>
    )

    const left = limits.map(limitRow)
    const right = [ctx ? contextRow(ctx) : null, servers.length > 0 ? mcpRow : null].filter(row => row !== null)

    return (
      <Box width="100%" flexDirection="row" flexWrap="nowrap" gap={3} overflow="hidden">
        {left.length > 0 ? column('limits', left) : null}
        {right.length > 0 ? column('session', right) : null}
      </Box>
    )
  })
}
