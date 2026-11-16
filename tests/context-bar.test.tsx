import { expect, test } from 'claude-code/testing'

const SEED: Record<string, unknown> = {
  reading: {
    limits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2030-01-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 18, resetsAt: '2030-01-01T00:00:00Z' },
    ],
    at: 0,
  },
  mcp: [{ name: 'cw', tools: 3, isConnected: true }],
  context: {
    segments: [
      { name: 'System prompt', tokens: 20000, color: 'promptBorder', kind: 'used' },
      { name: 'Messages', tokens: 64000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used' },
      { name: 'Free space', tokens: 83000, color: 'inactive', kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33000, color: 'inactive', kind: 'buffer' },
    ],
    used: 84000,
    max: 200000,
    percent: 42,
  },
  order: [],
}

type Address = { key: string; value?: unknown }
type On = Parameters<Parameters<typeof test>[1]>[1]
type Session = Parameters<Parameters<typeof test>[1]>[0]
// The test runtime has timers; the mod's types leave them out.
const sleep = (ms: number) =>
  new Promise<void>(resolve => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }).setTimeout(resolve, ms))

// State and store kept in memory, so a command's writes reach the next drawing.
const backend = (on: On, seed: Record<string, unknown>) => {
  const state = new Map(Object.entries(seed))
  const store = new Map<string, unknown>()
  on('state.get', (_, e) => ({ value: { value: state.get((e as Address).key) ?? null, version: 1 } }))
  on('state.set', (_, e) => {
    state.set((e as Address).key, (e as Address).value)
    return { value: { isSet: true, version: 1 } }
  })
  on('store.get', (_, e) => ({ value: store.get((e as Address).key) }))
  on('store.set', (_, e) => {
    store.set((e as Address).key, (e as Address).value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 0 }))
  return { state, store }
}

const ABOVE_PROMPT = { plugin: 'usage-bars', component: 'AbovePrompt', props: { hasSurvey: false } }
const mount = ($: Parameters<Parameters<typeof test>[1]>[0], surface: 'vscode' | 'terminal') =>
  $.ui.mount({ ...ABOVE_PROMPT, surface } as never)
// The grid's root is keyed with its column count.
const columnCount = async (ui: Awaited<ReturnType<typeof mount>>) => {
  for (let count = 1; count <= 6; count++) {
    if (await ui.find({ key: `grid-${count}-columns` })) return count
  }
  return 0
}

for (const surface of ['vscode', 'terminal'] as const) {
  test(`the default layout draws in two columns on ${surface}`, async ($, on) => {
    backend(on, SEED)
    const ui = await mount($, surface)
    for (const expected of ['Context', '42%', '84k/200k', '5h', 'Week', 'Messages', '64k', 'MCP']) {
      expect((await ui.find({ type: 'Text', text: expected }))?.text).toBe(expected)
    }
    // Fable isn't in the default layout; the categories leave out Free space, as the /context dialog does.
    for (const absent of ['Fable', 'Free space']) {
      expect((await ui.find({ type: 'Text', text: absent }))?.text).toBe(undefined)
    }
    expect(await columnCount(ui)).toBe(2)
    await ui.unmount()
  })

  test(`a Fable row without data reads "—" on ${surface}`, async ($, on) => {
    backend(on, { ...SEED, order: ['fable'] })
    const ui = await mount($, surface)
    for (const expected of ['Fable', '—']) {
      expect((await ui.find({ type: 'Text', text: expected }))?.text).toBe(expected)
    }
    await ui.unmount()
  })

  test(`a layout with "|" and two-line categories draws as written on ${surface}`, async ($, on) => {
    backend(on, { ...SEED, order: ['week', '5h', '|', 'context', 'categories', 'categories', '|', 'mcp'] })
    const ui = await mount($, surface)
    for (const expected of ['Week', '5h', 'Context', 'Messages', 'System prompt', 'MCP']) {
      expect((await ui.find({ type: 'Text', text: expected }))?.text).toBe(expected)
    }
    // Fable isn't in the layout, so it isn't drawn.
    expect((await ui.find({ type: 'Text', text: 'Fable' }))?.text).toBe(undefined)
    expect(await columnCount(ui)).toBe(3)
    await ui.unmount()
  })
}

