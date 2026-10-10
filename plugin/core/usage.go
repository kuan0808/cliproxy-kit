package core

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// The usage log keeps one line per request served through the proxy and one per quota poll, so
// the panel can show where an account's weekly quota went. It stores ids and counts only, never
// prompt or answer text.

// LogEntry is one line of the usage log.
type LogEntry struct {
	T          int64    `json:"t"`           // unix milliseconds
	Seq        uint64   `json:"-"`           // the order it was written in, among lines of one time: set by the log's index
	Session    string   `json:"s,omitempty"` // Claude Code's session id of the main conversation
	Agent      bool     `json:"a,omitempty"` // sent by a subagent or a fork of that session
	Account    string   `json:"acct"`
	Provider   string   `json:"p"`
	Model      string   `json:"m,omitempty"`
	Input      int64    `json:"i,omitempty"`
	Output     int64    `json:"o,omitempty"`
	CacheRead  int64    `json:"cr,omitempty"`
	CacheWrite int64    `json:"cw,omitempty"`
	Poll       bool     `json:"poll,omitempty"` // a reading with no request behind it: a poll, or a refused request
	Used5h     *float64 `json:"u5,omitempty"`   // part of the 5-hour window used, as the provider reported it
	Reset5     int64    `json:"r5,omitempty"`   // when that 5-hour window resets (unix milliseconds), when the reading says
	Used7d     *float64 `json:"u7,omitempty"`   // part of the weekly window used
	Reset7     int64    `json:"r7,omitempty"`   // when that weekly window resets (unix milliseconds), when the reading says
	TierAsked  string   `json:"ta,omitempty"`   // the speed asked for: a service tier (Codex's Fast is "priority"), "fast" for Claude's fast mode, "auto" for none
	TierServed string   `json:"ts,omitempty"`   // the service tier the provider reported serving it at
	Remote     bool     `json:"rm,omitempty"`   // it reached the proxy from another device
	Plan       string   `json:"pl,omitempty"`   // a line of its own: the account's plan changed to this
}

// DayOf names the calendar day, in loc, of a unix-millisecond time.
var DayOf = func(ms int64, loc *time.Location) string { return time.UnixMilli(ms).In(loc).Format("2006-01-02") }

// readingOf is a log line holding what observed windows read: the used part of the 5-hour and
// weekly windows, and when each resets.
func readingOf(windows []Window) (LogEntry, bool) {
	var e LogEntry
	for _, w := range windows {
		used := clamp01(1 - w.Remaining)
		switch w.Kind {
		case KindFiveHour:
			e.Used5h = &used
			if !w.ResetAt.IsZero() {
				e.Reset5 = w.ResetAt.UnixMilli()
			}
		case KindWeekly:
			e.Used7d = &used
			if !w.ResetAt.IsZero() {
				e.Reset7 = w.ResetAt.UnixMilli()
			}
		}
	}
	return e, e.Used5h != nil || e.Used7d != nil
}

// TakeLog returns the log lines gathered since the last call.
func (s *State) TakeLog() []LogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.log
	s.log = nil
	return out
}

// keptLog is how many unwritten lines wait for the disk: days of traffic.
const keptLog = 50_000

// ReturnLog puts back lines that could not be written, ahead of the ones gathered since. While
// the disk refuses them for days, the oldest go first.
func (s *State) ReturnLog(lines []LogEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log = append(append([]LogEntry(nil), lines...), s.log...)
	if n := len(s.log); n > keptLog {
		s.log = s.log[n-keptLog:]
		s.noteErrorLocked(fmt.Sprintf("usage log: the disk refused writes for long; %d of the oldest lines were let go", n-keptLog))
	}
}

// modelTier scales a model's tokens to the others' the way their API prices relate.
func modelTier(model string) float64 {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"), strings.Contains(m, "fable"):
		return 5
	case strings.Contains(m, "sonnet"):
		return 3
	}
	return 1
}

// Weight is a request's draw on its account's quota relative to other requests: its cost at the
// speed it ran at. Only the ratios between requests matter; the provider's own quota readings set
// the totals.
func (e LogEntry) Weight() float64 { return e.Cost() * e.speedFactor() }

