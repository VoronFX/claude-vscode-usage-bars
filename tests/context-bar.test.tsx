import { expect, test } from 'claude-code/testing'

const STATE: Record<string, unknown> = {
  reading: {
    limits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2030-01-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 18, resetsAt: '2030-01-01T00:00:00Z' },
    ],
    at: 0,
  },
  mcp: [],
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
}

for (const surface of ['vscode', 'terminal'] as const) {
  test(`the context bar draws on ${surface}`, async ($, on) => {
    on('state.get', (_, e) => ({ value: { value: STATE[(e as { key: string }).key] ?? null, version: 1 } }))
    on('clock.now', () => ({ value: 0 }))

    const ui = await $.ui.mount({ plugin: 'usage-bars', component: 'AbovePrompt', props: { hasSurvey: false }, surface } as never)
    expect((await ui.find({ type: 'Text', text: /^Context$/ }))?.text).toBe('Context')
    expect((await ui.find({ type: 'Text', text: /^42%$/ }))?.text).toBe('42%')
    expect((await ui.find({ type: 'Text', text: /^84k\/200k$/ }))?.text).toBe('84k/200k')
    expect((await ui.find({ type: 'Text', text: /^5h$/ }))?.text).toBe('5h')
    await ui.unmount()
  })
}