test('a layout without "|" is one column', async ($, on) => {
  backend(on, { ...SEED, order: ['context', 'categories'] })
  const ui = await mount($, 'vscode')
  expect(await columnCount(ui)).toBe(1)
  await ui.unmount()
})

test('one section per column puts everything on one row', async ($, on) => {
  backend(on, { ...SEED, order: ['context', '|', '5h', '|', 'week', '|', 'mcp'] })
  const ui = await mount($, 'vscode')
  expect(await columnCount(ui)).toBe(4)
  await ui.unmount()
})

for (const surface of ['vscode', 'terminal'] as const) {
  test(`a section repeated across a row spans the columns on ${surface}`, async ($, on) => {
    backend(on, { ...SEED, order: ['5h', 'categories', '|', 'week', 'categories'] })
    const ui = await mount($, surface)
    for (const expected of ['5h', 'Week', 'Messages']) {
      expect((await ui.find({ type: 'Text', text: expected }))?.text).toBe(expected)
    }
    expect(await columnCount(ui)).toBe(2)
    await ui.unmount()
  })
}

// The extension freezes the area's height while Claude works, so a row appearing mid-turn would push the frame's
// bottom edge out of view: an empty section keeps its place.
test('a section with nothing to show yet keeps its rows and columns', async ($, on) => {
  backend(on, { ...SEED, order: ['context', '|', 'mcp', 'mcp'], mcp: [] })
  const ui = await mount($, 'vscode')
  expect(await columnCount(ui)).toBe(2)
  expect((await ui.find({ type: 'Text', text: 'MCP' }))?.text).toBe(undefined)
  await ui.unmount()
})

test('a reported Fable window draws as a bar', async ($, on) => {
  const fable = { kind: 'seven_day_overage_included', percentUsed: 12, resetsAt: '2030-01-01T00:00:00Z' }
  backend(on, { ...SEED, reading: { limits: [fable], at: 0 }, order: ['fable'] })
  const ui = await mount($, 'vscode')
  expect((await ui.find({ type: 'Text', text: '12%' }))?.text).toBe('12%')
  expect((await ui.find({ type: 'Text', text: '—' }))?.text).toBe(undefined)
  await ui.unmount()
})

test('a window missing from a fresh reading keeps its last value', async ($, on) => {
  const { state } = backend(on, SEED)
  on('session.measure', (_, e) => ({ changed: (e as { changed: string[] }).changed }))
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 20, resetsAt: '2030-01-01T00:00:00Z' }],
    changed: ['rateLimits'],
  } as never)
  const saved = state.get('reading') as { limits: { kind: string; percentUsed: number }[] }
  expect(saved.limits.map(l => `${l.kind} ${l.percentUsed}`)).toEqual(['five_hour 40', 'seven_day 20'])
})