// Cost is what a request ran relative to other requests, whatever its speed: output costs five
// times input, cache writes twice (Claude Code writes the one-hour cache), cache reads a tenth,
// scaled by the model's price tier. A session's token mix, models and timeline show it.
func (e LogEntry) Cost() float64 {
	c := e.cost()
	return c.Input + c.Output + c.CacheRead + c.CacheWrite
}

// speedFactor is how much faster than standard speed a request draws on its account's plan quota.
// Codex's Fast uses included limits at 2.5 times the standard rate; Claude's fast mode is paid from
// usage credits, outside the plan's limits, so it draws none. Both are published by the providers.
func (e LogEntry) speedFactor() float64 {
	switch {
	case e.Provider == "codex" && (e.TierAsked == "priority" || e.TierAsked == "fast"):
		return 2.5
	case e.Provider == "claude" && e.TierAsked == "fast":
		return 0
	}
	return 1
}

// Weights is cost split by kind of token.
type Weights struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

// free tells a request that draws nothing on its account's plan quota (Claude's fast mode).
func (e LogEntry) free() bool { return e.speedFactor() == 0 }

func (e LogEntry) cost() Weights {
	tier := modelTier(e.Model)
	return Weights{
		Input: float64(e.Input) * tier, Output: 5 * float64(e.Output) * tier,
		CacheRead: 0.1 * float64(e.CacheRead) * tier, CacheWrite: 2 * float64(e.CacheWrite) * tier,
	}
}

// Composition sums requests, tokens and cost by kind of token.
type Composition struct {
	Requests int      `json:"requests"`
	Tokens   TokenSum `json:"tokens"`
	Weights  Weights  `json:"weights"`
}

// Add counts a request line; quota readings carry no tokens.
func (c *Composition) Add(e LogEntry) {
	if e.Poll {
		return
	}
	c.Requests++
	c.Tokens.Add(e)
	w := e.cost()
	c.Weights.Input += w.Input
	c.Weights.Output += w.Output
	c.Weights.CacheRead += w.CacheRead
	c.Weights.CacheWrite += w.CacheWrite
}

// ViewSession is the session a log line counts under in the panel. The proxy names a
// conversation sent without a session id after its content ("lcp:..."); no transcript matches
// those, so they count as requests without a session.
func ViewSession(id string) string {
	if strings.HasPrefix(id, "lcp:") {
		return ""
	}
	return id
}

// freshInput is the input that neither read nor wrote the cache. Anthropic reports the three
// apart; OpenAI-style providers (Codex) count cached tokens inside the input.
func freshInput(provider string, input, cacheRead, cacheWrite int64) int64 {
	if provider == "claude" {
		return input
	}
	if rest := input - cacheRead - cacheWrite; rest >= 0 {
		return rest
	}
	return input
}

// Tokens are summed token counts.
type TokenSum struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

func (t *TokenSum) Add(e LogEntry) {
	t.Input += e.Input
	t.Output += e.Output
	t.CacheRead += e.CacheRead
	t.CacheWrite += e.CacheWrite
}

// Share is one session's part of the usage in a period.
type Share struct {
	Session  string
	Used     float64 // part of one account's weekly quota
	Metered  bool    // some of its requests fell where quota readings exist
	Requests int
	Last     int64
	Tokens   TokenSum
	Days     map[string]float64 // Used by the local day of the requests
}

// Add adds another share's figures to this one.
func (s *Share) Add(o *Share) {
	s.Used += o.Used
	s.Metered = s.Metered || o.Metered
	s.Requests += o.Requests
	s.Tokens.Input += o.Tokens.Input
	s.Tokens.Output += o.Tokens.Output
	s.Tokens.CacheRead += o.Tokens.CacheRead
	s.Tokens.CacheWrite += o.Tokens.CacheWrite
	if o.Last > s.Last {
		s.Last = o.Last
	}
	for day, used := range o.Days {
		if s.Days == nil {
			s.Days = map[string]float64{}
		}
		s.Days[day] += used
	}
}

