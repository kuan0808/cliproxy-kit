// The band in a terminal: character cells, so every width is counted.
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

import { C, barFill, fmtDuration, layout, resetText, sev, tileWidths, tilesSpan } from './logic'
import type { BarOf } from './pane'
import { cacheCaption, type Act, type BandInput, type Do, type Facts, type Meter, type Row } from './view'

/** What both surfaces' tables have: all the terminal draws with. */
type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type BandSite = { bodyColumns: number; maxRows: number; working: boolean; beneath: boolean }

export function terminalBand(els: Els, i: BandInput, f: Facts, act: Do, site: BandSite, below: RenderElement): RenderElement {
  const { Box, Text, Button } = els
  const { ui } = i
  // One column of air before the engine's own [-] at the top right.
  const rowWidth = Math.max(20, site.bodyColumns - 1)
  // One line while Claude works and cards while it waits, unless the reader chose otherwise
  // for this stretch; cards only where the terminal has room for them.
  const phase = site.working ? 'working' : 'idle'
  const roomy = layout(rowWidth, site.maxRows, false)
  const chosen = ui.viewPhase === phase && ui.viewTurn === ui.turns ? ui.viewOverride : ''
  const picked = chosen === 'line' ? 'compact' : chosen === 'cards' ? roomy : layout(rowWidth, site.maxRows, site.working || site.beneath)
  // A direct login has no proxy accounts: no Accounts tile.
  const mode = picked === 'tiles6' && !f.proxied ? 'tiles5' : picked
  const setView = (view: 'cards' | 'line') => act.ui({ viewOverride: view, viewPhase: phase, viewTurn: ui.turns })

  const dim = (t: string) => <Text color={C.dim}>{t}</Text>
  const bar = cellBar(els)
  // Every meter reads as used, as Claude's own /usage and the usage view do: a fresh session's
  // context and a new week start empty and fill. The colour still warns as what is left runs low.
  const pctText = (remaining: number, stale = false) => (
    <Text bold color={stale ? C.dim : sev(remaining)}>{`${Math.round(100 - remaining)}%${stale ? '~' : ''}`}</Text>
  )
  const usedFrac = (remaining: number) => (100 - remaining) / 100
  const usedBar = (remaining: number, cells: number, color: string) => bar(usedFrac(remaining), cells, color)
  // Controls read as words, not boxes: dim at rest, bright under the pointer or the focus.
  // No hotkey letters: they only work once the band has the keyboard (ctrl+x tab), so a letter
  // beside a control reads as a shortcut that does nothing. Main actions are bright.
  const link = (a: Act, main = a.main) => a.run
    ? <Button key={a.key} label={a.label} plain dimColor={!main} onPress={a.run} />
    : <Text key={a.key} color={C.dim}>{a.label}</Text>

  // -- the row above the band: a question, a notice or an alert --
  const width = mode === 'compact' ? rowWidth : tilesSpan(mode, rowWidth)
  const top: RenderChildren[] = []
  if (f.top) top.push(rowOf(els, f.top, width))

  const c = f.cache
  const cacheColor = f.isCodex ? sev((c.rate ?? 0) * 100) : c.state === 'expiring' ? C.yellow : c.state === 'cold' ? C.red : C.green
  const cacheFrac = f.isCodex ? c.rate ?? 0 : c.frac
  const { five, week } = f
  const ctxLeft = f.ctx?.left ?? null

  // -- one or two rows: while Claude works, or when the terminal is too narrow for tiles --
  if (mode === 'compact') {
    // The width of a meter's figure, which shows what is used.
    const pctWidth = (remaining: number) => `${Math.round(100 - remaining)}%`.length
    const hit = c.rate == null ? '' : `hit ${Math.round(c.rate * 100)}%`
    const cacheValue = f.isCodex ? (hit || '—') : c.state === 'unknown' ? '—' : c.state === 'cold' ? 'cold' : fmtDuration(c.leftMs)
    const cacheTone = f.isCodex ? (c.rate == null ? C.dim : sev(c.rate * 100)) : c.state === 'unknown' ? C.dim : cacheColor
    const effort = f.effort ? ` · ${f.effort}` : ''
    // `drop` orders what goes first when even the plainest row is too wide: higher goes first.
    type Slot = { width: number; node: RenderChildren; drop: number; model?: true }
    // label, a five-cell bar filled to `fill` (unless plain), the value, and an optional dim tail.
    // A quota meter fills with what is used; the cache's with what its tile's bar shows.
    const mini = (drop: number, label: string, fill: number, color: string, value: RenderChildren, valueWidth: number, bars: boolean, tail = ''): Slot => ({
      drop,
      width: label.length + 1 + (bars ? 6 : 0) + valueWidth + (tail ? tail.length + 1 : 0),
      node: <Box key={`meter-${label}`} gap={1}>{dim(label)}{bars ? bar(fill, 5, color) : null}{value}{tail ? dim(tail) : null}</Box>,
    })
    // Who and what: the account, then the model with its effort (or the route).
    const identity = (withEffort: boolean, divider: boolean): Slot[] => {
      const model = f.route ? `→ ${f.route}` : f.modelName
      const tail = f.route || !withEffort ? '' : effort
      return [
        { drop: 0, width: f.account.length, node: <Text bold>{f.account}</Text> },
        {
          drop: 4,
          model: true,
          // A divider after the model is counted here and drawn only when something follows it.
          width: model.length + tail.length + (divider ? 4 : 0),
          node: <Text><Text color={f.route ? C.aqua : C.fg}>{model}</Text><Text color={C.dim}>{tail}</Text></Text>,
        },
      ]
    }
    // The meters at a detail level: 0 everything, 1 without the pool and cache hit, 2 without
    // reset times, 4 without bars.
    const meters = (level: number): Slot[] => {
      const bars = level < 4
      const row: Slot[] = []
      if (ctxLeft != null) row.push(mini(1, 'ctx', usedFrac(ctxLeft), sev(ctxLeft), pctText(ctxLeft), pctWidth(ctxLeft), bars))
      for (const [drop, label, m] of [[2, '5h', five], [3, '7d', week]] as const) {
        if (!m) continue
        row.push(mini(drop, label, usedFrac(m.remaining), m.stale ? C.dim : sev(m.remaining), pctText(m.remaining, m.stale),
          pctWidth(m.remaining) + (m.stale ? 1 : 0), bars, level < 2 ? m.reset : ''))
      }
      row.push(mini(5, 'cache', cacheFrac, cacheTone, <Text bold color={cacheTone}>{cacheValue}</Text>, cacheValue.length, bars,
        level < 1 && !f.isCodex && hit ? `· ${hit}` : ''))
      const pool = f.pool
      if (level < 1 && pool && pool.left !== null && pool.parts.length > 1) {
        row.push({ drop: 6, width: 5 + pctWidth(pool.left) + (pool.stale ? 1 : 0), node: <Box gap={1}>{dim('all')}{pctText(pool.left, pool.stale)}</Box> })
      }
      return row
    }
    // The way into the switch menu, and the cards where the terminal has room for them: kept to
    // the last when space runs out.
    const controls: Slot[] = []
    if (f.controls.switch) controls.push({ drop: -1, width: 6, node: link(f.controls.switch, false) })
    if (roomy !== 'compact') controls.push({ drop: -1, width: 4, node: link({ key: 'view-cards', label: 'more', run: () => setView('cards') }, false) })
    const budget = rowWidth - 4
    const span = (row: Slot[]) => row.reduce((sum, s) => sum + s.width, 0) + 3 * (row.length - 1)
    // The richest level that fits (level 3 also drops the effort), then items by `drop`.
    const fit = (build: (level: number) => Slot[]) => {
      let level = 0
      let row = build(level)
      while (span(row) > budget && level < 4) row = build(++level)
      while (span(row) > budget && row.length > 1) {
        const worst = row.reduce((a, b) => (b.drop > a.drop ? b : a))
        row = row.filter(s => s !== worst)
      }
      return row
    }
    const withControls = (row: Slot[]) => [...row, ...controls]
    const full = withControls([...identity(true, true), ...meters(0)])
    // Everything on one row when it fits; else, given the height and nothing drawn beneath, who
    // and what on one row and the meters with full detail on a second; else one row that sheds
    // detail, leaving the rest of the band to what lies beneath.
    const lines: Slot[][] = span(full) <= budget
      ? [full]
      : !site.beneath && site.maxRows >= top.length + 2
        ? [fit(level => withControls(identity(level < 1, false))), fit(meters)]
        : [fit(level => withControls([...identity(level < 3, true), ...meters(level)]))]
    return (
      <Box flexDirection="column">
        {top}
        {lines.map((row, n) => (
          <Box key={`line-${n}`} paddingX={2} gap={3} width={rowWidth}>
            {row.map((s, k) => (s.model && lines.length === 1 && k < row.length - 1 ? <Box key="model" gap={3}>{s.node}{dim('│')}</Box> : s.node))}
          </Box>
        ))}
        {below}
      </Box>
    )
  }

  // -- tiles: this session, then its quota, context, cache and the account pool --
  const tws = tileWidths(mode, rowWidth)
  const tiles: RenderChildren[] = []
  // A tile: label and value, a meter as wide as the tile's inside, a caption.
  const tile = (key: string, label: string, value: RenderChildren, meter: (cells: number) => RenderChildren, caption: RenderChildren) => {
    const w = tws[tiles.length % tws.length]!
    return (
      <Box key={key} width={w} paddingX={2} flexDirection="column" backgroundColor={C.tile}>
        <Box justifyContent="space-between">{dim(label)}{value}</Box>
        {meter(w - 4)}
        {caption}
      </Box>
    )
  }
  const used = (m: Meter | undefined) => m ? <Box>{pctText(m.remaining, m.stale)}{dim(' used')}</Box> : dim('—')
  const meterBar = (m: Meter | undefined) => (cells: number) => m ? usedBar(m.remaining, cells, m.stale ? C.dim : sev(m.remaining)) : bar(0, cells, C.track)
  const caption = (t: string) => <Text color={C.dim} wrap="truncate-end">{t}</Text>
  // A routed session's route goes with `back` beside it: the controls row has no room for both
  // `back` and `switch`, and `switch` stays, for another account or model.
  tiles.push(
    <Box key="account" width={tws[0]} paddingX={2} flexDirection="column" backgroundColor={C.tile}>
      <Box justifyContent="space-between">
        {dim('Account')}
        <Text bold color={C.fg}>{f.account}</Text>
      </Box>
      {f.route
        ? (
          <Box justifyContent="space-between" gap={1}>
            <Text color={C.aqua} wrap="truncate-end">{`→ ${f.route}`}</Text>
            {f.controls.unroute ? link(f.controls.unroute, false) : null}
          </Box>
        )
        : <Text color={C.dim} wrap="truncate-end">{f.note}</Text>}
      <Box gap={2}>
        {f.controls.switch ? link(f.controls.switch, false) : null}
        {f.controls.quota ? link(f.controls.quota, false) : null}
        {link({ key: 'view-line', label: 'less', run: () => setView('line') }, false)}
      </Box>
    </Box>,
  )
  tiles.push(tile('five', '5-hour', used(five), meterBar(five), caption(five ? resetText(five.reset) : f.fiveMissing)))
  tiles.push(tile('week', week?.label ?? 'Weekly', used(week), meterBar(week), caption(week ? resetText(week.reset) : f.weekMissing)))
  tiles.push(tile('ctx', 'Context', ctxLeft != null ? <Box>{pctText(ctxLeft)}{dim(' used')}</Box> : dim('—'),
    cells => ctxLeft != null ? usedBar(ctxLeft, cells, sev(ctxLeft)) : bar(0, cells, C.track),
    <Text wrap="truncate-end"><Text color={C.dim}>{f.modelName}</Text><Text color={C.dim}>{f.effort ? ` · ${f.effort}` : ''}</Text></Text>))
  const cacheWord = f.isCodex
    ? c.rate == null ? dim('waiting') : <Text bold color={sev(c.rate * 100)}>{`hit ${Math.round(c.rate * 100)}%`}</Text>
    : c.state === 'warm' ? <Text bold color={C.green}>Warm</Text>
    : c.state === 'expiring' ? <Text bold color={C.yellow}>Expiring</Text>
    : c.state === 'cold' ? <Text bold color={C.red}>Cold</Text>
    : dim('waiting')
  tiles.push(tile('cache', 'Cache', cacheWord, cells => bar(cacheFrac, cells, cacheColor), caption(cacheCaption(f, false))))
  if ((mode === 'tiles6' || mode === 'grid') && f.proxied) {
    const pool = f.pool
    if (pool && pool.parts.length) {
      const parts = pool.parts
      tiles.push(tile('all', 'Accounts', pool.left === null ? dim('—') : <Box>{pctText(pool.left, pool.stale)}{dim(' used')}</Box>,
        cells => {
          const each = Math.floor((cells - (parts.length - 1)) / parts.length)
          return <Box gap={1}>{parts.map((p, n) => <Box key={`p-${n}`}>{p === null ? bar(0, each, C.track) : usedBar(p, each, sev(p))}</Box>)}</Box>
        },
        caption(pool.caption)))
    } else {
      tiles.push(tile('all', 'Accounts', dim('—'), cells => bar(0, cells, C.track), caption('no quota data')))
    }
  }

  return (
    <Box flexDirection="column">
      {top}
      {mode === 'grid' ? (
        <Box key="tiles" flexDirection="column">
          <Box gap={1}>{tiles.slice(0, 3)}</Box>
          <Box gap={1}>{tiles.slice(3)}</Box>
        </Box>
      ) : (
        <Box key="tiles" gap={1}>{tiles}</Box>
      )}
      {below}
    </Box>
  )
}

