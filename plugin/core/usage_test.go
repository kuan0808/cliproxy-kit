package core

import (
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"
)

const day = int64(24 * 3600 * 1000)

func f(v float64) *float64 { return &v }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestAttributeSharesEachRiseByWeight(t *testing.T) {
	entries := []LogEntry{
		{T: 10, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100},
		// A request's reading is taken before it counts: this 4% is s1's.
		{T: 20, Session: "s2", Account: "A", Model: "claude-opus-5-5", Output: 300, Used7d: f(0.04)},
		// The reading does not move: the requests keep collecting until it does.
		{T: 30, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.04)},
		{T: 40, Session: "s2", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.05)}, // 3:1
		{T: 50, Account: "A", Poll: true, Used7d: f(0.05)},
		{T: 55, Account: "A", Poll: true, Used7d: f(0.06)}, // the s2 request at 40
		// A rise with no request since the last reading: outside.
		{T: 60, Account: "A", Poll: true, Used7d: f(0.08)},
		{T: 70, Session: "s9", Account: "B", Output: 999, Used7d: f(0.5)}, // another account
	}
	a := Attribute(entries, "A", Span{To: 100})
	if !near(a.Sessions["s1"].Used, 0.04+0.0025) || !near(a.Sessions["s2"].Used, 0.0075+0.01) {
		t.Fatalf("shares = s1 %v, s2 %v", a.Sessions["s1"].Used, a.Sessions["s2"].Used)
	}
	if !near(a.Outside, 0.02) || !near(a.Used, 0.08) || a.BeforeLog != 0 {
		t.Fatalf("outside %v used %v before %v", a.Outside, a.Used, a.BeforeLog)
	}
	if _, ok := a.Sessions["s9"]; ok || a.Sessions["s1"].Requests != 2 || a.Sessions["s2"].Tokens.Output != 400 {
		t.Fatalf("sessions = %+v", a.Sessions)
	}
}

func TestAttributeLeavesUseWhileUnwatchedOutside(t *testing.T) {
	night := int64(8 * 3600 * 1000)
	entries := []LogEntry{
		{T: 1, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.50)},
		{T: 2, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.51)}, // 1% per request
		// Overnight on the phone: the morning's first reading is 5% up, one request's worth is s1's.
		{T: 2 + night, Session: "s2", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.56)},
	}
	a := Attribute(entries, "A", Span{To: 3 * night, LogStart: 1})
	if !near(a.Sessions["s1"].Used, 0.02) || !near(a.Outside, 0.04) || a.Sessions["s2"].Used != 0 || !near(a.Used, 0.56) {
		t.Fatalf("s1 %v s2 %v outside %v used %v", a.Sessions["s1"].Used, a.Sessions["s2"].Used, a.Outside, a.Used)
	}
	// Before any rise has been read, the pending requests keep one whole percent.
	a = Attribute(append(entries[:1:1], LogEntry{T: night, Account: "A", Poll: true, Used7d: f(0.55)}), "A", Span{To: 3 * night, LogStart: 1})
	if !near(a.Sessions["s1"].Used, 0.01) || !near(a.Outside, 0.04) {
		t.Fatalf("s1 %v outside %v", a.Sessions["s1"].Used, a.Outside)
	}
}

func TestAttributeLogStartedInsideThePeriod(t *testing.T) {
	entries := []LogEntry{
		{T: 50, Session: "s1", Account: "A", Output: 10, Used7d: f(0.30)},
		{T: 60, Session: "s1", Account: "A", Output: 10, Used7d: f(0.32)},
	}
	a := Attribute(entries, "A", Span{To: 100, LogStart: 40})
	if !near(a.BeforeLog, 0.30) || !near(a.Sessions["s1"].Used, 0.02) || !near(a.Used, 0.32) {
		t.Fatalf("before %v session %v used %v", a.BeforeLog, a.Sessions["s1"].Used, a.Used)
	}
}

func TestAttributeIgnoresReadingsThatTrailByAStep(t *testing.T) {
	// The live log of 2026-10-05: polls and headers disagree by one whole percent.
	entries := []LogEntry{
		{T: 10, Account: "A", Poll: true, Used7d: f(0.96)},
		{T: 20, Account: "A", Poll: true, Used7d: f(0.97)},
		{T: 21, Session: "s1", Account: "A", Output: 10, Used7d: f(0.96)},
		{T: 30, Session: "s1", Account: "A", Output: 10, Used7d: f(0.97)},
		{T: 40, Account: "A", Poll: true, Used7d: f(0.98)},
		{T: 41, Session: "s2", Account: "A", Output: 10, Used7d: f(0.97)},
		{T: 50, Session: "s2", Account: "A", Output: 10, Used7d: f(0.98)},
	}
	a := Attribute(entries, "A", Span{To: 100, LogStart: 5})
	sum := 0.0
	for _, sh := range a.Sessions {
		sum += sh.Used
	}
	if !near(a.BeforeLog, 0.96) || !near(a.Used, 0.98) || !near(sum+a.Outside, 0.02) {
		t.Fatalf("before %v used %v sessions %v outside %v", a.BeforeLog, a.Used, sum, a.Outside)
	}
}