test('/usage-bars changes and reports the layout', async ($, on) => {
  const { store } = backend(on, SEED)
  const run = async (args: string) => (await $.command.run({ command: 'usage-bars', args } as never)).text ?? ''

  expect(await run('layout')).toBe(
    'Layout: 5h week mcp | context categories categories (default). Not shown: fable, caffeine. Theme: dark. Run "/usage-bars help" for how to change it.',
  )

  expect(await run('layout week 5h|context categories categories | mcp')).toBe(
    'Layout: week 5h | context categories categories | mcp. Not shown: fable, caffeine. Theme: dark. Run "/usage-bars help" for how to change it.',
  )
  expect(store.get('order')).toEqual(['week', '5h', '|', 'context', 'categories', 'categories', '|', 'mcp'])
  expect(await run('layout reset')).toContain('(default).')
  expect(store.get('order')).toEqual([])

  // "c" is a column break, like "|".
  expect(await run('layout 5h c week')).toContain('Layout: 5h | week.')
  expect(store.get('order')).toEqual(['5h', '|', 'week'])
  expect(await run('layout 5h categories | week categories')).toContain('Layout: 5h categories | week categories.')
  expect(await run('layout 5h categories | categories week')).toContain(
    'Layout not changed: "categories" doesn\'t form a rectangle.',
  )
  // A pinwheel: four spans around a centre, no straight line to split along.
  expect(await run('layout 5h fable fable | 5h mcp context | week week context')).toContain(
    'Layout not changed: These spans interlock',
  )
  expect(store.get('order')).toEqual(['5h', 'categories', '|', 'week', 'categories'])

  expect(await run('layout week bogus')).toContain('Unknown section: bogus.')
  expect(await run('')).toContain('Writing a layout')
  // Help, and anything else that isn't a layout, shows the help.
  for (const other of ['help', 'hide fable', 'show all', 'columns 2', 'row']) {
    expect(await run(other)).toContain('Writing a layout')
  }
})

test('/usage-bars theme switches the bar palette', async ($, on) => {
  const { store } = backend(on, SEED)
  const run = async (args: string) => (await $.command.run({ command: 'usage-bars', args } as never)).text ?? ''

  expect(await run('theme light')).toContain('Theme: light.')
  expect(store.get('theme')).toBe('light')
  // The light palette's track is Light+'s input border, not the dark theme's translucent grey.
  const ui = await mount($, 'vscode')
  const fills = (await ui.findAll({ type: 'Box' })).map(box => box.props.backgroundColor)
  expect(fills).toContain('#cecece')
  expect(fills).not.toContain('#7f7f7f66')
  await ui.unmount()

  expect(await run('theme dark')).toContain('Theme: dark.')
  expect(await run('theme blue')).toContain('Writing a layout')
  expect(store.get('theme')).toBe('dark')
})

const FIVE_HOUR_RESET = '2030-01-01T05:00:00Z'
const WEEK_RESET = '2030-01-05T00:00:00Z'
const IN_WINDOW: Record<string, unknown> = {
  ...SEED,
  order: ['week'],
  reading: {
    limits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: FIVE_HOUR_RESET },
      { kind: 'seven_day', percentUsed: 18, resetsAt: WEEK_RESET },
    ],
    at: 0,
  },
  windowStart: { fiveHourResetsAt: FIVE_HOUR_RESET, weekResetsAt: WEEK_RESET, weekPercent: 10 },
}

test('the week bar draws what the current 5h window added apart from the rest', async ($, on) => {
  backend(on, IN_WINDOW)
  const ui = await mount($, 'vscode')
  const before = await ui.find({ key: 'before' })
  const added = await ui.find({ key: 'fill' })
  expect([before?.props.width, before?.props.backgroundColor]).toEqual(['10%', '#0e70c080'])
  expect([added?.props.width, added?.props.backgroundColor]).toEqual(['8%', '#0e70c0'])
  await ui.unmount()
})

test('the terminal week bar dims the cells used before the current 5h window', async ($, on) => {
  backend(on, IN_WINDOW)
  const ui = await mount($, 'terminal')
  // 10% and 18% of 12 cells: 1 cell from before the window, 1 added in it.
  const dim = (await ui.findAll({ type: 'Text' })).filter(t => t.props.dimColor && t.text === '█')
  expect(dim.length).toBe(1)
  await ui.unmount()
})

test('a week start for another 5h window leaves the week bar one colour', async ($, on) => {
  backend(on, { ...IN_WINDOW, windowStart: { fiveHourResetsAt: '2029-12-31T20:00:00Z', weekResetsAt: WEEK_RESET, weekPercent: 10 } })
  const ui = await mount($, 'vscode')
  expect(await ui.find({ key: 'before' })).toBe(undefined)
  expect((await ui.find({ key: 'fill' }))?.props.width).toBe('18%')
  await ui.unmount()
})

