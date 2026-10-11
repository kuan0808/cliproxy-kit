// The band in the desktop app. Its text is set in a proportional font and its widths are CSS
// lengths, so nothing here counts characters: cards share the width and wrap, meters are rings
// and bars of real length, colors are the app's theme names (light or dark alike), and controls
// are its native buttons.
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

import { DESK, fmtDuration, fmtTokens, resetText } from './logic'
import type { BarOf } from './pane'
import { cacheCaption, type Act, type BandInput, type Do, type Facts, type Meter, type Row } from './view'

type Els = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Svg'>

/**
 * Ring and sign colors. An SVG is drawn as an image, which sees none of the theme's colors, so
 * these read on light and dark alike; `ink` is a neutral gray, for tracks and signs.
 */
const RING = { green: '#30a46c', yellow: '#e2a336', orange: '#ef7a33', red: '#e5484d', brand: '#d97757', ink: '#8b8b8b' }

const ringTone = (remaining: number) => remaining < 10 ? RING.red : remaining < 25 ? RING.orange : remaining < 50 ? RING.yellow : RING.green
/** The theme's text color for a remaining percentage, as the ring's: success, warning, error. */
const textTone = (remaining: number) => remaining < 10 ? DESK.red : remaining < 50 ? DESK.yellow : DESK.green

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** Labels and captions: the theme's muted text, a step below the secondary text of `dimColor`. */
const MUTED = 'subtle'
const n2 = (x: number) => Number(x.toFixed(2))
/** A control's label as a desktop button reads: a word capitalized, a name as written. */
const labelOf = (a: Act) => (a.name ? a.label : cap(a.label))