/** The row above the band, as wide as what is under it: its mark, its words, its controls. */
function rowOf(els: Els, row: Row, width: number): RenderElement {
  const { Box, Text, Button } = els
  const bg = row.tone === 'ask' ? C.askBg : row.tone === 'warn' ? C.warnBg : C.infoBg
  const mark = row.tone === 'ask' ? '? ' : row.tone === 'warn' ? '! ' : row.key === 'notice' ? '· ' : '↪ '
  const markColor = row.tone === 'ask' ? C.accent : row.tone === 'warn' ? C.orange : C.aqua
  const link = (a: Act) => a.run
    ? <Button key={a.key} label={a.label} plain dimColor={!a.main} onPress={a.run} />
    : <Text key={a.key} color={C.dim}>{a.label}</Text>
  const acts = [...row.acts, ...(row.close ? [row.close] : [])]
  return (
    <Box key={row.key} backgroundColor={bg} paddingX={2} justifyContent="space-between" width={width}>
      <Text><Text bold color={markColor}>{mark}</Text>{row.detail ? `${row.title}: ${row.detail}` : row.title}</Text>
      {row.busy
        ? <Text color={C.dim}>working…</Text>
        : acts.length ? <Box gap={2}>{acts.map(link)}</Box> : <Text> </Text>}
    </Box>
  )
}

/** A terminal meter: a run of filled cells, then the track's. */
export function cellBar(els: Els): BarOf {
  const { Box, Text } = els
  return (fill, cells, color, rule) => {
    if (rule) return <Text color={C.track}>{'─'.repeat(cells)}</Text>
    const n = barFill(fill, cells)
    return (
      <Box>
        <Text color={color}>{'━'.repeat(n)}</Text>
        <Text color={C.track}>{'━'.repeat(Math.max(0, cells - n))}</Text>
      </Box>
    )
  }
}