// Attribution is how an account's weekly (or 5-hour) quota in a span splits across sessions. Only
// what happened from the counting start on is counted; the walk before it learns the rate and the
// reading, so both are right where the counting begins.
type Attribution struct {
	Used      float64 // the account's use of its window at the last reading in the span
	Counted   float64 // what the counted part used: sessions, before logging and outside
	BeforeLog float64 // used before the log began, in a window that began inside the counted part
	Outside   float64 // used while no request went through the proxy (claude.ai, other tools)
	// Unplaced is use that may lie on either side of the counting start, so it is not counted: what
	// a window that began before it had used when the log began, and a rise read across it that no
	// request explains.
	Unplaced float64
	// Undated is the part of Outside read across midnight: it counts, but on no day.
	Undated float64
	Seen    bool // a reading of the span's window fell in the counted part; without one, Used is not known
	// Restart is, over one window, where a new window that started it over begins counting: its
	// earliest request, else the reading that told it. The requests before ran in the window before.
	Restart     int64
	Sessions    map[string]*Share  // by session id; "" for requests without one
	Pieces      []Piece            // each settled request's part, for the sessions the span keeps
	OutsideDays map[string]float64 // Outside read within one local day, by that day
	ReadDays    map[string]bool    // local days with a quota reading
	UndatedDays map[string]bool    // local days some of Undated may lie on
	// Periods are the windows the walk went through, oldest first, each with what it used: a range
	// walk can go through several.
	Periods []Period
}

// Period is one window an attribution walked: when it began, when it ended or resets, and what its
// counted part used.
type Period struct {
	From      int64              // when it began: where its reset time says, else where the walk saw it begin
	Reset     int64              // when it resets, when its readings say; 0 when they do not
	Ended     int64              // when the next window began, when that came before Reset; 0 otherwise
	Used      float64            // its last reading
	BeforeLog float64            // the first reading of a window that began before the log
	Outside   float64            // what no request explains
	Parts     map[string]float64 // each session's part, by session id
	Requests  int
	Tokens    TokenSum
}

// Span is the stretch of an account's log an attribution walks, and the part of it that counts.
type Span struct {
	From, To  int64 // the lines walked
	CountFrom int64 // what happened before it is walked, not counted
	LogStart  int64 // when the account's log began; when after From, the first reading holds use from before
	// Range walks across weekly windows: a reset begins the next window and the counting goes on.
	// Otherwise the span is one window, which an early reset starts over.
	Range bool
	// Five walks the 5-hour window instead of the weekly one: its readings, its resets, its length.
	Five bool
	// WindowStart is when the account's current window began. A reading that does not say when its
	// window resets is placed on the schedule that leads to it.
	WindowStart int64
	// Keep names sessions whose settled requests are kept one by one in Pieces; nil keeps none.
	Keep func(session string) bool
	// Loc is the time zone whose days the attribution's days are; nil is the proxy's.
	Loc *time.Location
}

// day names the day, in the span's time zone, of a unix-millisecond time.
func (s Span) day(ms int64) string {
	if s.Loc == nil {
		return DayOf(ms, time.Local)
	}
	return DayOf(ms, s.Loc)
}

// Piece is one settled request's part of the weekly quota, at the time it ran.
type Piece struct {
	T        int64
	Used     float64
	Provider string // set by whoever gathers pieces of several accounts
}

