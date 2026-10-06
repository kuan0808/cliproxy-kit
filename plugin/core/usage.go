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
	Used7d     *float64 `json:"u7,omitempty"`   // part of the weekly window used
	Reset7     int64    `json:"r7,omitempty"`   // when that weekly window resets (unix milliseconds), when the reading says
	Count      int      `json:"n,omitempty"`    // requests the line sums: recovered history sums an hour; 0 is one
	First      int64    `json:"f,omitempty"`    // a line summing several requests: when the first ran (T is the last)
	History    bool     `json:"-"`              // recovered from Claude Code's transcripts rather than logged
}

// requests is how many requests the line stands for.
func (e LogEntry) requests() int {
	return max(e.Count, 1)
}

// DayOf names the local calendar day of a unix-millisecond time.
var DayOf = func(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") }

// readingOf is a log line holding what observed windows read: the used part of the 5-hour and
// weekly windows, and when the weekly one resets.
func readingOf(windows []Window) (LogEntry, bool) {
	var e LogEntry
	for _, w := range windows {
		used := clamp01(1 - w.Remaining)
		switch w.Kind {
		case KindFiveHour:
			e.Used5h = &used
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

// Weight is a request's usage relative to other requests: output costs five times input, cache
// writes twice (Claude Code writes the one-hour cache), cache reads a tenth, scaled by the model's
// price tier. Only the ratios between requests matter; the provider's own quota readings set the
// totals.
func (e LogEntry) Weight() float64 {
	w := e.weights()
	return w.Input + w.Output + w.CacheRead + w.CacheWrite
}

// Weights is weight split by kind of token.
type Weights struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read"`
	CacheWrite float64 `json:"cache_write"`
}

func (e LogEntry) weights() Weights {
	tier := modelTier(e.Model)
	return Weights{
		Input: float64(e.Input) * tier, Output: 5 * float64(e.Output) * tier,
		CacheRead: 0.1 * float64(e.CacheRead) * tier, CacheWrite: 2 * float64(e.CacheWrite) * tier,
	}
}

// Composition sums requests, tokens and weight by kind of token.
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
	c.Requests += e.requests()
	c.Tokens.Add(e)
	w := e.weights()
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

// Attribution is how an account's weekly quota in a span splits across sessions. Only what
// happened from the counting start on is counted; the walk before it learns the rate and the
// reading, so both are right where the counting begins.
type Attribution struct {
	Used      float64 // the account's weekly use at the last reading in the span
	Counted   float64 // what the counted part used: sessions, before logging and outside
	BeforeLog float64 // used before the log began, in a window that began inside the counted part
	Outside   float64 // used while no request went through the proxy (claude.ai, other tools)
	// Unplaced is use that may lie on either side of the counting start, so it is not counted: what
	// a window that began before it had used when the log began, and a rise read across it that no
	// request explains.
	Unplaced float64
	// Undated is the part of Outside read across midnight: it counts, but on no day.
	Undated     float64
	Seen        bool               // a reading of the span's window fell in the counted part; without one, Used is not known
	Restart     int64              // over one week, when a new window started it over: the earliest a request of it can have run
	Sessions    map[string]*Share  // by session id; "" for requests without one
	Pieces      []Piece            // each settled request's part, for the sessions the span keeps
	OutsideDays map[string]float64 // Outside read within one local day, by that day
	ReadDays    map[string]bool    // local days with a quota reading
}

// Span is the stretch of an account's log an attribution walks, and the part of it that counts.
type Span struct {
	From, To  int64 // the lines walked
	CountFrom int64 // what happened before it is walked, not counted
	LogStart  int64 // when the account's log began; when after From, the first reading holds use from before
	// Range walks across weekly windows: a reset begins the next window and the counting goes on.
	// Otherwise the span is one week, which an early reset starts over.
	Range bool
	// Week is when the account's current weekly window began. A reading that does not say when its
	// window resets is placed on the weekly schedule that leads to it.
	Week int64
	// Keep names sessions whose settled requests are kept one by one in Pieces; nil keeps none.
	Keep func(session string) bool
}

// Piece is one settled request's part of the weekly quota, at the time it ran.
type Piece struct {
	T        int64
	Used     float64
	Provider string // set by whoever gathers pieces of several accounts
}

// Attribute splits an account's weekly quota over a span across sessions. Each time the weekly
// reading rises, the rise is shared among the requests served since the last rise, in proportion
// to their weight; a rise with no such request counts as outside the proxy. The provider reports
// whole percents, so requests keep collecting until the reading moves.
//
// Each reading belongs to a weekly window, named by its reset time or else by the account's weekly
// schedule. Within a window the walk follows the highest reading, as polls and response headers
// can trail each other (96, 97, 96, 97); a reading of an earlier window, read late, is passed over.
// A new window shows as a later window, or, from readings that do not say theirs, as a fall of more
// than resetDrop.
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
			out.outside(rise-limit, from, at, s.CountFrom)
			rise = limit
		} else if learn && at-lastAt <= unwatched {
			seen.learn(rise, pending)
		}
		out.spread(rise, pending, from, at, s.CountFrom, edge, s.Keep)
		pending = nil
	}
	ordered := append([]LogEntry(nil), entries...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].T < ordered[j].T })
	for _, e := range ordered {
		if e.Account != account || e.T < s.From || e.T > s.To {
			continue
		}
		// A request's reading comes with its response headers, before the request itself counts:
		// the reading settles the requests before it, then the request joins the pending ones.
		if e.Used7d != nil {
			u, w := *e.Used7d, windowStart(e, s)
			earlier := last != nil && w < window-WindowJitter ||
				!s.Range && s.Week > 0 && w < s.Week-WindowJitter // over one week, a window before it
			if !earlier && e.T >= s.CountFrom {
				out.Seen = true
				out.ReadDays[DayOf(e.T)] = true
			}
			switch {
			case earlier:
				// A reading of an earlier window, read late: it says nothing of this one.
			case last == nil || w > window+WindowJitter || e.Reset7 == 0 && u < *last-resetDrop:
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
				pending = since(pending, begun-WindowJitter)
				edge := int64(math.MaxInt64)
				if begun+WindowJitter >= s.CountFrom {
					edge = begun - WindowJitter
				}
				if last != nil && !s.Range {
					// Over one week the window came early: the week starts over.
					days := out.ReadDays
					out = newAttribution()
					out.Seen, out.Restart, out.ReadDays = true, begun-WindowJitter, days
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
					case e.T >= s.CountFrom:
						out.Unplaced += u
					}
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
		}
		if !e.Poll {
			out.count(e, s.CountFrom)
			pending = append(pending, e)
		}
	}
	if last != nil {
		out.Used = *last
	}
	return out
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

// WindowJitter is how far apart a provider reports one weekly window's reset, and so its start:
// readings of one window name resets up to a minute apart, the next window's lie hours on.
const WindowJitter = 2 * 60 * 1000

// windowStart is when a reading's weekly window began: a week before its reset when the reading
// says it, else on the weekly schedule that leads to the account's current window, else the walk's
// start.
func windowStart(e LogEntry, s Span) int64 {
	switch {
	case e.Reset7 > 0:
		return e.Reset7 - weekMs
	case s.Week > 0:
		w := s.Week
		for w > e.T {
			w -= weekMs
		}
		return w
	}
	return s.From
}

func newAttribution() Attribution {
	return Attribution{Sessions: map[string]*Share{}, OutsideDays: map[string]float64{}, ReadDays: map[string]bool{}}
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

// resetDrop is how far a weekly reading must fall to count as a reset rather than a trailing
// reading. A reset that comes earlier than scheduled from below it goes unnoticed and leaves at
// most this much unattributed.
const resetDrop = 0.05

// count adds a counted request's tokens to its session's share.
func (a *Attribution) count(e LogEntry, countFrom int64) {
	if e.T < countFrom {
		return
	}
	sh := a.share(e.Session)
	sh.Requests += e.requests()
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
// across the counting start, with no request to tell when it happened, is not placed; one read
// across midnight counts on no day.
func (a *Attribution) outside(x float64, from, at, countFrom int64) {
	switch {
	case at < countFrom:
	case from < countFrom:
		a.Unplaced += x
	default:
		a.Outside += x
		a.Counted += x
		if day := DayOf(at); day == DayOf(from) {
			a.OutsideDays[day] += x
		} else {
			a.Undated += x
		}
	}
}

// spread shares a rise, accrued since from and read at at, among the requests that caused it, by
// weight (equally when none weighs), counting the parts of requests from countFrom on; a request
// from edge on that ran before countFrom may lie on either side of it. A request a reading settles
// is metered, whatever its part.
func (a *Attribution) spread(rise float64, requests []LogEntry, from, at, countFrom, edge int64, keep func(string) bool) {
	if len(requests) == 0 {
		a.outside(rise, from, at, countFrom)
		return
	}
	total := weightOf(requests)
	for _, e := range requests {
		part := 1 / float64(len(requests))
		if total > 0 {
			part = e.Weight() / total
		}
		switch {
		case e.T >= countFrom:
			if keep != nil && keep(e.Session) {
				a.Pieces = append(a.Pieces, Piece{T: e.T, Used: rise * part})
			}
			sh := a.share(e.Session)
			sh.Metered = true
			sh.Used += rise * part
			sh.Days[DayOf(e.T)] += rise * part
			a.Counted += rise * part
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
	Weight    float64  `json:"weight"`
	Requests  int      `json:"requests"`
	Tokens    TokenSum `json:"tokens"`
	Agent     float64  `json:"agent"`     // weight sent by subagents
	Models    []Part   `json:"models"`    // weight by model, largest first
	Accounts  []Part   `json:"accounts"`  // weight by account; "" when not known
	Providers []Part   `json:"providers"` // weight by provider
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
	Agent       float64     `json:"agent"`   // weight sent by subagents
	History     bool        `json:"history"` // includes lines recovered from transcripts, which sum an hour
	Accounts    []Part      `json:"accounts"`
}

// Detail describes a session from its own lines, with buckets in loc: ten minutes for a short
// session, hours for a day's, days beyond two days. Pieces, the session's settled requests, give
// each stretch its quota. Accounts include "" for requests whose account is not known.
func Detail(entries []LogEntry, pieces []Piece, loc *time.Location) SessionDetail {
	out := SessionDetail{Models: []Part{}, Accounts: []Part{}, Buckets: []Bucket{}}
	models, accounts := map[string]float64{}, map[string]float64{}
	for _, e := range entries {
		if e.Poll {
			continue
		}
		first := e.T
		if e.First > 0 && e.First < first {
			first = e.First
		}
		if out.First == 0 || first < out.First {
			out.First = first
		}
		if e.T > out.Last {
			out.Last = e.T
		}
		out.Composition.Add(e)
		w := e.Weight()
		models[e.Model] += w
		if e.Agent {
			out.Agent += w
		}
		out.History = out.History || e.History
		accounts[e.Account] += w // "" when the account is not known
	}
	out.Models, out.Accounts = parts(models), parts(accounts)
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
	case span > 3*time.Hour || out.History: // a recovered line sums an hour
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
		b, m, w := &out.Buckets[i], &mixes[i], e.Weight()
		if m.models == nil {
			m.models, m.accounts, m.providers = map[string]float64{}, map[string]float64{}, map[string]float64{}
		}
		b.Weight += w
		b.Requests += e.requests()
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
