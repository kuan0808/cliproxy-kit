package core

import "time"

// A quota window's readings come from two sources that trail each other, the response headers and
// the usage endpoint, so one set of rules decides which reading tells what a window has used, for
// the live state and for the usage report alike:
//
//   - a reading names its window by when it resets; one naming an earlier window is a late one;
//   - within a window use only grows: the highest reading stands, in whatever order they came, and
//     a reading older than one already taken says nothing newer (a long request's headers, timed
//     when it was sent, can arrive after a poll);
//   - a later reset begins the next window;
//   - a fall of more than resetDrop below the window's highest starts it over in place (a plan
//     change, a reset the user asked for) when it settles: the last of the window's readings
//     within lateReading after it is nearer the fall than the highest, or none comes. One that
//     settles back up was a late reading (50, 40, 50). The readings in between wait for that
//     decision; after a start-over, those nearer the old highest are late readings of the window
//     before (26, 0, 26, 0);
//   - after the plan changes, any fall that settles starts the window over.
//
// A fall waits at most lateReading, so the live state takes a start-over that late, and the report
// leaves one read within lateReading of its end undecided, as the live state does then.

// lateReading is how far readings trail each other: the usage endpoint and the response headers by
// seconds, a reading in flight across a reset by a request's length.
const lateReading = 5 * 60 * 1000

// planChange is how long after a plan change a fall of any size counts as a start-over.
const planChange = 60 * 60 * 1000

// verdict is what a reading tells of its window.
type verdict int

const (
	counts  verdict = iota // a reading of the current window
	begins                 // the first reading, or one naming a later reset: the next window
	restart                // a fall that settled: the window starts over here
	late                   // of an earlier window, or of the window before a start-over
)

// sample is one reading as the rules see it: when it was read, its window's key (a reset, or a
// start placed on the schedule; later windows have larger keys), and the part used.
type sample struct {
	t, w int64
	u    float64
}

// track applies the rules to one window kind of one account, reading by reading, and tells each
// reading's verdict to emit, a fall's once it is decided.
type track[T any] struct {
	emit    func(T, verdict)
	started bool
	w       int64   // the current window's key
	peak    float64 // its highest reading since it began
	last    int64   // when its latest reading taken was read
	planAt  int64   // when the plan last changed
	until   int64   // after a start-over, until when the window before may still be read
	mid     float64 // and above what a reading is nearer that window's highest than the fall
	fall    *fall[T]
}

// fall is a fall waiting for the readings after it.
type fall[T any] struct {
	s     sample
	tag   T
	peak  float64 // the window's highest before it
	last  float64 // the latest reading of the window read since
	lastT int64   // when that was read
	seen  bool    // one came
	held  []held[T]
	plain bool // within planChange of a plan change
}

type held[T any] struct {
	s   sample
	tag T
}

// add takes the next reading in the order they were read.
func (k *track[T]) add(s sample, tag T) {
	if k.fall != nil && s.t-k.fall.s.t > lateReading {
		k.decide()
	}
	switch {
	case !k.started:
		k.started, k.w, k.peak, k.last = true, s.w, s.u, s.t
		k.emit(tag, begins)
	case s.w < k.w-WindowJitter:
		k.emit(tag, late)
	case s.w > k.w+WindowJitter:
		if k.fall != nil {
			k.decide() // its window ended; what came before decides it
		}
		k.w, k.peak, k.until, k.last = s.w, s.u, 0, s.t
		k.emit(tag, begins)
	case k.fall != nil:
		// Only what was read after the fall tells where it settled.
		if s.t >= k.fall.s.t && s.t >= k.fall.lastT {
			k.fall.last, k.fall.lastT, k.fall.seen = s.u, s.t, true
		}
		k.fall.held = append(k.fall.held, held[T]{s, tag})
	default:
		k.same(s, tag)
	}
}

// same takes a reading of the current window with no fall waiting.
func (k *track[T]) same(s sample, tag T) {
	drop := resetDrop
	if k.planAt > 0 && s.t >= k.planAt && s.t-k.planAt <= planChange {
		drop = 0
	}
	switch {
	case s.t <= k.until && s.u > k.mid:
		k.emit(tag, late)
	case s.u < k.peak-drop && s.t < k.last:
		k.emit(tag, late) // read before a reading already taken, which stood higher
	case s.u < k.peak-drop:
		k.fall = &fall[T]{s: s, tag: tag, peak: k.peak}
	default:
		k.peak, k.last = max(k.peak, s.u), max(k.last, s.t)
		k.emit(tag, counts)
	}
}