// Attribute splits an account's weekly quota over a span across sessions, or its 5-hour quota when
// the span says Five. Each time the window's reading rises, the rise is shared among the requests
// served since the last rise, in proportion to their weight; a rise with no such request counts as
// outside the proxy. The provider reports whole percents, so requests keep collecting until the
// reading moves.
//
// Each reading belongs to a window, named by its reset time or else by the account's schedule.
// Within a window the walk follows the highest reading, as polls and response headers can trail
// each other (96, 97, 96, 97); a reading of an earlier window, read late, is passed over. A new
// window shows as a later window, or as a fall that holds (see startsOver): a plan change or a reset
// the user asked for starts a window over without moving its reset.
func Attribute(entries []LogEntry, account string, s Span) Attribution {
	out := newAttribution()
	var last *float64
	// lastAt is the latest reading of the window, for telling a watched stretch from an unwatched
	// one; baseAt is the latest that held the reading a rise starts from, so a trailing reading
	// read in between does not move where the rise may have begun.
	window, lastAt, baseAt := int64(0), s.From, s.From
	var pending []LogEntry
	var seen rate
	// settle shares a rise, accrued since from and read at at, among the pending requests: each gets
	// what its weight explains at the rate learned so far, and the rest counts as use elsewhere
	// (claude.ai, another device). While readings come steadily a step of tolerance absorbs the
	// provider's whole-percent rounding; after a stretch without readings (the Mac slept, the proxy
	// idled or was off), or when a window began at a time not known, there is none. Parts of
	// requests from edge on that ran before the counting start may lie on either side of it.
	settle := func(rise float64, from, at, edge int64, learn, unsure bool) {
		limit := -1.0
		if len(pending) > 0 {
			if at-lastAt > unwatched || unsure {
				limit = seen.explains(pending)
			} else if seen.weight > 0 {
				limit = seen.explains(pending) + step
			}
		}
		if limit >= 0 && rise > limit {
			out.outside(rise-limit, from, at, s)
			rise = limit
		} else if learn && at-lastAt <= unwatched {
			seen.learn(rise, pending)
		}
		out.spread(rise, pending, from, at, edge, s)
		out.ran(pending, s.CountFrom)
		pending = nil
	}
	ordered := append([]LogEntry(nil), entries...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].T < ordered[j].T })
	over, stale := startsOver(ordered, account, s)
	for i, e := range ordered {
		if e.Account != account || e.T < s.From || e.T > s.To {
			continue
		}
		if e.Plan != "" {
			seen = rate{} // another plan: what a request uses is learned anew
			continue
		}
		// A request's reading comes with its response headers, before the request itself counts:
		// the reading settles the requests before it, then the request joins the pending ones.
		if used, reset := s.reading(e); used != nil {
			u, w := *used, windowStart(e, s)
			earlier := last != nil && w < window-WindowJitter || s.before(w) || stale[i]
			if !earlier && e.T >= s.CountFrom {
				out.Seen = true
				out.ReadDays[s.day(e.T)] = true
			}
			switch {
			case earlier:
				// A reading of an earlier window, or of the one before a start-over, read late: it says
				// nothing of this one.
			case last == nil || w > window+WindowJitter || over[i]:
				// The walk's first reading, or a new window's. Requests from before the window began ran
				// in an earlier one, whose reading after them never came; those just before it, within
				// what the reset times tell, may have run in either. A window known only by the fall of
				// the reading began at a time not known since the last reading: its requests may have
				// run in either window, and the first reading keeps for them only what their weight
				// explains.
				unsure := last != nil && w <= window+WindowJitter
				begun := w
				if unsure {
					begun = baseAt
				}
				if over[i] {
					// Started over in place, as a plan change does: what a request uses is learned anew.
					seen = rate{}
				}
				// Those left behind ran in the window before.
				kept := since(pending, begun-WindowJitter)
				out.ran(pending[:len(pending)-len(kept)], s.CountFrom)
				pending = kept
				edge := int64(math.MaxInt64)
				if begun+WindowJitter >= s.CountFrom {
					edge = begun - WindowJitter
				}
				if last != nil && !s.Range {
					// Over one window the next came early: the span starts over, with the requests it holds.
					days := out.ReadDays
					out = newAttribution()
					out.Seen, out.Restart, out.ReadDays = true, e.T, days
					if len(pending) > 0 {
						out.Restart = pending[0].T
					}
				}
				out.begin(begun, reset, over[i])
				if last != nil && !s.Range {
					for _, p := range pending {
						out.count(p, s.CountFrom)
					}
				}
				if last == nil && (s.LogStart > w || w < s.From) {
					// The log, or the walk, began after the window did: the first reading is what the
					// window had used before. It counts where the window began; a window that began
					// before the counting start holds use on both sides of it, in parts not known.
					switch {
					case w >= s.CountFrom:
						out.BeforeLog += u
						out.Counted += u
						out.period().BeforeLog += u
					case e.T >= s.CountFrom:
						out.Unplaced += u
					}
					out.ran(pending, s.CountFrom)
					pending = nil
				} else {
					// All of the window's first reading is use since it began.
					settle(u, begun, e.T, edge, false, unsure)
				}
				last, window, lastAt, baseAt = &u, w, e.T, e.T
			default:
				if u > *last {
					settle(u-*last, baseAt, e.T, math.MaxInt64, true, false)
					last = &u
				}
				if u >= *last {
					baseAt = e.T
				}
				lastAt = e.T
			}
			if p := out.period(); p != nil {
				p.Used = *last
				if p.Reset == 0 && reset > 0 && windowStart(e, s) == window {
					p.Reset = reset
				}
			}
		}
		if !e.Poll {
			out.count(e, s.CountFrom)
			pending = append(pending, e)
		}
	}
	if last != nil {
		out.Used = *last
	}
	out.ran(pending, s.CountFrom)
	return out
}