test('a new 5h window starts from the last weekly figure read before it', async ($, on) => {
  const { store } = backend(on, {
    ...IN_WINDOW,
    reading: {
      limits: [
        { kind: 'five_hour', percentUsed: 90, resetsAt: '2029-12-31T20:00:00Z' },
        { kind: 'seven_day', percentUsed: 18, resetsAt: WEEK_RESET },
      ],
      at: 0,
    },
    windowStart: null,
  })
  on('session.measure', (_, e) => ({ changed: (e as { changed: string[] }).changed }))
  const measure = (fiveHour: number, week: number, weekReset = WEEK_RESET) =>
    $.session.measure({
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: FIVE_HOUR_RESET },
        { kind: 'seven_day', percentUsed: week, resetsAt: weekReset },
      ],
      changed: ['rateLimits'],
    } as never)

  await measure(5, 20)
  expect(store.get('windowStart')).toEqual({ fiveHourResetsAt: FIVE_HOUR_RESET, weekResetsAt: WEEK_RESET, weekPercent: 18 })
  // Later readings in the same window keep where it began.
  await measure(30, 25)
  expect((store.get('windowStart') as { weekPercent: number }).weekPercent).toBe(18)
  // A week that resets inside the window was all used inside it.
  await measure(35, 2, '2030-01-08T00:00:00Z')
  expect(store.get('windowStart')).toEqual({ fiveHourResetsAt: FIVE_HOUR_RESET, weekResetsAt: '2030-01-08T00:00:00Z', weekPercent: 0 })
})

test('the 5h bar draws what the last prompt added apart from the rest', async ($, on) => {
  backend(on, { ...IN_WINDOW, order: ['5h'], promptStart: { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 30 } })
  const ui = await mount($, 'vscode')
  expect((await ui.find({ key: 'before' }))?.props.width).toBe('30%')
  expect((await ui.find({ key: 'fill' }))?.props.width).toBe('10%')
  await ui.unmount()
})

test('a 5h window opened after the last prompt was all added since', async ($, on) => {
  backend(on, { ...IN_WINDOW, order: ['5h'], promptStart: { fiveHourResetsAt: '2029-12-31T20:00:00Z', percent: 90 } })
  const ui = await mount($, 'vscode')
  expect(await ui.find({ key: 'before' })).toBe(undefined)
  expect((await ui.find({ key: 'fill' }))?.props.width).toBe('40%')
  await ui.unmount()
})

test('what is used after the last prompt ended is drawn faint after its span', async ($, on) => {
  backend(on, {
    ...IN_WINDOW,
    order: ['5h'],
    promptStart: { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 30 },
    promptEnd: { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 35 },
  })
  const ui = await mount($, 'vscode')
  const widths = await Promise.all(['before', 'fill', 'after'].map(async key => (await ui.find({ key }))?.props.width))
  expect(widths).toEqual(['30%', '5%', '5%'])
  expect((await ui.find({ key: 'after' }))?.props.backgroundColor).toBe('#0e70c080')
  await ui.unmount()
})

test('a prompt that ended in an earlier 5h window leaves the whole fill faint', async ($, on) => {
  const earlier = { fiveHourResetsAt: '2029-12-31T20:00:00Z', percent: 90 }
  backend(on, { ...IN_WINDOW, order: ['5h'], promptStart: earlier, promptEnd: earlier })
  const ui = await mount($, 'vscode')
  expect(await ui.find({ key: 'fill' })).toBe(undefined)
  expect((await ui.find({ key: 'after' }))?.props.width).toBe('40%')
  await ui.unmount()
})

