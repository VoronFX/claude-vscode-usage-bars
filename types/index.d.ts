export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { limits: Limit[]; at: number }

/** One MCP server: connected while it has tools; seen earlier and gone now is `isConnected: false`. */
export type McpServer = { name: string; tools: number; isConnected: boolean }

/** One /context category row: `color` is its theme key; deferred rows are dropped since they sit outside the window. */
export type ContextSegment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

/** Measured against the compaction window `max`, as /context does, so `percent` matches it. */
export type ContextReading = { segments: ContextSegment[]; used: number; max: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'claude-vscode-usage-bars': { reading: Reading | null; mcp: McpServer[]; context: ContextReading | null }
  }
}