// startsOver runs the window rules (window.go) over the account's readings in the span: the readings
// at which a window starts over in place, and the late ones the walk passes over. A plan change
// comes as a line of its own. A fall read within lateReading of the span's end still waits, as it
// does in the live state.
func startsOver(ordered []LogEntry, account string, s Span) (over, stale map[int]bool) {
	over, stale = map[int]bool{}, map[int]bool{}
	k := track[int]{emit: func(i int, v verdict) {
		switch v {
		case restart:
			over[i] = true
		case late:
			stale[i] = true
		}
	}}
	for i, e := range ordered {
		if e.Account != account || e.T < s.From || e.T > s.To {
			continue
		}
		if e.Plan != "" {
			k.planChanged(e.T)
		}
		used, _ := s.reading(e)
		if used == nil {
			continue
		}
		if w := windowStart(e, s); s.before(w) {
			stale[i] = true // a reading of a window before the one the span walks
		} else {
			k.add(sample{e.T, w, *used}, i)
		}
	}
	k.settle(s.To)
	return over, stale
}

// before tells whether a window began before the one a single-window span walks.
func (s Span) before(w int64) bool {
	return !s.Range && s.WindowStart > 0 && w < s.WindowStart-WindowJitter
}

// since keeps the requests from t on.
func since(requests []LogEntry, t int64) []LogEntry {
	var out []LogEntry
	for _, e := range requests {
		if e.T >= t {
			out = append(out, e)
		}
	}
	return out
}

const weekMs = 7 * 24 * 3600 * 1000

// FiveMs is how long a 5-hour window runs.
const FiveMs = 5 * 3600 * 1000

// reading is what a line read of the span's window: its used part, and when that window resets.
func (s Span) reading(e LogEntry) (*float64, int64) {
	if s.Five {
		return e.Used5h, e.Reset5
	}
	return e.Used7d, e.Reset7
}

func (s Span) period() int64 {
	if s.Five {
		return FiveMs
	}
	return weekMs
}

// WindowJitter is how far apart a provider reports one weekly window's reset, and so its start:
// readings of one window name resets up to a minute apart, the next window's lie hours on.
const WindowJitter = 2 * 60 * 1000

// windowStart is when a reading's window began: a window's length before its reset when the
// reading says it, else on the schedule that leads to the account's current window, else the walk's
// start.
func windowStart(e LogEntry, s Span) int64 {
	_, reset := s.reading(e)
	switch {
	case reset > 0:
		return reset - s.period()
	case s.WindowStart > 0:
		w := s.WindowStart
		for w > e.T {
			w -= s.period()
		}
		return w
	}
	return s.From
}

