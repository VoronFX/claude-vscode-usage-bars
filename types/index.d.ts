export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { limits: Limit[]; at: number }

/** One MCP server: connected while it has tools; seen earlier and gone now is `isConnected: false`. */
export type McpServer = { name: string; tools: number; isConnected: boolean }

/** One /context category row: `color` is its theme key; deferred rows are dropped since they sit outside the window. */
export type ContextSegment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

/** Measured against the compaction window `max`, as /context does, so `percent` matches it. */
export type ContextReading = { segments: ContextSegment[]; used: number; max: number; percent: number }

/** What `/usage-bars layout` places. */
export type Section = '5h' | 'week' | 'fable' | 'context' | 'categories' | 'mcp'

/**
 * One word of a stored layout: a section, or `|` to start the next column (typed as `c` or `|`). A section repeated
 * down a column or across a row spans those cells.
 */
export type OrderToken = Section | '|'

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      reading: Reading | null
      mcp: McpServer[]
      context: ContextReading | null
      /** The layout as typed; empty is the default layout. */
      order: OrderToken[]
    }
  }
}
