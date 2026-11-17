export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { limits: Limit[]; at: number }

/**
 * The weekly percentage when the 5h window ending at `fiveHourResetsAt` began, so the week bar can set apart what
 * that window added. `weekResetsAt` is the week it was measured in: a week that resets mid-window starts again at 0.
 */
export type WindowStart = { fiveHourResetsAt: string; weekResetsAt: string; weekPercent: number }

/**
 * The 5h percentage when this session's last prompt started or ended, so the 5h bar can set apart what it used.
 * `fiveHourResetsAt` is the window it was measured in, absent when none was open: a later window starts again at 0.
 */
export type PromptMark = { fiveHourResetsAt?: string; percent: number }

/** One MCP server: connected while it has tools; seen earlier and gone now is `isConnected: false`. */
export type McpServer = { name: string; tools: number; isConnected: boolean }

/** One /context category row: `color` is its theme key; deferred rows are dropped since they sit outside the window. */
export type ContextSegment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

/** Measured against the compaction window `max`, as /context does, so `percent` matches it. */
export type ContextReading = { segments: ContextSegment[]; used: number; max: number; percent: number }

/** What `/usage-bars layout` places. */
export type Section = '5h' | 'week' | 'fable' | 'context' | 'categories' | 'mcp' | 'caffeine'

/**
 * One word of a stored layout: a section, or `|` to start the next column (typed as `c` or `|`). A section repeated
 * down a column or across a row spans those cells.
 */
export type OrderToken = Section | '|'

/** Which palette the graphical bars use: the mod can't detect the editor theme, so `/usage-bars theme` sets it. */
export type Theme = 'dark' | 'light'

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      reading: Reading | null
      windowStart: WindowStart | null
      promptStart: PromptMark | null
      /** Null while the prompt runs. */
      promptEnd: PromptMark | null
      mcp: McpServer[]
      context: ContextReading | null
      /** The layout as typed; empty is the default layout. */
      order: OrderToken[]
      /** The palette for graphical surfaces; `dark` until set. */
      theme: Theme
    }
  }
}
