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

  expect(await run('')).toBe(
    'Layout: 5h week mcp | context categories categories (default). Not shown: fable. Theme: dark. Run "/usage-bars help" for how to change it.',
  )

  expect(await run('layout week 5h|context categories categories | mcp')).toBe(
    'Layout: week 5h | context categories categories | mcp. Not shown: fable. Theme: dark. Run "/usage-bars help" for how to change it.',
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
  // Help, and anything else that isn't a layout, shows the help.
  for (const other of ['help', 'layout', 'hide fable', 'show all', 'columns 2', 'row']) {
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