func TestAttributeStartsOverAfterAReset(t *testing.T) {
	entries := []LogEntry{
		{T: 10, Session: "s1", Account: "A", Output: 10, Used7d: f(0.90)},
		{T: 20, Session: "s2", Account: "A", Output: 10, Used7d: f(0.01)},
		{T: 30, Session: "s2", Account: "A", Output: 10, Used7d: f(0.03)},
	}
	a := Attribute(entries, "A", Span{To: 100})
	// Only the new period counts: the s1 request before the reset shares its first reading.
	if !near(a.Sessions["s1"].Used, 0.01) || !near(a.Sessions["s2"].Used, 0.02) || !near(a.Used, 0.03) || a.Outside != 0 {
		t.Fatalf("after reset: s1 %v s2 %v used %v outside %v", a.Sessions["s1"].Used, a.Sessions["s2"].Used, a.Used, a.Outside)
	}
}

func TestWeightFollowsPriceRatios(t *testing.T) {
	opus := LogEntry{Model: "claude-opus-5-5", Output: 1}
	haiku := LogEntry{Model: "claude-haiku-4-5", Output: 1}
	cached := LogEntry{Model: "claude-haiku-4-5", CacheRead: 10}
	written := LogEntry{Model: "claude-haiku-4-5", CacheWrite: 5}
	if opus.Weight() != 5*haiku.Weight() || cached.Weight() != haiku.Weight()/5 || written.Weight() != 2*haiku.Weight() {
		t.Fatalf("weights opus %v haiku %v cached %v written %v", opus.Weight(), haiku.Weight(), cached.Weight(), written.Weight())
	}
}

func TestFreshInputLeavesCachedTokensOut(t *testing.T) {
	if got := freshInput("claude", 30, 700, 50); got != 30 {
		t.Fatalf("claude reports input apart from the cache, got %d", got)
	}
	if got := freshInput("codex", 1000, 900, 0); got != 100 {
		t.Fatalf("codex counts cached tokens inside the input, got %d", got)
	}
	if got := freshInput("codex", 100, 900, 0); got != 100 {
		t.Fatalf("inconsistent counts keep the input, got %d", got)
	}
}

func TestObserveAndPollsWriteTheLog(t *testing.T) {
	s, c := newTestState()
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.33")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1791590400")
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1:agent:x", ParentID: "claude:s1",
		AuthID: "claude-a", RequestedAt: c.t, Output: 7, ResponseHeader: h})
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true})
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 0.6, ObservedAt: c.t.Add(time.Minute)}})
	log := s.TakeLog()
	if len(log) != 2 || log[0].Session != "s1" || !log[0].Agent || log[0].Output != 7 || !near(*log[0].Used7d, 0.33) {
		t.Fatalf("request line = %+v", log)
	}
	if !log[1].Poll || !near(*log[1].Used7d, 0.4) || len(s.TakeLog()) != 0 {
		t.Fatalf("poll line = %+v", log[1])
	}
}

func TestCombineFollowsASessionAcrossASwitch(t *testing.T) {
	entries := []LogEntry{
		{T: 10, Session: "s1", Account: "A", Output: 10, Used7d: f(0.97)},
		{T: 20, Session: "s1", Account: "A", Output: 10, Used7d: f(0.99)},
		{T: 30, Session: "s1", Account: "A", Output: 10, Used7d: f(1.00)},
		{T: 35, Account: "A", Poll: true, Used7d: f(1.00)},
		// A is used up; the session goes on on B.
		{T: 40, Session: "s1", Account: "B", Output: 10, Used7d: f(0.00)},
		{T: 50, Session: "s1", Account: "B", Output: 10, Used7d: f(0.01)},
		{T: 60, Session: "s2", Account: "B", Output: 10, Used7d: f(0.02)},
	}
	both := Combine([]Attribution{Attribute(entries, "A", Span{To: 100, LogStart: 5}), Attribute(entries, "B", Span{To: 100, LogStart: 5})})
	if !near(both.Sessions["s1"].Used, 0.05) || both.Sessions["s2"].Used != 0 || !near(both.Used, 1.02) || !near(both.BeforeLog, 0.97) {
		t.Fatalf("combined = s1 %v s2 %v used %v before %v", both.Sessions["s1"].Used, both.Sessions["s2"].Used, both.Used, both.BeforeLog)
	}
	if both.Sessions["s1"].Requests != 5 {
		t.Fatalf("requests = %d", both.Sessions["s1"].Requests)
	}
}

// A session's requests are counted by the tier each asked for and the tier it was served at.
func TestDetailCountsServiceTiers(t *testing.T) {
	d := Detail([]LogEntry{
		{T: 1000, Provider: "codex", Output: 10, TierAsked: "priority", TierServed: "default"},
		{T: 2000, Provider: "codex", Output: 10, TierAsked: "priority", TierServed: "default"},
		{T: 3000, Provider: "codex", Output: 10, TierAsked: "priority", TierServed: "priority"},
		{T: 4000, Provider: "claude", Output: 10, Count: 3},
	}, nil, time.UTC)
	want := []Tier{{"claude", "", "", 3}, {"codex", "priority", "default", 2}, {"codex", "priority", "priority", 1}}
	if fmt.Sprint(d.Tiers) != fmt.Sprint(want) {
		t.Fatalf("tiers = %+v", d.Tiers)
	}
}

