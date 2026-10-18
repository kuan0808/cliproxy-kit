// The quota pane: every account of every provider with each window it reports, then what the
// plugin and the band are set to. Both surfaces draw it, each meter in its own way. Without
// accounts to list (a direct login, no quota data) the band's own settings still show.
import type { Elements, RenderChildren, RenderElement } from 'claude-code'

import type { Snap } from '../types'
import { blockedOthers, fmtDuration, kindLabel, missingText, restingNow, sevIn, untilIso, type Palette, type SessionAccount } from './logic'
import type { SettingRow } from './view'

/** What both surfaces' tables have, which is all the pane draws with. */
type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** A meter as the surface draws it: `fill` of it (0 to 1) in `color`, `cells` wide; `rule` draws a divider instead. */
export type BarOf = (fill: number, cells: number, color: string, rule?: boolean) => RenderChildren

/**
 * The pane: what heads it (every account, or why there are none), then what the plugin and the
 * band are set to, as a two-column list whose rows may carry a control.
 */
export function quotaPane(els: Els, P: Palette, head: RenderChildren[], items: SettingRow[], bodyColumns: number, bar: BarOf, lastError?: string): RenderElement {
  const { Box, Text, Button } = els
  const cols = Math.max(36, bodyColumns - 1)
  const rows = [...head]
  const keyWidth = Math.max(...items.map(r => r.label.length)) + 2
  rows.push(<Box key="rule" width={cols}>{bar(0, cols, P.track, true)}</Box>)
  for (const { label, value, act } of items) {
    rows.push(
      <Box key={`set-${label}`} width={cols}>
        <Box width={keyWidth} flexShrink={0}><Text color={P.dim}>{label}</Text></Box>
        <Text wrap="truncate-end">{value}</Text>
        {act?.run ? <Box paddingLeft={2} flexShrink={0}><Button key={act.key} label={act.label} plain onPress={act.run} /></Box> : null}
      </Box>,
    )
  }
  if (lastError) rows.push(<Text key="err" color={P.orange} wrap="truncate-end">{`last plugin error: ${lastError}`}</Text>)
  return <Box flexDirection="column">{rows}</Box>
}

/** Every account of every provider with each window it reports, and what the plugin is set to. */
export function accountsPart(els: Els, P: Palette, snap: Snap, acct: SessionAccount | null, now: number, bodyColumns: number, bar: BarOf): { rows: RenderChildren[]; items: SettingRow[] } {
  const { Box, Text } = els
  const cols = Math.max(36, bodyColumns - 1)
  // label, percent, bar, time to reset: the bar takes what is left, up to 24 cells.
  const LABEL = 14
  const PCT = 5
  const RESET = 8
  const barCells = Math.max(6, Math.min(24, cols - LABEL - PCT - RESET - 2))
  const title = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1)
  const rows: RenderChildren[] = []
  for (const [provider, view] of Object.entries(snap.providers)) {
    const health = view.health === 'healthy' ? ['ready', P.green] : view.health === 'exhausted' ? ['used up', P.red] : ['unknown', P.dim]
    rows.push(
      <Box key={`h-${provider}`} marginTop={rows.length ? 1 : 0} width={cols} justifyContent="space-between">
        <Text bold color={P.fg}>{title(provider)}</Text>
        <Text color={health[1]}>{health[0]}</Text>
      </Box>,
    )
    // Every kind any account of the provider reports, or says it has not, so the accounts line up
    // row by row.
    const kinds = [...new Set(view.credentials.flatMap(c => [...c.windows.map(w => w.kind), ...(c.absent ?? [])]))]
      .sort((a, b) => (a === '5h' ? -1 : b === '5h' ? 1 : a === '7d' ? -1 : b === '7d' ? 1 : a.localeCompare(b)))
    for (const c of view.credentials) {
      const mine = acct?.session.auth_id === c.id
      const blocked = c.tier === 3
      // A resting account, in the form of a limited one: why, and when it is tried again.
      const rest = restingNow(c, now) ? `${c.reason}, back in ${fmtDuration(Date.parse(c.rest!.until) - now)}` : ''
      const same = c.same_as ? view.credentials.find(x => x.id === c.same_as)?.label : undefined
      rows.push(
        <Box key={`c-${c.id}`} marginTop={1} width={cols} justifyContent="space-between">
          <Text bold color={mine ? P.accent : P.fg}>{c.label}</Text>
          {mine ? <Text color={P.accent}>this session</Text> : null}
        </Box>,
        <Text key={`s-${c.id}`} color={blocked || rest ? P.orange : P.dim} wrap="truncate-end">
          {[c.plan, same ? `same account as ${same}` : '', blocked ? blockedOthers({ ...view, credentials: [c] }, '', now).replace(`${c.label} `, '') : rest, !blocked && !rest && c.sessions ? `${c.sessions} ${c.sessions === 1 ? 'session' : 'sessions'}` : ''].filter(Boolean).join(' · ') || ' '}
        </Text>,
      )
      for (const kind of kinds) {
        const w = c.windows.find(x => x.kind === kind)
        const left = w ? Math.round(w.remaining * 100) : 0
        const tone = !w || w.stale ? P.dim : sevIn(P, left)
        const label = w?.label ?? kindLabel(kind)
        rows.push(
          <Box key={`w-${c.id}-${kind}`} width={cols} alignItems="center">
            <Box width={LABEL} flexShrink={0}><Text color={P.dim}>{label}</Text></Box>
            <Box width={PCT} flexShrink={0} justifyContent="flex-end"><Text bold color={tone}>{w ? `${100 - left}%${w.stale ? '~' : ''}` : '—'}</Text></Box>
            <Box width={barCells + 2} paddingX={1} flexShrink={0}>{bar(w ? 1 - w.remaining : 0, barCells, tone)}</Box>
            <Text color={P.dim} wrap="truncate-end">{w ? untilIso(w.reset_at, now) : missingText(c, kind)}</Text>
          </Box>,
        )
      }
    }
  }
  // What the plugin is set to, in words.
  const fallbacks = Object.entries(snap.config.fallback_map)
  // When the newest quota reading was taken, not when the snapshot was: a meter's own reading
  // grown old shows "~".
  const lastRead = Math.max(0, ...Object.values(snap.providers).flatMap(v => v.credentials.flatMap(c => c.windows.map(w => Date.parse(w.observed_at) || 0))))
  const items: [string, string][] = [
    ...fallbacks.map(([from, to]): [string, string] => {
      const [provider, model] = to.split(':')
      return [`When ${title(from)} is used up`, model ? `use ${model} (${title(provider ?? '')})` : to]
    }),
    ['Switch automatically', snap.config.cross_provider === 'auto' ? 'on' : 'off'],
    ['New sessions avoid', `accounts that have used over ${100 - snap.config.min_five_hour_left_percent}% of their 5-hour quota`],
    ['Quota last read', lastRead ? (now - lastRead < 30_000 ? 'just now' : `${fmtDuration(now - lastRead)} ago`) : 'not yet'],
  ]
  return { rows, items: items.map(([label, value]) => ({ label, value })) }
}