/** A ring gauge: arcs of a circle `size` px across, one per part, each drawn to its own fill (0 to 1). */
function ring(size: number, parts: { fill: number; color: string }[]): string {
  const stroke = size >= 30 ? 4 : 2.5
  const r = (size - stroke) / 2
  const mid = size / 2
  const round = 2 * Math.PI * r
  // Between the arcs of several parts, a gap as wide as the stroke.
  const gap = parts.length > 1 ? stroke * 1.6 : 0
  const seg = round / parts.length - gap
  const arcs = parts.map((p, k) => {
    const turn = -90 + (360 * k) / parts.length + (gap / 2 / round) * 360
    const at = `transform="rotate(${n2(turn)} ${mid} ${mid})"`
    const track = `<circle cx="${mid}" cy="${mid}" r="${n2(r)}" fill="none" stroke="${RING.ink}" stroke-opacity="0.3" stroke-width="${stroke}" stroke-dasharray="${n2(seg)} ${n2(round)}" ${at}/>`
    const len = seg * Math.max(0, Math.min(1, p.fill))
    const fill = len > 0
      ? `<circle cx="${mid}" cy="${mid}" r="${n2(r)}" fill="none" stroke="${p.color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${n2(Math.max(len, 0.01))} ${n2(round)}" ${at}/>`
      : ''
    return track + fill
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${arcs}</svg>`
}

/** The account's mark: its first letter on the brand color. */
function avatar(size: number, label: string): string {
  const letter = ([...label.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '?').toUpperCase().replace(/[<&>"]/g, '')
  const mid = size / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${mid}" cy="${mid}" r="${mid}" fill="${RING.brand}"/><text x="${mid}" y="${n2(mid + size * 0.18)}" text-anchor="middle" font-size="${n2(size * 0.52)}" font-weight="600" fill="#fff">${letter}</text></svg>`
}

/** The row's sign: a triangle for a warning, a question mark for a question, an i for the rest. */
function sign(tone: Row['tone']): string {
  const color = tone === 'warn' ? RING.orange : RING.ink
  const body = tone === 'warn'
    ? `<path d="M8 2.2 14.2 13H1.8z" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.2" r=".85" fill="${color}"/>`
    : tone === 'ask'
      ? `<circle cx="8" cy="8" r="6.3" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".85" fill="${color}"/>`
      : `<circle cx="8" cy="8" r="6.3" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M8 7.3v3.6" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5.2" r=".85" fill="${color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>`
}

export type DeskSite = { bodyColumns: number; working: boolean; beneath: boolean }

export function desktopBand(els: Els, i: BandInput, f: Facts, act: Do, site: DeskSite, below: RenderElement): RenderElement {
  const { Box, Text, Button, Svg } = els
  const { ui } = i
  // Cards while Claude waits and one strip while it works, unless the reader chose otherwise for
  // this stretch, as in the terminal.
  const phase = site.working ? 'working' : 'idle'
  const chosen = ui.viewPhase === phase && ui.viewTurn === ui.turns ? ui.viewOverride : ''
  const strip = chosen === 'line' || (!chosen && (site.working || site.beneath))
  const setView = (view: 'cards' | 'line') => act.ui({ viewOverride: view, viewPhase: phase, viewTurn: ui.turns })

  const button = (a: Act, main = a.main) => a.run
    ? <Button key={a.key} label={labelOf(a)} variant={main ? 'primary' : undefined} onPress={a.run} />
    : <Text key={a.key} color={MUTED}>{a.label}</Text>
  // A lesser control: the app's borderless button, dim until the pointer is on it.
  const link = (a: Act) => <Button key={a.key} label={labelOf(a)} plain dimColor onPress={a.run ?? (() => undefined)} />
  const c = f.cache
  const cold = c.state === 'cold'
  // What a meter reads as: used, with the colour of what is left.
  const usedPct = (m: Meter) => `${Math.round(100 - m.remaining)}%${m.stale ? '~' : ''}`
  const cacheWord = f.isCodex
    ? c.rate == null ? 'Waiting' : `Hit ${Math.round(c.rate * 100)}%`
    : c.state === 'unknown' ? 'Waiting' : cap(c.state)
  const cacheText = f.isCodex
    ? c.rate == null ? DESK.dim : textTone(c.rate * 100)
    : c.state === 'warm' ? DESK.green : c.state === 'expiring' ? DESK.yellow : cold ? DESK.red : DESK.dim
  const cacheRing = f.isCodex
    ? { fill: c.rate ?? 0, color: ringTone((c.rate ?? 0) * 100) }
    : { fill: c.frac, color: c.state === 'expiring' ? RING.yellow : RING.green }

  // -- the row above the band --
  const top = f.top ? rowCard(els, f.top) : null

  if (strip) {
    // One line: who and what, a small ring per meter, the way into the cards.
    const mini = (key: string, label: string, ringSvg: string, value: string, tone: string, tail = '', alt = label) => (
      <Box key={`meter-${key}`} gap={1} alignItems="center">
        <Svg source={ringSvg} alt={`${alt}: ${value}`} width={15} height={15} />
        <Text color={MUTED}>{label}</Text>
        <Text bold color={tone}>{value}</Text>
        {tail ? <Text color={MUTED}>{tail}</Text> : null}
      </Box>
    )
    // Reset times only where the line has room for them.
    const roomy = site.bodyColumns >= 140
    const meters: RenderChildren[] = []
    if (f.ctx) meters.push(mini('ctx', 'ctx', ring(15, [{ fill: 1 - f.ctx.left / 100, color: ringTone(f.ctx.left) }]), `${Math.round(100 - f.ctx.left)}%`, textTone(f.ctx.left), '', 'Context used'))
    for (const [key, label, m] of [['5h', '5h', f.five], ['7d', '7d', f.week]] as const) {
      if (m) meters.push(mini(key, label, ring(15, [{ fill: 1 - m.remaining / 100, color: m.stale ? RING.ink : ringTone(m.remaining) }]), usedPct(m), m.stale ? DESK.dim : textTone(m.remaining), roomy ? m.reset : '', `${m.label} quota used`))
    }
    meters.push(mini('cache', 'cache', ring(15, [cacheRing]),
      f.isCodex ? cacheWord : c.state === 'unknown' ? '—' : cold ? 'cold' : fmtDuration(c.leftMs), cacheText, '', 'Prompt cache'))
    return (
      <Box flexDirection="column" gap={1}>
        {top}
        <Box key="strip" alignItems="center" justifyContent="space-between" columnGap={2} paddingX={1}>
          <Box key="meters" alignItems="center" columnGap={roomy ? 3 : 2} flexWrap="wrap" flexShrink={1} minWidth={0}>
            <Box key="who" gap={1} alignItems="center">
              <Svg source={avatar(18, f.account)} alt={`Account ${f.account}`} width={18} height={18} />
              <Text bold>{f.account}</Text>
              <Text color={f.route ? DESK.aqua : MUTED}>{f.route ? `→ ${f.route}` : `${f.modelName}${f.effort ? ` · ${f.effort}` : ''}`}</Text>
            </Box>
            {meters}
          </Box>
          <Box key="controls" columnGap={1} alignItems="center" flexShrink={0}>
            {f.controls.switch ? link(f.controls.switch) : null}
            {link({ key: 'view-cards', label: 'more', run: () => setView('cards') })}
          </Box>
        </Box>
        {below}
      </Box>
    )
  }

  // -- cards: who and the controls, then a ring per meter --
  // Six in a row, else rows of three or two, so the cards of every row line up; each shares its
  // row evenly.
  const card = (key: string, children: RenderChildren[]) => (
    <Box key={key} borderStyle="round" flexGrow={1} width={0} minWidth={0} alignItems="center" gap={2}>
      {children}
    </Box>
  )
  const gauge = (key: string, label: string, ringSvg: string, alt: string, value: RenderChildren, caption: string) => card(key, [
    <Svg key="ring" source={ringSvg} alt={alt} width={40} height={40} />,
    <Box key="words" flexDirection="column" flexGrow={1} minWidth={0}>
      <Text color={MUTED} wrap="truncate-end">{label}</Text>
      {value}
      <Text color={MUTED} wrap="truncate-end">{caption}</Text>
    </Box>,
  ])
  const usedText = (m: Meter | undefined) => m
    ? <Text wrap="truncate-end"><Text bold color={m.stale ? DESK.dim : textTone(m.remaining)}>{usedPct(m)}</Text><Text color={MUTED}> used</Text></Text>
    : <Text bold color={MUTED}>—</Text>
  const meterRing = (m: Meter | undefined) => ring(40, [{ fill: m ? 1 - m.remaining / 100 : 0, color: m?.stale ? RING.ink : ringTone(m?.remaining ?? 100) }])

  const cards: RenderChildren[] = []
  const subtitle = f.route ? `→ ${f.route}` : [f.modelName, f.effort].filter(Boolean).join(' · ')
  cards.push(
    <Box key="account" borderStyle="round" flexGrow={1} width={0} minWidth={0} flexDirection="column" gap={1} justifyContent="space-between">
      <Box gap={1} alignItems="center">
        <Svg source={avatar(28, f.account)} alt={`Account ${f.account}`} width={28} height={28} />
        <Box flexDirection="column" minWidth={0} flexGrow={1}>
          <Box justifyContent="space-between" alignItems="center" gap={1}>
            <Text wrap="truncate-end"><Text bold>{f.account}</Text>{f.note ? <Text color={MUTED}>{`  ${f.note}`}</Text> : null}</Text>
            {link({ key: 'view-line', label: 'less', run: () => setView('line') })}
          </Box>
          <Text color={f.route ? DESK.aqua : MUTED} wrap="truncate-end">{subtitle}</Text>
        </Box>
      </Box>
      <Box columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
        {f.controls.unroute ? button(f.controls.unroute, false) : null}
        {f.controls.switch ? button(f.controls.switch, false) : null}
        {link(f.controls.quota)}
      </Box>
    </Box>,
  )
  cards.push(gauge('five', '5-hour', meterRing(f.five), `5-hour quota: ${f.five ? `${usedPct(f.five)} used` : 'no reading'}`,
    usedText(f.five), f.five ? resetText(f.five.reset) : f.fiveMissing))
  cards.push(gauge('week', f.week?.label ?? 'Weekly', meterRing(f.week), `${f.week?.label ?? 'Weekly'} quota: ${f.week ? `${usedPct(f.week)} used` : 'no reading'}`,
    usedText(f.week), f.week ? resetText(f.week.reset) : f.weekMissing))
  const ctx = f.ctx
  cards.push(gauge('ctx', 'Context',
    ring(40, [{ fill: ctx ? 1 - ctx.left / 100 : 0, color: ringTone(ctx?.left ?? 100) }]),
    `Context: ${ctx ? `${Math.round(100 - ctx.left)}% used` : 'not known yet'}`,
    ctx
      ? <Text wrap="truncate-end"><Text bold color={textTone(ctx.left)}>{`${Math.round(100 - ctx.left)}%`}</Text><Text color={MUTED}> used</Text></Text>
      : <Text bold color={MUTED}>—</Text>,
    ctx ? `${fmtTokens(ctx.used)} of ${fmtTokens(ctx.window)}` : 'after the first reply'))
  cards.push(gauge('cache', 'Cache', ring(40, [cacheRing]), `Prompt cache: ${cacheWord}`,
    <Text bold color={cacheText} wrap="truncate-end">{cacheWord}</Text>,
    cacheCaption(f, true)))
  // The proxy's accounts, which a direct login has none of.
  const pool = f.pool
  if (f.proxied) cards.push(gauge('all', 'Accounts',
    ring(40, pool && pool.parts.length ? pool.parts.map(p => ({ fill: p === null ? 0 : 1 - p / 100, color: p === null ? RING.ink : ringTone(p) })) : [{ fill: 0, color: RING.green }]),
    `All accounts: ${pool?.left == null ? 'no reading' : `${100 - pool.left}% used`}`,
    pool?.left != null
      ? <Text wrap="truncate-end"><Text bold color={pool.stale ? DESK.dim : textTone(pool.left)}>{`${Math.round(100 - pool.left)}%${pool.stale ? '~' : ''}`}</Text><Text color={MUTED}> used</Text></Text>
      : <Text bold color={MUTED}>—</Text>,
    pool?.caption ?? 'no quota data'))

  // All in a row where they fit, else rows of three or two; a short last row keeps the columns
  // of the rows above it.
  const MIN = 26
  const perRow = [cards.length, 3, 2, 1].find(n => site.bodyColumns >= n * MIN + n - 1) ?? 1
  const rows: RenderChildren[][] = []
  for (let k = 0; k < cards.length; k += perRow) rows.push(cards.slice(k, k + perRow))
  const last = rows[rows.length - 1]!
  for (let k = last.length; k < perRow; k++) last.push(<Box key={`spare-${k}`} flexGrow={1} width={0} />)
  return (
    <Box flexDirection="column" gap={1}>
      {top}
      <Box key="cards" flexDirection="column" gap={1}>
        {rows.map((r, k) => <Box key={`cards-${k}`} gap={1}>{r}</Box>)}
      </Box>
      {below}
    </Box>
  )
}

/** The row above the band as a card: its sign, its words, its controls, a close control for alerts. */
function rowCard(els: Els, row: Row): RenderElement {
  const { Box, Text, Button, Svg } = els
  const border = row.tone === 'warn' ? DESK.orange : row.tone === 'ask' ? DESK.aqua : undefined
  return (
    <Box key={row.key} borderStyle="round" borderColor={border} gap={2} alignItems="center" justifyContent="space-between">
      <Box key="words" gap={1} alignItems="center" flexGrow={1} flexShrink={1} minWidth={0}>
        <Svg source={sign(row.tone)} alt={row.tone === 'warn' ? 'Warning' : row.tone === 'ask' ? 'Question' : 'Note'} width={16} height={16} />
        <Text>
          <Text bold>{row.title}</Text>
          {row.detail ? <Text color={MUTED}>{` ${cap(row.detail)}`}</Text> : null}
        </Text>
      </Box>
      <Box key="acts" gap={1} alignItems="center" flexShrink={row.acts.length > 3 ? 1 : 0} flexWrap="wrap" justifyContent="flex-end">
        {row.busy ? <Text color={MUTED}>Working…</Text> : null}
        {row.busy ? null : row.acts.map(a => a.run
          ? <Button key={a.key} label={labelOf(a)} variant={a.main ? 'primary' : undefined} onPress={a.run} />
          : <Text key={a.key} color={MUTED}>{a.label}</Text>)}
        {row.busy || !row.close ? null : row.key === 'ask'
          ? <Button key={row.close.key} label={cap(row.close.label)} onPress={row.close.run!} />
          : <Button key={row.close.key} label={cap(row.close.label)} role="dismiss" onPress={row.close.run!} />}
      </Box>
    </Box>
  )
}

/** A desktop meter: a rounded track of real length with its fill, or a hairline for a divider. */
export function lengthBar(els: Els): BarOf {
  const { Box } = els
  return (fill, cells, color, rule) => {
    if (rule) return <Box width="100%" height={0.06} backgroundColor={DESK.track} />
    const pct = Math.round(Math.max(0, Math.min(1, fill)) * 100)
    return (
      <Box width={cells} height={0.4} backgroundColor={DESK.track} borderStyle="round" borderColor={DESK.track} padding={0} overflow="hidden">
        {pct > 0 ? <Box width={`${pct}%`} height="100%" backgroundColor={color} /> : null}
      </Box>
    )
  }
}