func TestDetailBucketsBySessionLength(t *testing.T) {
	tw := time.FixedZone("TW", 8*3600)
	at := func(h, m int) int64 { return time.Date(2026, 10, 5, h, m, 0, 0, tw).UnixMilli() }
	d := Detail([]LogEntry{
		{T: at(12, 3), Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 10},
		{T: at(12, 8), Session: "s1", Agent: true, Account: "B", Model: "claude-haiku-4-5", Output: 10},
		{T: at(12, 9), Account: "A", Poll: true, Used7d: f(0.5)},
		{T: at(12, 27), Session: "s1", Account: "A", Provider: "codex", Model: "gpt-6.1-sol", Output: 10, CacheRead: 400},
	}, []Piece{{T: at(12, 3), Used: 0.01, Provider: "claude"}, {T: at(12, 8), Used: 0, Provider: "claude"}}, tw)
	if d.Unit != "10m" || len(d.Buckets) != 3 || d.Buckets[0].At != at(12, 0) || d.Buckets[1].Weight != 0 ||
		d.Buckets[0].Requests != 2 || d.Buckets[2].Requests != 1 {
		t.Fatalf("buckets %s %+v", d.Unit, d.Buckets)
	}
	if d.Composition.Requests != 3 || d.Models[0].Name != "claude-opus-5-5" || d.Accounts[0].Name != "A" {
		t.Fatalf("detail = %+v", d)
	}
	// Each stretch says what ran in it, and its quota where readings settled its requests.
	first, last := d.Buckets[0], d.Buckets[2]
	if first.Tokens.Output != 20 || !near(first.Agent, 50) || len(first.Models) != 2 || first.Accounts[0].Name != "A" ||
		len(first.Accounts) != 2 || !near(first.Quota["claude"], 0.01) {
		t.Fatalf("first stretch = %+v", first)
	}
	if last.Providers[0].Name != "codex" || last.Tokens.CacheRead != 400 || last.Quota != nil || d.Buckets[1].Models != nil && len(d.Buckets[1].Models) != 0 {
		t.Fatalf("last stretch = %+v, middle %+v", last, d.Buckets[1])
	}
	h := Detail([]LogEntry{{T: at(8, 0), Session: "s1", Model: "claude-opus-5-5", Output: 10}, {T: at(12, 0), Session: "s1", Account: "A", Output: 1}}, nil, tw)
	if h.Unit != "hour" || len(h.Buckets) != 5 || h.First != at(8, 0) {
		t.Fatalf("over four hours: %+v", h)
	}
	if len(h.Accounts) != 2 || h.Accounts[0].Name != "" {
		t.Fatalf("an unknown account is listed: %+v", h.Accounts)
	}
}

func TestUseElsewhereDuringLocalWorkCountsAsOutside(t *testing.T) {
	var entries []LogEntry
	// Steady work: every 1% comes with about the same weight of requests.
	for i := 0; i < 5; i++ {
		entries = append(entries,
			LogEntry{T: int64(10 * (2*i + 1)), Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100},
			LogEntry{T: int64(10 * (2*i + 2)), Account: "A", Poll: true, Used7d: f(0.50 + 0.01*float64(i+1))})
	}
	// Then 4% goes up while one more such request runs: someone used claude.ai meanwhile.
	entries = append(entries,
		LogEntry{T: 110, Session: "s2", Account: "A", Model: "claude-opus-5-5", Output: 100},
		LogEntry{T: 120, Account: "A", Poll: true, Used7d: f(0.59)})
	a := Attribute(entries, "A", Span{To: 1000, LogStart: 5}) // the first reading is the baseline
	if !near(a.Sessions["s2"].Used, 0.02) || !near(a.Outside, 0.02) || !near(a.Sessions["s1"].Used, 0.04) || !near(a.BeforeLog, 0.51) {
		t.Fatalf("s1 %v s2 %v outside %v before %v", a.Sessions["s1"].Used, a.Sessions["s2"].Used, a.Outside, a.BeforeLog)
	}
}