// begin opens the window the walk entered at from: the window before it ended there, when it
// started over in place or that came before its reset.
func (a *Attribution) begin(from, reset int64, inPlace bool) {
	if p := a.period(); p != nil && (inPlace || p.Reset == 0 || from < p.Reset-WindowJitter) {
		p.Ended = from
	}
	a.Periods = append(a.Periods, Period{From: from, Reset: reset, Parts: map[string]float64{}})
}

// ran adds counted requests to the window they ran in, the one the walk is in when they leave the
// pending ones: settled by its reading, left behind by the next window, or still pending at the end.
func (a *Attribution) ran(requests []LogEntry, countFrom int64) {
	p := a.period()
	if p == nil {
		return
	}
	for _, e := range requests {
		if e.T >= countFrom {
			p.Requests++
			p.Tokens.Add(e)
		}
	}
}

// period is the window the walk is in; nil before its first reading.
func (a *Attribution) period() *Period {
	if len(a.Periods) == 0 {
		return nil
	}
	return &a.Periods[len(a.Periods)-1]
}

func newAttribution() Attribution {
	return Attribution{Sessions: map[string]*Share{}, OutsideDays: map[string]float64{}, ReadDays: map[string]bool{}, UndatedDays: map[string]bool{}}
}

// unwatched is how long readings can stop before a rise may include use the proxy never saw.
// Polls run every idle_poll_minutes (10 by default) while there is traffic.
const unwatched = 30 * 60 * 1000

// rate is how much quota a unit of weight has used, learned from rises read while the proxy was
// watching.
type rate struct{ rise, weight float64 }

func (r *rate) learn(rise float64, requests []LogEntry) {
	if w := weightOf(requests); w > 0 {
		r.rise += rise
		r.weight += w
	}
}

// explains is the part of a rise the requests account for: their weight at the learned rate, or
// one step before any rate is known.
func (r rate) explains(requests []LogEntry) float64 {
	if r.weight == 0 {
		return step
	}
	return weightOf(requests) * r.rise / r.weight
}

// step is the provider's reading resolution: whole percents.
const step = 0.01

func weightOf(requests []LogEntry) float64 {
	total := 0.0
	for _, e := range requests {
		total += e.Weight()
	}
	return total
}

// resetDrop is how far a reading must fall to count as a reset rather than a trailing reading. A reset that comes earlier than scheduled from below it goes unnoticed and leaves at
// most this much unattributed.
const resetDrop = 0.05

// count adds a counted request's tokens to its session's share.
func (a *Attribution) count(e LogEntry, countFrom int64) {
	if e.T < countFrom {
		return
	}
	sh := a.share(e.Session)
	sh.Requests++
	sh.Tokens.Add(e)
	if e.T > sh.Last {
		sh.Last = e.T
	}
}

func (a *Attribution) share(session string) *Share {
	sh := a.Sessions[session]
	if sh == nil {
		sh = &Share{Session: session, Days: map[string]float64{}}
		a.Sessions[session] = sh
	}
	return sh
}

// outside counts part of a rise, accrued since from and read at at, as used elsewhere. A rise read
// across the span's counting start, with no request to tell when it happened, is not placed; one
// read across midnight counts on no day.
func (a *Attribution) outside(x float64, from, at int64, s Span) {
	switch {
	case at < s.CountFrom:
	case from < s.CountFrom:
		a.Unplaced += x
	default:
		a.Outside += x
		a.Counted += x
		if p := a.period(); p != nil {
			p.Outside += x
		}
		if d := s.day(at); d == s.day(from) {
			a.OutsideDays[d] += x
		} else {
			a.Undated += x
			// Every day it may lie on: a step of half a day finds each, a short one too.
			for t := from; t < at; t += 12 * 3600 * 1000 {
				a.UndatedDays[s.day(t)] = true
			}
			a.UndatedDays[d] = true
		}
	}
}