// decide settles the waiting fall, then takes the readings that waited behind it.
func (k *track[T]) decide() {
	f := k.fall
	k.fall = nil
	mid := (f.peak + f.s.u) / 2
	if !f.seen || f.last <= mid {
		k.peak, k.until, k.mid, k.last = f.s.u, f.s.t+lateReading, mid, f.s.t
		k.emit(f.tag, restart)
	} else {
		k.emit(f.tag, counts)
	}
	for _, h := range f.held {
		k.add(h.s, h.tag)
	}
}

// settle decides a fall that has waited lateReading by now.
func (k *track[T]) settle(now int64) {
	if k.fall != nil && now-k.fall.s.t > lateReading {
		k.decide()
	}
}

// planChanged notes when the plan changed.
func (k *track[T]) planChanged(t int64) {
	k.planAt = t
}

// observe applies one reading to the account's window of its kind by the window rules.
func (c *Cred) observe(w Window) {
	k := c.tracks[w.Kind]
	if k == nil {
		k = c.trackOf(w.Kind)
	}
	key := w.ResetAt.UnixMilli()
	if w.ResetAt.IsZero() {
		key = k.w // a reading that does not say its reset counts in the current window
	}
	k.add(sample{w.ObservedAt.UnixMilli(), key, 1 - w.Remaining}, w)
}

// trackOf starts the rules for a window kind from the reading in force, kept across a restart.
func (c *Cred) trackOf(kind string) *track[Window] {
	k := &track[Window]{emit: c.apply}
	if !c.planAt.IsZero() {
		k.planAt = c.planAt.UnixMilli()
	}
	if old, ok := c.Windows[kind]; ok {
		k.started, k.w, k.peak, k.last = true, old.ResetAt.UnixMilli(), 1-old.Remaining, old.ObservedAt.UnixMilli()
	}
	if c.tracks == nil {
		c.tracks = map[string]*track[Window]{}
	}
	c.tracks[kind] = k
	return k
}

// apply takes a reading's verdict into the window in force.
func (c *Cred) apply(w Window, v verdict) {
	switch v {
	case begins, restart:
		if v == restart {
			c.startedOver = w.ObservedAt
		}
	case counts:
		if old, ok := c.Windows[w.Kind]; ok {
			w.Remaining = min(w.Remaining, old.Remaining) // the highest use stands
			if w.ResetAt.IsZero() {
				w.ResetAt = old.ResetAt
			}
			if old.ObservedAt.After(w.ObservedAt) {
				w.ObservedAt, w.Source = old.ObservedAt, old.Source
			}
		}
	default:
		return
	}
	c.Windows[w.Kind] = w
	delete(c.Absent, w.Kind)
}

// settle decides a fall of a window kind that has waited long enough by now.
func (c *Cred) settle(kind string, now time.Time) {
	if k := c.tracks[kind]; k != nil {
		k.settle(now.UnixMilli())
	}
}

// planChanged lets a fall of any size start the account's windows over for a while.
func (c *Cred) planChanged(at time.Time) {
	c.planAt = at
	for _, k := range c.tracks {
		k.planChanged(at.UnixMilli())
	}
}

// absentAfter takes a full reading of the provider's usage endpoint: a window kind it does not name
// is one the account does not have (a plan without a 5-hour window, a model window gone).
func (c *Cred) absentAfter(windows []Window) {
	named := map[string]bool{}
	for _, w := range windows {
		named[w.Kind] = true
	}
	// Every kind such a reading can name, as a Claude model's own window another account has.
	kinds := []string{KindFiveHour, KindWeekly}
	if c.Provider == "claude" {
		kinds = claudePollKinds
	}
	kinds = append([]string(nil), kinds...)
	for kind := range c.Windows {
		kinds = append(kinds, kind)
	}
	for _, kind := range kinds {
		if !named[kind] {
			delete(c.Windows, kind)
			delete(c.tracks, kind)
			if c.Absent == nil {
				c.Absent = map[string]bool{}
			}
			c.Absent[kind] = true
		}
	}
}