test('a typed prompt marks the span start, its end marks the end, a continuation reopens it', async ($, on) => {
  const { state } = backend(on, IN_WINDOW)
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('tool.list', () => ({ value: [] }))
  const mark = { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 40 }

  await $.turn.start({ text: '', turnId: 't0' } as never)
  expect(state.get('promptStart') ?? null).toBe(null)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect([state.get('promptStart'), state.get('promptEnd')]).toEqual([mark, null])
  await $.turn.complete({ text: '', answer: '', turnId: 't1', reason: 'completed', durationMs: 1, isAborted: false } as never)
  expect(state.get('promptEnd')).toEqual(mark)
  await $.turn.start({ text: '', turnId: 't2' } as never)
  expect([state.get('promptStart'), state.get('promptEnd')]).toEqual([mark, null])
})

test('a terminal bar with no split known dims none of its cells', async ($, on) => {
  backend(on, { ...IN_WINDOW, order: ['week'], windowStart: null })
  const ui = await mount($, 'terminal')
  const dim = (await ui.findAll({ type: 'Text' })).filter(t => t.props.dimColor && t.text?.includes('█'))
  expect(dim.length).toBe(0)
  await ui.unmount()
})

test('a window whose reset has passed reads 0% until a new reading comes', async ($, on) => {
  backend(on, {
    ...SEED,
    order: ['5h'],
    reading: { limits: [{ kind: 'five_hour', percentUsed: 70, resetsAt: '1969-12-31T23:00:00Z' }], at: -1 },
  })
  const ui = await mount($, 'vscode')
  expect((await ui.find({ type: 'Text', text: '0%' }))?.text).toBe('0%')
  expect((await ui.find({ type: 'Text', text: '70%' }))?.text).toBe(undefined)
  await ui.unmount()
})