// spread shares a rise, accrued since from and read at at, among the requests that caused it, by
// weight (equally when none weighs), counting the parts of requests from the span's counting start
// on; a request from edge on that ran before it may lie on either side of it. A request a reading
// settles is metered, whatever its part.
//
// A request that draws nothing on the plan (Claude's fast mode) takes no part, though it is settled:
// a rise only such requests ran beside is use elsewhere.
func (a *Attribution) spread(rise float64, requests []LogEntry, from, at, edge int64, s Span) {
	total, paid := 0.0, 0
	for _, e := range requests {
		if !e.free() {
			total += e.Weight()
			paid++
		}
	}
	if paid == 0 {
		a.outside(rise, from, at, s)
	}
	for _, e := range requests {
		part := 0.0
		switch {
		case e.free():
		case total > 0:
			part = e.Weight() / total
		default:
			part = 1 / float64(paid)
		}
		switch {
		case e.T >= s.CountFrom:
			if s.Keep != nil && s.Keep(e.Session) {
				a.Pieces = append(a.Pieces, Piece{T: e.T, Used: rise * part})
			}
			sh := a.share(e.Session)
			sh.Metered = true
			sh.Used += rise * part
			sh.Days[s.day(e.T)] += rise * part
			a.Counted += rise * part
			if p := a.period(); p != nil {
				p.Parts[e.Session] += rise * part
			}
		case e.T >= edge:
			a.Unplaced += rise * part
		}
	}
}

// Combine adds attributions of several accounts: each session's parts add up, in units of one
// account's weekly quota.
func Combine(parts []Attribution) Attribution {
	out := newAttribution()
	for _, a := range parts {
		out.Used += a.Used
		out.Counted += a.Counted
		out.BeforeLog += a.BeforeLog
		out.Unplaced += a.Unplaced
		out.Undated += a.Undated
		out.Outside += a.Outside
		out.Seen = out.Seen || a.Seen
		for id, sh := range a.Sessions {
			out.share(id).Add(sh)
		}
		for day, x := range a.OutsideDays {
			out.OutsideDays[day] += x
		}
		for day := range a.ReadDays {
			out.ReadDays[day] = true
		}
		for day := range a.UndatedDays {
			out.UndatedDays[day] = true
		}
	}
	return out
}

// Part is a named share of weight.
type Part struct {
	Name   string  `json:"name"`
	Weight float64 `json:"weight"`
}

// Bucket is one stretch of a session's time, starting at At (unix milliseconds): what it used and
// what used it.
type Bucket struct {
	At        int64    `json:"at"`
	Weight    float64  `json:"weight"` // what it ran: its requests' cost (see LogEntry.Cost)
	Requests  int      `json:"requests"`
	Tokens    TokenSum `json:"tokens"`
	Agent     float64  `json:"agent"`     // cost sent by subagents
	Models    []Part   `json:"models"`    // cost by model, largest first
	Accounts  []Part   `json:"accounts"`  // cost by account; "" when not known
	Providers []Part   `json:"providers"` // cost by provider
	// Quota is each provider's part of one account's weekly quota in the stretch, from the
	// requests readings settled; a provider whose requests none settled is not in it.
	Quota map[string]float64 `json:"quota,omitempty"`
}

// SessionDetail is one session's usage, read from its log lines.
type SessionDetail struct {
	First       int64       `json:"first"`
	Last        int64       `json:"last"`
	Composition Composition `json:"composition"`
	Unit        string      `json:"unit"` // bucket length: "10m", "hour" or "day"
	Buckets     []Bucket    `json:"buckets"`
	Models      []Part      `json:"models"`
	Agent       float64     `json:"agent"` // cost sent by subagents
	Accounts    []Part      `json:"accounts"`
	Tiers       []Tier      `json:"tiers"` // most requests first
}

// Tier is how many of a session's requests to a provider asked for one service tier and were
// reported served at another; "" where the request asked for none or the provider did not say.
type Tier struct {
	Provider string `json:"provider"`
	Asked    string `json:"asked"`
	Served   string `json:"served"`
	Requests int    `json:"requests"`
}