func TestARangeInsideAWeekCountsOnlyItsPart(t *testing.T) {
	DayOf = func(ms int64) string { return fmt.Sprint(ms / day) }
	defer func() { DayOf = func(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") } }()
	entries := []LogEntry{
		{T: 1 * day, Session: "early", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.10)},
		{T: 1*day + 10, Account: "A", Poll: true, Used7d: f(0.12)}, // the early request's 2%
		{T: 3 * day, Session: "late", Account: "A", Model: "claude-opus-5-5", Output: 100, Used7d: f(0.12)},
		{T: 3*day + 10, Account: "A", Poll: true, Used7d: f(0.13)},
	}
	week := Attribute(entries, "A", Span{To: 7 * day})
	if !near(week.Counted, 0.13) || !near(week.Sessions["early"].Used, 0.02) {
		t.Fatalf("whole week: counted %v early %v", week.Counted, week.Sessions["early"].Used)
	}
	// A range from day 2: the early request is not counted, the late one keeps its 1%.
	r := Attribute(entries, "A", Span{To: 7 * day, CountFrom: 2 * day, Range: true})
	if _, ok := r.Sessions["early"]; ok || !near(r.Sessions["late"].Used, 0.01) || !near(r.Counted, 0.01) {
		t.Fatalf("range: %+v counted %v", r.Sessions, r.Counted)
	}
	// Readings before the range taught the baseline; only those inside it mark a day as read.
	if !near(r.Sessions["late"].Days["3"], 0.01) || r.ReadDays["1"] || !r.ReadDays["3"] || !r.Sessions["late"].Metered {
		t.Fatalf("days: %+v %+v", r.Sessions["late"], r.ReadDays)
	}
}

// Codex starts a weekly window at the first request after the last one ended, so windows do not
// fall a week apart. A range walks them in one pass: each window's use counts once.
func TestARangeWalksWindowsThatDoNotAlign(t *testing.T) {
	first, second := 9*day, 19*day // the second window began on day 12, three days after the first ended
	var entries []LogEntry
	// Steady work in both windows: a request, then the 1% it used.
	for i, at := range []int64{3 * day, 5 * day, 8 * day, 12 * day, 14 * day} {
		reset, used := first, 0.10+0.01*float64(i+1)
		if at >= 12*day {
			reset, used = second, 0.01*float64(i-2)
		}
		entries = append(entries,
			LogEntry{T: at, Session: fmt.Sprint("s", i), Account: "A", Model: "claude-opus-5-5", Output: 100},
			LogEntry{T: at + 10, Account: "A", Poll: true, Used7d: f(used), Reset7: reset})
	}
	entries = append([]LogEntry{{T: 2 * day, Account: "A", Poll: true, Used7d: f(0.10), Reset7: first}}, entries...)
	// From day 4: the first window's last two percents and the second window's two.
	r := Attribute(entries, "A", Span{To: 20 * day, CountFrom: 4 * day, Range: true})
	if !near(r.Counted, 0.04) || !near(r.Outside, 0) || !near(r.Sessions["s3"].Used, 0.01) {
		t.Fatalf("counted %v outside %v sessions %+v", r.Counted, r.Outside, r.Sessions)
	}
	// The new window's first reading sits below the last only by a step; its reset tells it apart.
	quiet := append([]LogEntry(nil), entries...)
	quiet[len(quiet)-3].Used7d, quiet[len(quiet)-1].Used7d = f(0.12), f(0.13)
	q := Attribute(quiet, "A", Span{To: 20 * day, CountFrom: 4 * day, Range: true})
	if !near(q.Counted, 0.15) || !near(q.Sessions["s3"].Used, 0.01) || !near(q.Outside, 0.11) {
		t.Fatalf("new window read as one: counted %v s3 %v outside %v", q.Counted, q.Sessions["s3"].Used, q.Outside)
	}
	// Over one week the new window starts the week over, counting from its first request.
	w := Attribute(entries, "A", Span{From: 2 * day, To: 20 * day, CountFrom: 2 * day})
	if w.Restart != 12*day || !near(w.Used, 0.02) || len(w.Sessions) != 2 {
		t.Fatalf("week: restart %v used %v sessions %+v", w.Restart, w.Used, w.Sessions)
	}
}

// Use found at the first reading counts in a range only when its window began inside the range.
func TestUseBeforeLoggingCountsWhereItsWindowBegan(t *testing.T) {
	entries := []LogEntry{
		{T: 5 * day, Session: "s", Account: "A", Output: 100, Used7d: f(0.30), Reset7: 11 * day},
		{T: 6 * day, Session: "s", Account: "A", Output: 100, Used7d: f(0.32), Reset7: 11 * day},
	}
	walk := func(countFrom int64) Attribution {
		return Attribute(entries, "A", Span{To: 20 * day, CountFrom: countFrom, LogStart: 5 * day, Range: true})
	}
	// The window began on day 4: inside a range from day 3, so its 30% counts.
	if r := walk(3 * day); !near(r.BeforeLog, 0.30) || !near(r.Counted, 0.32) || r.Unplaced != 0 {
		t.Fatalf("inside: before %v counted %v unplaced %v", r.BeforeLog, r.Counted, r.Unplaced)
	}
	// A range from day 4.5 cuts the window: how much of the 30% fell after it is not known.
	if r := walk(4*day + day/2); r.BeforeLog != 0 || !near(r.Unplaced, 0.30) || !near(r.Counted, 0.02) {
		t.Fatalf("cut: before %v counted %v unplaced %v", r.BeforeLog, r.Counted, r.Unplaced)
	}
	// A range from day 5.5 begins after the first reading: all of it came before, and so did the
	// first request. The rest of the next rise was read across the range start, so it is not placed.
	if r := walk(5*day + day/2); r.BeforeLog != 0 || !near(r.Unplaced, 0.01) || r.Counted != 0 {
		t.Fatalf("after: before %v counted %v unplaced %v", r.BeforeLog, r.Counted, r.Unplaced)
	}
	// Without a reset time the window follows the account's weekly schedule.
	entries[0].Reset7, entries[1].Reset7 = 0, 0
	r := Attribute(entries, "A", Span{To: 20 * day, CountFrom: 3 * day, LogStart: 5 * day, Range: true, WindowStart: 11 * day})
	if !near(r.BeforeLog, 0.30) {
		t.Fatalf("scheduled window began on day 4: before %v unplaced %v", r.BeforeLog, r.Unplaced)
	}
}

// A new window's first reading is use since it began: requests before it ran in the old window.
func TestANewWindowsFirstReadingIsNotTheOldWindowsRequests(t *testing.T) {
	entries := []LogEntry{
		{T: 1 * day, Account: "A", Poll: true, Used7d: f(0.30), Reset7: 7 * day},
		{T: 6 * day, Session: "old", Account: "A", Output: 100},
		// The old window ends on day 7 unread; the next begins on day 8 with someone else's 2%.
		{T: 8*day + 10, Account: "A", Poll: true, Used7d: f(0.02), Reset7: 15 * day},
	}
	r := Attribute(entries, "A", Span{To: 20 * day, CountFrom: 8 * day, Range: true})
	if _, ok := r.Sessions["old"]; ok || !near(r.Counted, 0.02) || !near(r.Outside, 0.02) {
		t.Fatalf("counted %v outside %v sessions %+v", r.Counted, r.Outside, r.Sessions)
	}
}

// A reading trailing in the same window is not a reset, however far it trails.
func TestALateReadingOfTheSameWindowIsNoReset(t *testing.T) {
	at := func(ms int64) int64 { return 8*weekMs + ms }
	entries := []LogEntry{
		{T: at(10), Session: "s", Account: "A", Output: 100, Used7d: f(0.40), Reset7: 9 * weekMs},
		{T: at(20), Account: "A", Poll: true, Used7d: f(0.50), Reset7: 9 * weekMs},
		{T: at(30), Account: "A", Poll: true, Used7d: f(0.40), Reset7: 9*weekMs + 900},
		{T: at(40), Account: "A", Poll: true, Used7d: f(0.50), Reset7: 9 * weekMs},
		// And a reading of the window before, read late, says nothing.
		{T: at(50), Account: "A", Poll: true, Used7d: f(0.90), Reset7: 8 * weekMs},
	}
	r := Attribute(entries, "A", Span{From: 8 * weekMs, To: 10 * weekMs, CountFrom: 8 * weekMs, Range: true})
	if !near(r.Counted, 0.50) || !near(r.Used, 0.50) {
		t.Fatalf("counted %v used %v", r.Counted, r.Used)
	}
}

// Without reset times, the weekly schedule tells windows apart however little each used.
func TestScheduledWindowsSplitWithoutResetTimes(t *testing.T) {
	var entries []LogEntry
	for w := int64(0); w < 4; w++ {
		entries = append(entries,
			LogEntry{T: w*weekMs + 10, Account: "A", Poll: true, Used7d: f(0)},
			LogEntry{T: w*weekMs + 20, Session: "s", Account: "A", Output: 100},
			LogEntry{T: w*weekMs + 30, Account: "A", Poll: true, Used7d: f(0.04)})
	}
	r := Attribute(entries, "A", Span{To: 4 * weekMs, Range: true, WindowStart: 3 * weekMs})
	if !near(r.Counted, 0.16) {
		t.Fatalf("counted %v, want four windows of 4%%", r.Counted)
	}
}

// A rise read across the range start that no request explains may have come before it.
func TestARiseReadAcrossTheRangeStartIsNotPlaced(t *testing.T) {
	entries := []LogEntry{
		{T: 100, Account: "A", Poll: true, Used7d: f(0.10)},
		{T: 300, Account: "A", Poll: true, Used7d: f(0.30)},
		{T: 400, Account: "A", Poll: true, Used7d: f(0.35)},
	}
	r := Attribute(entries, "A", Span{To: 1000, CountFrom: 200, Range: true})
	if !near(r.Unplaced, 0.20) || !near(r.Counted, 0.05) || !near(r.Outside, 0.05) {
		t.Fatalf("unplaced %v counted %v outside %v", r.Unplaced, r.Counted, r.Outside)
	}
}

// The walk's first reading in a window that began before the walk is not a rise from zero.
func TestAWindowBegunBeforeTheWalkIsNotRead(t *testing.T) {
	entries := []LogEntry{
		// A request inside the range ran before the first reading; it cannot have used all 60%.
		{T: 7*day + day/2, Session: "s", Account: "A", Output: 100},
		{T: 8 * day, Account: "A", Poll: true, Used7d: f(0.60), Reset7: 12 * day},
	}
	r := Attribute(entries, "A", Span{From: 6 * day, To: 20 * day, CountFrom: 7 * day, Range: true})
	if r.Counted != 0 || !near(r.Unplaced, 0.60) || r.Sessions["s"].Used != 0 {
		t.Fatalf("counted %v unplaced %v session %+v", r.Counted, r.Unplaced, r.Sessions["s"])
	}
}

// A stream that broke off after it began ran the tokens it reports.
func TestABrokenStreamsTokensCount(t *testing.T) {
	s, c := newTestState()
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true, Input: 10, Output: 200})
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true})
	log := s.TakeLog()
	if len(log) != 1 || log[0].Poll || log[0].Output != 200 || log[0].Session != "s1" {
		t.Fatalf("log = %+v", log)
	}
}

