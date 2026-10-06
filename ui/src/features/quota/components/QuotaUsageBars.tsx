/**
 * Bars a pointer, a tap or the arrow keys can pick, with the picked bar's figures in a card
 * beneath. The latest bar with any use is picked to begin with, so the card always says
 * something and the page does not shift as the pointer moves; the bar the card describes is
 * ringed. Only the picked bar takes the tab stop, so the chart is one stop for the keyboard.
 */

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import styles from './QuotaUsage.module.scss';

export interface PickableBar {
  key: string;
  /** The bar's figures in a sentence: its button's accessible name. */
  label: string;
  /** Stacked from the bottom; empty for a bar whose use is not known. */
  segments: { colour: string; x: number }[];
  /** Drawn hatched: nothing known but tokens. */
  muted?: boolean;
}

export function PickableBars({
  label,
  bars,
  peak,
  axis,
  detail,
  className,
}: {
  label: string;
  bars: PickableBar[];
  peak: number;
  /** Drawn between the bars and the card. */
  axis?: ReactNode;
  /** The card for a bar. */
  detail: (index: number) => ReactNode;
  className?: string;
}) {
  // The bar pointed at shows over the one picked; the picked one keeps the tab stop.
  const [picked, setPicked] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // To begin with, the latest bar with any use, else the latest.
  let start = bars.length - 1;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].segments.some((s) => s.x > 0)) {
      start = i;
      break;
    }
  }
  const chosen = picked !== null && picked < bars.length ? picked : Math.max(0, start);
  const shown = hovered !== null && hovered < bars.length ? hovered : chosen;
  const walk = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step || bars.length === 0) return;
    e.preventDefault();
    const from = [...e.currentTarget.children].indexOf(document.activeElement as Element);
    const next = Math.min(bars.length - 1, Math.max(0, (from >= 0 ? from : chosen) + step));
    setPicked(next);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <>
      <div
        className={className ? `${styles.chart} ${className}` : styles.chart}
        role="group"
        aria-label={label}
        onKeyDown={walk}
        onMouseLeave={() => setHovered(null)}
      >
        {bars.map((bar, i) => (
          <button
            key={bar.key}
            type="button"
            className={bar.muted ? `${styles.chartDay} ${styles.chartUnread}` : styles.chartDay}
            aria-label={bar.label}
            aria-pressed={chosen === i}
            tabIndex={i === chosen ? 0 : -1}
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setPicked(i)}
            onClick={() => setPicked(i)}
          >
            {!bar.muted &&
              bar.segments
                .filter((s) => s.x > 0)
                .map((s, j) => (
                  <span
                    key={j}
                    style={{
                      height: `${peak > 0 ? (s.x / peak) * 100 : 0}%`,
                      background: s.colour,
                    }}
                  />
                ))}
          </button>
        ))}
      </div>
      {axis}
      {bars.length > 0 && detail(shown)}
    </>
  );
}

/**
 * A bar's figures: a title and its headline figure, then the same rows for every bar, so the card
 * keeps its shape from one bar to the next. A row with nothing to say shows a dash.
 */
export function BarCard({
  title,
  figure,
  quiet,
  rows,
}: {
  title: string;
  figure: ReactNode;
  /** The figure says what is not known rather than a number. */
  quiet?: boolean;
  rows: { label: string; value: ReactNode }[];
}) {
  return (
    <div className={styles.barCard}>
      <div className={styles.barCardHead}>
        <strong>{title}</strong>
        <span className={quiet ? styles.barCardQuiet : styles.barCardFigure}>{figure}</span>
      </div>
      <dl className={styles.barCardRows}>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