// Detail describes a session from its own lines, with buckets in loc: ten minutes for a short
// session, hours for a day's, days beyond two days. Pieces, the session's settled requests, give
// each stretch its quota. Accounts include "" for requests whose account is not known.
func Detail(entries []LogEntry, pieces []Piece, loc *time.Location) SessionDetail {
	out := SessionDetail{Models: []Part{}, Accounts: []Part{}, Buckets: []Bucket{}, Tiers: []Tier{}}
	models, accounts := map[string]float64{}, map[string]float64{}
	tiers := map[Tier]int{}
	for _, e := range entries {
		if e.Poll {
			continue
		}
		if out.First == 0 || e.T < out.First {
			out.First = e.T
		}
		if e.T > out.Last {
			out.Last = e.T
		}
		out.Composition.Add(e)
		w := e.Cost()
		models[e.Model] += w
		if e.Agent {
			out.Agent += w
		}
		accounts[e.Account] += w // "" when the account is not known
		tiers[Tier{Provider: e.Provider, Asked: e.TierAsked, Served: e.TierServed}]++
	}
	out.Models, out.Accounts = parts(models), parts(accounts)
	for t, n := range tiers {
		t.Requests = n
		out.Tiers = append(out.Tiers, t)
	}
	sort.Slice(out.Tiers, func(i, j int) bool {
		a, b := out.Tiers[i], out.Tiers[j]
		if a.Requests != b.Requests {
			return a.Requests > b.Requests
		}
		return a.Provider+"|"+a.Asked+"|"+a.Served < b.Provider+"|"+b.Asked+"|"+b.Served
	})
	if out.First == 0 {
		return out
	}
	first, last := time.UnixMilli(out.First).In(loc), time.UnixMilli(out.Last).In(loc)
	var start func(time.Time) time.Time
	var step func(time.Time) time.Time
	switch span := last.Sub(first); {
	case span > 48*time.Hour:
		out.Unit = "day"
		start = func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc) }
		step = func(t time.Time) time.Time { return t.AddDate(0, 0, 1) }
	case span > 3*time.Hour:
		out.Unit = "hour"
		start = func(t time.Time) time.Time { return t.Truncate(time.Hour) }
		step = func(t time.Time) time.Time { return t.Add(time.Hour) }
	default:
		out.Unit = "10m"
		start = func(t time.Time) time.Time { return t.Truncate(10 * time.Minute) }
		step = func(t time.Time) time.Time { return t.Add(10 * time.Minute) }
	}
	index := map[int64]int{}
	for t := start(first); !t.After(last); t = step(t) {
		index[t.UnixMilli()] = len(out.Buckets)
		out.Buckets = append(out.Buckets, Bucket{At: t.UnixMilli()})
	}
	at := func(t int64) (int, bool) {
		i, ok := index[start(time.UnixMilli(t).In(loc)).UnixMilli()]
		return i, ok
	}
	type mix struct{ models, accounts, providers map[string]float64 }
	mixes := make([]mix, len(out.Buckets))
	for _, e := range entries {
		i, ok := at(e.T)
		if e.Poll || !ok {
			continue
		}
		b, m, w := &out.Buckets[i], &mixes[i], e.Cost()
		if m.models == nil {
			m.models, m.accounts, m.providers = map[string]float64{}, map[string]float64{}, map[string]float64{}
		}
		b.Weight += w
		b.Requests++
		b.Tokens.Add(e)
		if e.Agent {
			b.Agent += w
		}
		m.models[e.Model] += w
		m.accounts[e.Account] += w
		m.providers[e.Provider] += w
	}
	for _, p := range pieces {
		if i, ok := at(p.T); ok {
			b := &out.Buckets[i]
			if b.Quota == nil {
				b.Quota = map[string]float64{}
			}
			b.Quota[p.Provider] += p.Used
		}
	}
	for i := range out.Buckets {
		b, m := &out.Buckets[i], mixes[i]
		b.Models, b.Accounts, b.Providers = parts(m.models), parts(m.accounts), parts(m.providers)
	}
	return out
}

// parts lists a map's shares, largest first.
func parts(m map[string]float64) []Part {
	out := make([]Part, 0, len(m))
	for name, w := range m {
		out = append(out, Part{Name: name, Weight: w})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Weight > out[j].Weight || (out[i].Weight == out[j].Weight && out[i].Name < out[j].Name)
	})
	return out
}
