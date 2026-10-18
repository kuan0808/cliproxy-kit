import type { EngineInterface, Register } from 'claude-code'

// The Claude Code check for Switch now (../run.sh). As the band does on a press, a timer outside the
// step stops the main turn whose step has had no content for CHECK_STALL_MS, with $.turn.abort, once,
// and the turn's own end says what came of it. With CHECK_NEXT set, a message follows, as the
// reader's next one would. Each event goes to CHECK_LOG.
let stopped = ''

const note = async ($: EngineInterface, line: string) => {
  const path = await $.env.get('CHECK_LOG')
  if (!path) return
  const before = await $.fs.read(path).catch(() => '')
  await $.fs.write(path, `${before}${line}\n`)
}

export const register: Register = on => {
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || stopped) return yield* next(e)
    let content = false
    const stall = Number((await $.env.get('CHECK_STALL_MS')) ?? '3000')
    const timer = $.clock.after(stall, async () => {
      if (content || stopped) return
      stopped = e.turnId
      await note($, `abort ${e.turnId}`)
      await $.turn.abort({ turnId: e.turnId }).catch(err => note($, `abort rejected: ${String(err)}`))
      if (await $.env.get('CHECK_NEXT')) await $.prompt.submit({ text: 'CHECK-PROMPT go on' }).catch(err => note($, `submit failed: ${String(err)}`))
    })
    const s = next(e)
    try {
      for (;;) {
        const r = await s.next()
        if (r.done) return r.value
        if (r.value.kind !== 'engine' && r.value.kind !== 'stop') content = true
        yield r.value
      }
    } finally {
      timer.cancel()
    }
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await note($, `complete ${e.turnId} ${e.reason}`)
    return next(e)
  })
}