// A 5-hour span walks the 5-hour readings and their resets, as a week walks the weekly ones: a
// reading of the window before is passed over, and the weekly readings say nothing of it.
func TestAFiveHourSpanWalksTheFiveHourWindow(t *testing.T) {
	start := int64(100 * FiveMs)
	end := start + FiveMs
	entries := []LogEntry{
		{T: start - 60_000, Account: "A", Poll: true, Used5h: f(0.90), Reset5: start, Used7d: f(0.40)},
		{T: start + 1000, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100},
		// A request's reading is taken before it counts: this 2% is s1's.
		{T: start + 2000, Session: "s2", Account: "A", Model: "claude-opus-5-5", Output: 300, Used5h: f(0.02), Reset5: end, Used7d: f(0.40)},
		{T: start + 3000, Account: "A", Poll: true, Used5h: f(0.05), Reset5: end, Used7d: f(0.41)},
	}
	a := Attribute(entries, "A", Span{From: start - WindowJitter, To: end, CountFrom: start - WindowJitter, WindowStart: start, Five: true})
	if !a.Seen || !near(a.Used, 0.05) || !near(a.Sessions["s1"].Used, 0.02) || !near(a.Sessions["s2"].Used, 0.03) {
		t.Fatalf("used %v s1 %v s2 %v", a.Used, a.Sessions["s1"].Used, a.Sessions["s2"].Used)
	}
	// The 90% of the window before is passed over, and the weekly readings say nothing here.
	if !near(a.Counted, 0.05) || a.Unplaced != 0 || a.BeforeLog != 0 || a.Outside != 0 {
		t.Fatalf("counted %v unplaced %v before %v outside %v", a.Counted, a.Unplaced, a.BeforeLog, a.Outside)
	}
	// Readings that do not say their reset: a fall of the reading starts the next window, and the
	// request before the fall ran in the window before.
	old := []LogEntry{
		{T: 1000, Account: "A", Poll: true, Used5h: f(0.80)},
		{T: 1500, Session: "s1", Account: "A", Output: 100},
		{T: 2000, Account: "A", Poll: true, Used5h: f(0.03)},
	}
	b := Attribute(old, "A", Span{To: 3000, Five: true})
	if !near(b.Used, 0.03) {
		t.Fatalf("used %v sessions %+v", b.Used, b.Sessions["s1"])
	}
}