// The engine's own parts of a session start, faked so the hook runs; only the zero-delay timer, the start-up refresh,
// runs its callback.
const startSession = async ($: Session, on: On, usage: { status: number; body?: unknown }) => {
  const fetched: { url: string; init: { auth?: string; headers?: Record<string, string> } }[] = []
  on('session.start', () => ({ cwd: '' }))
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }))
  on('command.register', () => ({ value: { command: 'usage-bars' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('tool.list', () => ({ value: [] }))
  on('clock.every', () => ({ deny: 'no repeating timers in tests' }))
  on('clock.after', (_, e) => ((e as { ms: number }).ms === 0 ? { value: undefined } : { deny: 'only the start-up refresh runs' }))
  on('session.authorize', () => ({ value: { handle: 'credential', kind: 'bearer' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('http.fetch', (_, e) => {
    fetched.push(e as never)
    const { status, body } = usage
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify(body ?? {}) } }
  })
  await $.session.start({ cwd: '' } as never)
  // The timer callback runs after its dispatch resolves.
  await sleep(50)
  return fetched
}

test('with no recent reading a session asks the usage endpoint', async ($, on) => {
  const { state, store } = backend(on, { ...SEED, reading: null })
  const fetched = await startSession($, on, {
    status: 200,
    body: {
      five_hour: { utilization: 55, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 30, resets_at: WEEK_RESET },
      seven_day_opus: { utilization: 99, resets_at: null },
    },
  })
  expect(fetched.map(f => [f.url, f.init.auth, f.init.headers?.['anthropic-beta']])).toEqual([
    ['https://api.anthropic.com/api/oauth/usage', 'credential', 'oauth-2025-04-20'],
  ])
  const saved = state.get('reading') as { limits: { kind: string; percentUsed: number }[] }
  expect(saved.limits.map(l => `${l.kind} ${l.percentUsed}`)).toEqual(['five_hour 55', 'seven_day 30'])
  expect(store.get('fetchClaimedUntil')).toBe(120_000)
})

test('a failed request is retried sooner', async ($, on) => {
  const { store } = backend(on, { ...SEED, reading: null })
  await startSession($, on, { status: 401 })
  expect(store.get('fetchClaimedUntil')).toBe(30_000)
})

test('a session whose reading is recent does not ask', async ($, on) => {
  backend(on, SEED)
  expect(await startSession($, on, { status: 200 })).toEqual([])
})

test('before the first prompt the whole 5h fill is faint', async ($, on) => {
  backend(on, { ...IN_WINDOW, order: ['5h'] })
  const ui = await mount($, 'vscode')
  expect(await ui.find({ key: 'fill' })).toBe(undefined)
  expect((await ui.find({ key: 'after' }))?.props.width).toBe('40%')
  await ui.unmount()
})

test('the prompt marks are saved per session and restored when the state comes back empty', async ($, on) => {
  const { state, store } = backend(on, IN_WINDOW)
  const start = { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 30 }
  const end = { fiveHourResetsAt: FIVE_HOUR_RESET, percent: 35 }
  store.set('promptMarks', {
    'session-1': { start, end, at: 0 },
    other: { start: end, end: null, at: 0 },
    expired: { start, end, at: -7 * 3_600_000 },
  })
  await startSession($, on, { status: 200 })
  expect([state.get('promptStart'), state.get('promptEnd')]).toEqual([start, end])

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  expect(Object.keys(store.get('promptMarks') as object).sort()).toEqual(['other', 'session-1'])
  expect((store.get('promptMarks') as Record<string, { end: unknown }>)['session-1']?.end).toBe(null)
})


test('the caffeine section is empty without the plugin', async ($, on) => {
  backend(on, { ...SEED, order: ['caffeine', '|', 'context'] })
  const ui = await mount($, 'vscode')
  expect((await ui.find({ type: 'Text', text: 'Caffeine' }))?.text).toBe(undefined)
  await ui.unmount()
})

for (const [brew, expected] of [
  [{ isOn: true, until: 90 * 60_000 }, 'on · 1h 30m left'],
  [{ isOn: true, until: 0 }, 'on'],
  [{ isOn: false, until: 0 }, 'off'],
] as const) {
  test(`the caffeine section reads "${expected}"`, async ($, on) => {
    backend(on, { ...SEED, order: ['caffeine'], brew })
    const ui = await mount($, 'vscode')
    for (const text of ['Caffeine', expected]) {
      expect((await ui.find({ type: 'Text', text }))?.text).toBe(text)
    }
    expect(await ui.find({ type: 'Button' })).toBe(undefined)
    await ui.unmount()
  })
}

// Flexbox takes a column box's padding out before sharing the width, so with the gap there a row of three columns
// split differently from a row of two. Only cells carry the gap.
test('column boxes carry no padding, so rows with different splits line up', async ($, on) => {
  backend(on, { ...SEED, order: ['5h', 'week', '|', '5h', 'week', '|', 'context', 'mcp', '|', 'context', 'categories'] })
  const ui = await mount($, 'vscode')
  const boxes = await ui.findAll({ type: 'Box' })
  const columns = boxes.filter(box => String(box.props.key ?? '').startsWith('column-'))
  expect(columns.length > 0).toBe(true)
  expect(columns.filter(box => box.props.paddingRight).length).toBe(0)
  await ui.unmount()
})

test('the 5h span stays open while a subagent works past the main turn, and closes when it finishes', async ($, on) => {
  const { state } = backend(on, IN_WINDOW)
  let agents = [{ id: 'a1', status: 'running' }]
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('agent.list', () => ({ value: agents as never }))
  const complete = (turnId: string, agentId?: string) =>
    $.turn.complete({ text: '', answer: '', turnId, agentId, reason: 'completed', durationMs: 1, isAborted: false } as never)

  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await complete('t1')
  expect([state.get('promptEnd'), state.get('promptEndPending')]).toEqual([null, true])
  // The agent's own turn ends while it still lists as running.
  await complete('a1-turn', 'a1')
  expect(state.get('promptEnd')).toEqual({ fiveHourResetsAt: FIVE_HOUR_RESET, percent: 40 })
  expect(state.get('promptEndPending')).toBe(false)

  agents = []
  await $.turn.start({ text: 'again', turnId: 't2' } as never)
  await complete('t2')
  expect(state.get('promptEnd')).toEqual({ fiveHourResetsAt: FIVE_HOUR_RESET, percent: 40 })
})