// A plan change starts a window over in place: the reading falls to nothing and settles there while
// the reset stays. A high reading of the old window read just after (26, 0, 26, 0) is a late
// reading: the window starts over at the first fall, and nothing is counted twice.
func TestAWindowStartsOverInPlace(t *testing.T) {
	week := int64(10 * weekMs)
	reset := week + weekMs
	at := func(ms int64) int64 { return week + ms }
	entries := []LogEntry{
		{T: at(1000), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		{T: at(2000), Session: "s1", Account: "A", Output: 100},
		{T: at(3000), Account: "A", Poll: true, Used7d: f(0.26), Reset7: reset},
		{T: at(4000), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		{T: at(5000), Account: "A", Poll: true, Used7d: f(0.26), Reset7: reset},
		{T: at(6000), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		{T: at(7000), Session: "s2", Account: "A", Output: 100},
		{T: at(8000), Account: "A", Poll: true, Used7d: f(0.02), Reset7: reset},
	}
	w := Attribute(entries, "A", Span{From: week - WindowJitter, To: at(day), CountFrom: week - WindowJitter, WindowStart: week})
	// It holds no request from before the fall: it counts from the fall.
	if !near(w.Used, 0.02) || w.Restart != at(4000) || w.Sessions["s1"] != nil || !near(w.Sessions["s2"].Used, 0.02) {
		t.Fatalf("week: used %v restart %v sessions %+v", w.Used, w.Restart, w.Sessions)
	}
	if len(w.Periods) != 1 || w.Periods[0].From != at(3000) || !near(w.Periods[0].Parts["s2"], 0.02) {
		t.Fatalf("week periods %+v", w.Periods)
	}
	// Over a range both windows count, the 26% once.
	r := Attribute(entries, "A", Span{From: week - WindowJitter, To: at(day), CountFrom: week - WindowJitter, Range: true})
	if !near(r.Counted, 0.28) || !near(r.Sessions["s1"].Used, 0.26) || !near(r.Sessions["s2"].Used, 0.02) {
		t.Fatalf("range: counted %v sessions %+v", r.Counted, r.Sessions)
	}
	if len(r.Periods) != 2 || r.Periods[0].Ended != at(3000) || !near(r.Periods[0].Used, 0.26) || r.Periods[0].Requests != 1 ||
		r.Periods[1].Reset != reset || !near(r.Periods[1].Used, 0.02) || r.Periods[1].Requests != 1 {
		t.Fatalf("range periods %+v", r.Periods)
	}
}

// A request whose reading tells the start-over belongs to the new window, though a late high
// reading of the old one comes after it.
func TestARequestAtTheFallIsTheNewWindows(t *testing.T) {
	minute := int64(60 * 1000)
	at := func(m int64) int64 { return 10*weekMs + m*minute }
	reset := int64(11 * weekMs)
	entries := []LogEntry{
		{T: at(0), Account: "A", Poll: true, Used7d: f(0.26), Reset7: reset},
		{T: at(1), Session: "s1", Account: "A", Output: 100, Used7d: f(0), Reset7: reset},
		{T: at(4), Account: "A", Poll: true, Used7d: f(0.26), Reset7: reset},
		{T: at(5), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		{T: at(6), Account: "A", Poll: true, Used7d: f(0.01), Reset7: reset},
	}
	w := Attribute(entries, "A", Span{From: at(-10), To: at(60), CountFrom: at(-10), WindowStart: 10 * weekMs})
	if w.Restart != at(1) || !near(w.Used, 0.01) || !near(w.Sessions["s1"].Used, 0.01) || w.Periods[0].Requests != 1 {
		t.Fatalf("restart %v used %v sessions %+v periods %+v", w.Restart, w.Used, w.Sessions, w.Periods)
	}
}

// Within lateReading after a start-over, a reading nearer the fall than the old highest is use of
// the new window; and a late reading of the old window after a later one began has no say.
func TestUseRightAfterAStartOverCounts(t *testing.T) {
	minute := int64(60 * 1000)
	at := func(m int64) int64 { return 10*weekMs + m*minute }
	reset := int64(11 * weekMs)
	entries := []LogEntry{
		{T: at(0), Account: "A", Poll: true, Used7d: f(0.26), Reset7: reset},
		{T: at(1), Session: "s1", Account: "A", Output: 100, Used7d: f(0), Reset7: reset},
		{T: at(3), Account: "A", Poll: true, Used7d: f(0.10), Reset7: reset},
	}
	w := Attribute(entries, "A", Span{From: at(-10), To: at(60), CountFrom: at(-10), WindowStart: 10 * weekMs})
	if w.Restart != at(1) || !near(w.Used, 0.10) || !near(w.Sessions["s1"].Used, 0.10) {
		t.Fatalf("restart %v used %v sessions %+v", w.Restart, w.Used, w.Sessions)
	}
	later := int64(12 * weekMs)
	entries = []LogEntry{
		{T: at(0), Account: "A", Poll: true, Used7d: f(0.50), Reset7: reset},
		{T: at(1), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		{T: at(2), Session: "s1", Account: "A", Output: 100},
		{T: at(2) + 1000, Account: "A", Poll: true, Used7d: f(0.02), Reset7: reset},
		{T: at(3), Account: "A", Poll: true, Used7d: f(0.01), Reset7: later},
		{T: at(4), Account: "A", Poll: true, Used7d: f(0.50), Reset7: reset},
	}
	r := Attribute(entries, "A", Span{From: at(-10), To: at(60), CountFrom: at(-10), Range: true})
	if len(r.Periods) != 3 || !near(r.Periods[1].Used, 0.02) || !near(r.Sessions["s1"].Used, 0.02) {
		t.Fatalf("periods %+v sessions %+v", r.Periods, r.Sessions)
	}
}

// After a window starts over in place the rate is learned anew: a plan change changes what a
// request uses, and the old rate would call the new use outside.
func TestARateIsLearnedAnewAfterAStartOver(t *testing.T) {
	minute := int64(60 * 1000)
	at := func(m int64) int64 { return 10*weekMs + m*minute }
	reset := int64(11 * weekMs)
	entries := []LogEntry{{T: at(0), Account: "A", Poll: true, Used7d: f(0.50), Reset7: reset}}
	for i := int64(1); i <= 4; i++ { // 1% a request
		entries = append(entries, LogEntry{T: at(2 * i), Session: "old", Account: "A", Output: 100},
			LogEntry{T: at(2*i + 1), Account: "A", Poll: true, Used7d: f(0.50 + 0.01*float64(i)), Reset7: reset})
	}
	entries = append(entries,
		LogEntry{T: at(20), Account: "A", Poll: true, Used7d: f(0), Reset7: reset},
		LogEntry{T: at(30), Session: "new", Account: "A", Output: 100},
		LogEntry{T: at(31), Account: "A", Poll: true, Used7d: f(0.10), Reset7: reset})
	w := Attribute(entries, "A", Span{From: at(-10), To: at(60), CountFrom: at(-10), WindowStart: 10 * weekMs})
	if !near(w.Used, 0.10) || !near(w.Sessions["new"].Used, 0.10) || !near(w.Outside, 0) {
		t.Fatalf("used %v outside %v sessions %+v", w.Used, w.Outside, w.Sessions)
	}
}

// A reading that falls and comes back up within lateReading is a late reading, whether or not the
// readings name their reset; one that comes back later was a new window, used since.
func TestAFallThatComesBackIsALateReading(t *testing.T) {
	late := []LogEntry{
		{T: 1000, Account: "A", Poll: true, Used7d: f(0.50)},
		{T: 2000, Account: "A", Poll: true, Used7d: f(0.40)},
		{T: 3000, Account: "A", Poll: true, Used7d: f(0.50)},
	}
	// The first reading has no request before it: it is use outside, once.
	if a := Attribute(late, "A", Span{To: day}); !near(a.Used, 0.50) || !near(a.Outside, 0.50) || a.Restart != 0 || len(a.Periods) != 1 {
		t.Fatalf("late: used %v outside %v restart %v periods %d", a.Used, a.Outside, a.Restart, len(a.Periods))
	}
	reset := []LogEntry{
		{T: 1000, Account: "A", Poll: true, Used7d: f(0.50)},
		{T: 2000, Account: "A", Poll: true, Used7d: f(0.40)},
		{T: 2000 + lateReading + 1000, Account: "A", Poll: true, Used7d: f(0.50)},
	}
	if a := Attribute(reset, "A", Span{To: day}); !near(a.Used, 0.50) || !near(a.Outside, 0.50) || len(a.Periods) != 1 || a.Restart == 0 {
		t.Fatalf("reset: used %v outside %v periods %+v restart %v", a.Used, a.Outside, a.Periods, a.Restart)
	}
}

// Lines the disk refused wait ahead of the newer ones.
func TestUnwrittenLinesGoBackFirst(t *testing.T) {
	s, _ := newTestState()
	s.log = []LogEntry{{T: 3}}
	s.ReturnLog([]LogEntry{{T: 1}, {T: 2}})
	if log := s.TakeLog(); len(log) != 3 || log[0].T != 1 || log[2].T != 3 {
		t.Fatalf("log = %+v", log)
	}
}

// Over one week, the last reading of the week before says nothing of this one.
func TestAWeekIgnoresTheWeekBeforesReading(t *testing.T) {
	week := int64(10 * weekMs)
	entries := []LogEntry{{T: week - 60_000, Account: "A", Poll: true, Used7d: f(0.90), Reset7: week}}
	w := Attribute(entries, "A", Span{From: week - WindowJitter, To: week + day, CountFrom: week - WindowJitter, WindowStart: week})
	if w.Seen || w.Used != 0 || w.Unplaced != 0 {
		t.Fatalf("seen %v used %v unplaced %v", w.Seen, w.Used, w.Unplaced)
	}
}

// A request just before a new window, within what reset times tell, may have run in either.
func TestARequestOnTheWindowsEdgeIsNotPlaced(t *testing.T) {
	start := int64(10 * weekMs)
	entries := []LogEntry{
		{T: start - 60_000, Session: "edge", Account: "A", Output: 100},
		{T: start + 60_000, Account: "A", Poll: true, Used7d: f(0.02), Reset7: start + weekMs},
	}
	r := Attribute(entries, "A", Span{From: start - weekMs, To: start + day, CountFrom: start, Range: true})
	// The request's part is not placed; the rest of the 2% rose inside the range. None of it is lost.
	if !near(r.Unplaced, 0.01) || !near(r.Counted, 0.01) || !near(r.Outside, 0.01) {
		t.Fatalf("counted %v unplaced %v outside %v", r.Counted, r.Unplaced, r.Outside)
	}
}

// A trailing reading read in between does not move where a rise may have begun.
func TestATrailingReadingDoesNotMoveTheRisesStart(t *testing.T) {
	entries := []LogEntry{
		{T: 100, Account: "A", Poll: true, Used7d: f(0.50)},
		{T: 300, Account: "A", Poll: true, Used7d: f(0.48)},
		{T: 400, Account: "A", Poll: true, Used7d: f(0.60)},
	}
	r := Attribute(entries, "A", Span{To: 1000, CountFrom: 200, Range: true})
	if r.Counted != 0 || !near(r.Unplaced, 0.10) {
		t.Fatalf("counted %v unplaced %v", r.Counted, r.Unplaced)
	}
}

// Only readings inside the range make it known, and only requests a reading settled are metered.
func TestKnownMeansReadInsideAndMeteredMeansSettled(t *testing.T) {
	entries := []LogEntry{
		{T: 100, Account: "A", Poll: true, Used7d: f(0.10)},
		{T: 300, Session: "waiting", Account: "A", Output: 100},
	}
	r := Attribute(entries, "A", Span{To: 1000, CountFrom: 200, Range: true})
	if r.Seen || r.Sessions["waiting"].Metered {
		t.Fatalf("seen %v metered %v", r.Seen, r.Sessions["waiting"].Metered)
	}
	entries = append(entries, LogEntry{T: 400, Account: "A", Poll: true, Used7d: f(0.11)})
	r = Attribute(entries, "A", Span{To: 1000, CountFrom: 200, Range: true})
	if !r.Seen || !r.Sessions["waiting"].Metered || !near(r.Sessions["waiting"].Used, 0.01) {
		t.Fatalf("seen %v session %+v", r.Seen, r.Sessions["waiting"])
	}
}

// Use read across midnight counts in the total, on no day.
func TestUseReadAcrossMidnightIsOnNoDay(t *testing.T) {
	DayOf = func(ms int64) string { return fmt.Sprint(ms / day) }
	defer func() { DayOf = func(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") } }()
	entries := []LogEntry{
		{T: day - 600_000, Account: "A", Poll: true, Used7d: f(0.10)},
		{T: day + 600_000, Account: "A", Poll: true, Used7d: f(0.30)},
		{T: day + 700_000, Account: "A", Poll: true, Used7d: f(0.35)},
	}
	r := Attribute(entries, "A", Span{To: 2 * day})
	if !near(r.Outside, 0.35) || !near(r.Undated, 0.20) || !near(r.OutsideDays["0"], 0.10) || !near(r.OutsideDays["1"], 0.05) {
		t.Fatalf("outside %v undated %v days %v", r.Outside, r.Undated, r.OutsideDays)
	}
}

// A window known only by the fall of the reading began at a time not known: the requests before
// its first reading keep only what their weight explains.
func TestAWindowKnownByAFallKeepsOnlyWhatRequestsExplain(t *testing.T) {
	entries := []LogEntry{
		{T: 1000, Account: "A", Poll: true, Used7d: f(0.90)},
		{T: 1300, Session: "late", Account: "A", Output: 100},
		{T: 1600, Account: "A", Poll: true, Used7d: f(0.40)},
	}
	r := Attribute(entries, "A", Span{To: 10_000, Range: true})
	// The walk's first reading is the old window's 90%, read with no request; the new one's 40% keeps
	// 1% for the request before it and the rest is unmatched.
	if !near(r.Sessions["late"].Used, 0.01) || !near(r.Outside, 0.90+0.39) {
		t.Fatalf("late %v outside %v", r.Sessions["late"].Used, r.Outside)
	}
}

// A kept session's settled requests come back one by one, adding up to its part.
func TestAKeptSessionsRequestsComeBackOneByOne(t *testing.T) {
	entries := []LogEntry{
		{T: 10, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100},
		{T: 20, Session: "lcp:x", Account: "A", Model: "claude-opus-5-5", Output: 100},
		{T: 30, Account: "A", Poll: true, Used7d: f(0.02)},
		{T: 40, Session: "s1", Account: "A", Model: "claude-opus-5-5", Output: 100},
	}
	r := Attribute(entries, "A", Span{To: 100, Keep: func(s string) bool { return s == "s1" }})
	if len(r.Pieces) != 1 || r.Pieces[0].T != 10 || !near(r.Pieces[0].Used, r.Sessions["s1"].Used) {
		t.Fatalf("pieces %+v, s1 %+v", r.Pieces, r.Sessions["s1"])
	}
	if none := Attribute(entries, "A", Span{To: 100}); none.Pieces != nil {
		t.Fatalf("pieces kept without asking: %+v", none.Pieces)
	}
}
