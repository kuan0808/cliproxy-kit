package core

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// intercepted is a request Intercept saw, and when its attempt's record arrives: the trace that
// carries its routed model and arrival.
func intercepted(s *State, trace, model string, tools int) {
	s.Intercept(InterceptInput{Session: "s1", TraceID: trace, Format: "claude", Model: model, RequestedModel: model, Tools: tools})
}

// failed records a failed attempt of the main conversation of s1.
func failed(s *State, c *clock, authID, trace string, status int, text string, wait, ttft time.Duration) {
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: trace, AuthID: authID,
		RequestedAt: c.t.Add(-wait), Failed: true, StatusCode: status, ErrorText: text, Latency: wait, TTFT: ttft})
}

func moveLines(log []LogEntry) []LogEntry {
	var out []LogEntry
	for _, e := range log {
		if e.Ev == EventMove {
			out = append(out, e)
		}
	}
	return out
}

func twoAccounts(t *testing.T) (*State, *clock) {
	t.Helper()
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.TakeLog()
	return s, c
}

// The marker a pick sets when the bound account is not offered is kept under the model the pick
// names, which is the one Intercept saw after routing, not the one the executor ran.
func TestPerModelStateIsKeptUnderThePicksModel(t *testing.T) {
	for _, c := range []struct{ name, picked, ran string }{
		{"an alias", "team-opus", "claude-opus-5-5"},
		{"a route to another provider's model", "gpt-6-sol", "gpt-6-sol"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, clk := twoAccounts(t)
			intercepted(s, "t1", c.picked, 3)
			pick(s, "claude:s1", c.picked, both)
			s.Observe(Usage{Provider: "claude", Model: c.ran, SessionID: "claude:s1", TraceID: "t1", AuthID: "claude-a", RequestedAt: clk.t, Output: 5})
			// claude-a is not offered: the marker goes on the picked model.
			pick(s, "claude:s1", c.picked, []Candidate{credB})
			if !hasDisplaced(s, c.picked) {
				t.Fatalf("no marker under %s: %+v", c.picked, s.displaced)
			}
			intercepted(s, "t2", c.picked, 3)
			s.Observe(Usage{Provider: "claude", Model: c.ran, SessionID: "claude:s1", TraceID: "t2", AuthID: "claude-b", RequestedAt: clk.t, Output: 5})
			if hasDisplaced(s, c.picked) || s.bindings["claude|claude:s1"].AuthID != "claude-b" {
				t.Fatalf("the success elsewhere did not take the marker and the binding: %+v %+v", s.displaced, s.bindings)
			}
			if v := s.Build().Sessions["s1"]; v.LastSwitch == nil || v.LastSwitch.Kind != MoveLeftOut {
				t.Fatalf("record = %+v", v.LastSwitch)
			}
		})
	}
}

func hasDisplaced(s *State, model string) bool {
	_, ok := s.displaced["claude|claude:s1"][modelKey(model)]
	return ok
}

// A failed attempt is written once, in exactly one of three ways, with its kind, status, wait and
// ttft; never its error text.
func TestAFailedAttemptIsWrittenOnceWithItsKind(t *testing.T) {
	s, c := twoAccounts(t)
	// No tokens and no reading: a line of its own that no report counts.
	failed(s, c, "claude-a", "", 0, `Post "http://x": EOF`, 2*time.Minute, 0)
	// No tokens, a quota reading: the reading's line.
	h := map[string][]string{"Anthropic-Ratelimit-Unified-7d-Utilization": {"0.4"}}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true,
		StatusCode: 529, ErrorText: "upstream busy", Latency: time.Second, TTFT: time.Second, ResponseHeader: h})
	// Tokens: its request line, counted as today.
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true,
		ErrorText: "unexpected EOF", Latency: 45 * time.Second, TTFT: 2 * time.Second, Input: 10, CacheRead: 800, CacheCreation: 300})
	log := s.TakeLog()
	if len(log) != 3 {
		t.Fatalf("log = %+v", log)
	}
	pure, reading, request := log[0], log[1], log[2]
	if pure.F != FailHang || pure.St != 0 || pure.W != 120000 || pure.TTFT != 0 || !pure.Poll || pure.Counts() || pure.Session != "s1" || pure.Model != "claude-opus-5-5" {
		t.Errorf("pure failure line = %+v", pure)
	}
	if reading.F != FailOverloaded || reading.St != 529 || reading.W != 1000 || reading.TTFT != 1000 || !reading.Poll || !reading.Counts() || reading.Used7d == nil {
		t.Errorf("reading line = %+v", reading)
	}
	if request.F != FailConnection || request.Poll || !request.Counts() || request.CacheRead != 800 || request.CacheWrite != 300 || request.TTFT != 2000 {
		t.Errorf("request line = %+v", request)
	}
	for _, e := range log {
		raw, _ := json.Marshal(e)
		if strings.Contains(string(raw), "EOF") || strings.Contains(string(raw), "busy") {
			t.Errorf("a line keeps the error text: %s", raw)
		}
	}
}

// Codex's records give a ttft for its first packet when no token came: the line keeps it as given
// and no other timing field.
func TestACodexFailureLogsTheTTFTItWasGiven(t *testing.T) {
	s, c := newTestState()
	for _, f := range []struct {
		status int
		text   string
		ttft   time.Duration
	}{
		{408, "stream error: stream disconnected before completion: stream closed before response.completed", 52 * time.Millisecond},
		{500, `{"error":{"message":"internal"}}`, 300 * time.Millisecond},
	} {
		s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", SessionID: "codex:c1", AuthID: "codex-a", RequestedAt: c.t, Failed: true,
			StatusCode: f.status, ErrorText: f.text, Latency: time.Second, TTFT: f.ttft})
	}
	log := s.TakeLog()
	if len(log) != 2 || log[0].TTFT != 52 || log[1].TTFT != 300 || log[0].FW != 0 || log[1].FW != 0 || log[0].F != FailConnection || log[1].F != FailServer {
		t.Fatalf("log = %+v", log)
	}
}

// A success line carries its own ttft and the client's wait from the request's arrival, which
// covers every failed attempt before it.
func TestASuccessLineCarriesTheClientsWait(t *testing.T) {
	s, c := twoAccounts(t)
	intercepted(s, "slow", "claude-opus-5-5", 3)
	c.add(135 * time.Second)
	failed(s, c, "claude-a", "slow", 0, `Post "http://x": EOF`, 135*time.Second, 0)
	c.add(2 * time.Second)
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "slow", AuthID: "claude-a",
		RequestedAt: c.t.Add(-2 * time.Second), TTFT: 2 * time.Second, Output: 5})
	intercepted(s, "quick", "claude-opus-5-5", 3)
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "quick", AuthID: "claude-a",
		RequestedAt: c.t, TTFT: 800 * time.Millisecond, Output: 5})
	// The attempt's reporter was built 10 s before it sent: the lower bound leaves those out.
	intercepted(s, "late-send", "claude-opus-5-5", 3)
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "late-send", AuthID: "claude-a",
		RequestedAt: c.t, TTFT: 2 * time.Second, Output: 5})
	var lines []LogEntry
	for _, e := range s.TakeLog() {
		if e.F == "" {
			lines = append(lines, e)
		}
	}
	if len(lines) != 3 || lines[0].TTFT != 2000 || lines[0].FW < 136900 || lines[0].FW > 137100 {
		t.Fatalf("after a hang: %+v", lines)
	}
	if lines[1].TTFT != 800 || lines[1].FW != 800 || lines[2].FW != 2000 {
		t.Fatalf("answered at once: %+v, late send: %+v", lines[1], lines[2])
	}
}

// `fw` is a key of its own: a line with it reads the same cache writes, weights and totals.
func TestNewLinesReadTheSameAsOld(t *testing.T) {
	old := `{"t":1,"s":"s1","acct":"a","p":"claude","m":"claude-opus-5-5","i":10,"o":20,"cr":300,"cw":40}`
	newer := `{"t":2,"s":"s1","acct":"a","p":"claude","m":"claude-opus-5-5","i":10,"o":20,"cr":300,"cw":40,"ttft":2000,"fw":137000}`
	var a, b LogEntry
	if json.Unmarshal([]byte(old), &a) != nil || json.Unmarshal([]byte(newer), &b) != nil {
		t.Fatal("unreadable")
	}
	if a.CacheWrite != b.CacheWrite || a.Weight() != b.Weight() || a.Cost() != b.Cost() || !b.Counts() {
		t.Fatalf("old %+v new %+v", a, b)
	}
	var ta, tb TokenSum
	ta.Add(a)
	tb.Add(b)
	if ta != tb {
		t.Fatalf("totals %+v, %+v", ta, tb)
	}
}

// The switch record is the main conversation's, written where its own binding changes account,
// and nowhere else; every move writes one event line.
func TestTheSwitchRecordIsWrittenWhereTheBindingMoves(t *testing.T) {
	roundTrip := func(t *testing.T, s *State, c *clock) *Switch {
		t.Helper()
		saved, _ := json.Marshal(s.Export())
		var p Persisted
		if err := json.Unmarshal(saved, &p); err != nil {
			t.Fatal(err)
		}
		back := New("boot-1", c.now)
		back.Import(p)
		return back.Build().Sessions["s1"].LastSwitch
	}
	t.Run("a user's switch, then the next success on the new account", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
		s.TakeLog()
		switchedAt := c.t
		if ack := s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}); ack.Status != "applied" {
			t.Fatalf("ack = %+v", ack)
		}
		c.add(time.Minute)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveUser || sw.From != "claude-a" || sw.To != "claude-b" || !sw.At.Equal(switchedAt) || sw.Reason != switchedReason {
			t.Fatalf("record = %+v", sw)
		}
		if moves := moveLines(s.TakeLog()); len(moves) != 1 || moves[0].Move != MoveUser || moves[0].From != "claude-a" || moves[0].Account != "claude-b" {
			t.Fatalf("event lines = %+v", moves)
		}
		if back := roundTrip(t, s, c); back == nil || back.Kind != MoveUser || !back.At.Equal(switchedAt) {
			t.Fatalf("after a reload: %+v", back)
		}
	})
	t.Run("a late success from the old account after a move", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB})
		c.add(time.Second)
		served(s, c, "claude:s1", "claude-b", false)
		first := *s.Build().Sessions["s1"].LastSwitch
		s.TakeLog()
		// A request sent before the move, answered by claude-a afterwards.
		s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t.Add(-time.Millisecond), Output: 5})
		c.add(time.Second)
		s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Output: 5})
		v := s.Build().Sessions["s1"]
		if v.ServedAuthID != "claude-a" || *v.LastSwitch != first || len(moveLines(s.TakeLog())) != 0 {
			t.Fatalf("view = %+v, record %+v, first %+v", v, v.LastSwitch, first)
		}
	})
	t.Run("an automatic move writes one record at its success", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB})
		c.add(time.Second)
		served(s, c, "claude:s1", "claude-b", false)
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveLeftOut || !sw.At.Equal(c.t) || len(moveLines(s.TakeLog())) != 1 {
			t.Fatalf("record = %+v", sw)
		}
		if gen := s.Build().Sessions["s1"].Generation; gen != 1 {
			t.Fatalf("generation %d", gen)
		}
	})
	t.Run("a Codex child thread moving leaves the main record alone", func(t *testing.T) {
		s, c := newTestState()
		a, b, p := Candidate{ID: "codex-a", Provider: "codex"}, Candidate{ID: "codex-b", Provider: "codex"}, Candidate{ID: "codex-p", Provider: "codex"}
		for _, id := range []string{"codex-a", "codex-b", "codex-p"} {
			s.MergeWindows(id, "codex", []Window{{Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
		}
		run := func(canonical, parent, authID, trace string) {
			s.Intercept(InterceptInput{TraceID: trace, Format: "openai-response", Model: "gpt-6.1-sol", RequestedModel: "gpt-6.1-sol"})
			s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", SessionID: canonical, ParentID: parent, TraceID: trace, AuthID: authID, RequestedAt: c.t, Output: 10})
		}
		pk := func(canonical, parent string, cands ...Candidate) {
			s.Pick(PickInput{Provider: "codex", Model: "gpt-6.1-sol", Canonical: canonical, Parent: parent, Candidates: cands})
		}
		pk("codex:s1", "", a, b, p)
		run("codex:s1", "", "codex-a", "t1")
		pk("codex:s1:agent:k", "codex:s1", b)
		run("codex:s1:agent:k", "codex:s1", "codex-b", "t2")
		// The main conversation switched to codex-p, then the child moves from codex-b to codex-a.
		s.Apply(Command{CommandID: "w1", Session: "codex:s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "codex-p"})
		main := *s.Build().Sessions["codex:s1"].LastSwitch
		s.TakeLog()
		c.add(time.Second)
		pk("codex:s1:agent:k", "codex:s1", a)
		run("codex:s1:agent:k", "codex:s1", "codex-a", "t3")
		moves := moveLines(s.TakeLog())
		if len(moves) != 1 || !moves[0].Agent || moves[0].From != "codex-b" || moves[0].Account != "codex-a" || moves[0].Session != "codex:s1" {
			t.Fatalf("child's event lines = %+v", moves)
		}
		saved, _ := json.Marshal(s.Export())
		var pst Persisted
		_ = json.Unmarshal(saved, &pst)
		back := New("boot-1", c.now)
		back.Import(pst)
		if got := back.Build().Sessions["codex:s1"].LastSwitch; got == nil || *got != main {
			t.Fatalf("main record %+v, want %+v", got, main)
		}
	})
	t.Run("a route to a provider with no binding yet, then its first routed reply", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
		before := s.Build().Sessions["s1"].Generation
		s.Apply(Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "gpt-6-sol"})
		s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", AuthID: "codex-a", RequestedAt: c.t, Output: 5})
		v := s.Build().Sessions["s1"]
		if v.LastSwitch != nil || v.Generation != before+1 || len(moveLines(s.TakeLog())) != 0 {
			t.Fatalf("view = %+v", v)
		}
	})
	t.Run("a route to another model of the same provider and account", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
		s.Apply(Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "claude", Model: "claude-sonnet-5-5"})
		pick(s, "claude:s1", "claude-sonnet-5-5", both)
		s.Observe(Usage{Provider: "claude", Model: "claude-sonnet-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Output: 5})
		if v := s.Build().Sessions["s1"]; v.LastSwitch != nil {
			t.Fatalf("record = %+v", v.LastSwitch)
		}
	})
	t.Run("a non-threaded subagent succeeding elsewhere", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
		pick(s, "claude:s1:agent:x", "claude-opus-5-5", []Candidate{credB})
		served(s, c, "claude:s1:agent:x", "claude-b", false)
		if v := s.Build().Sessions["s1"]; v.LastSwitch != nil || v.AuthID != "claude-a" {
			t.Fatalf("view = %+v", v)
		}
	})
}

// Every move says why, from what quota-pilot saw, and only with evidence.
func TestAMoveSaysWhy(t *testing.T) {
	moveAfter := func(t *testing.T, before func(s *State, c *clock)) *Switch {
		t.Helper()
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		before(s, c)
		c.add(time.Second)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB}).AuthID, false)
		return s.Build().Sessions["s1"].LastSwitch
	}
	cases := []struct {
		name   string
		before func(s *State, c *clock)
		kind   string
		cause  Cause
	}{
		// A hang that ended at the connection is retried on the account (retry.go): the move follows
		// once its retry window passed.
		{"a hang", func(s *State, c *clock) {
			failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
			c.add(76 * time.Second)
		}, MoveFailed, Cause{Kind: FailHang, WaitMs: 135000, Count: 1}},
		{"two 529s", func(s *State, c *clock) {
			failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
			failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		}, MoveFailed, Cause{Kind: FailOverloaded, Status: 529, WaitMs: 1000, Count: 2}},
		{"a refused sign-in", func(s *State, c *clock) { failed(s, c, "claude-a", "", 401, "", time.Second, time.Second) },
			MoveSignIn, Cause{Kind: FailSignIn, Status: 401, WaitMs: 1000, Count: 1}},
		{"a model the account does not serve", func(s *State, c *clock) {
			failed(s, c, "claude-a", "", 404, `{"error":{"message":"model_not_supported"}}`, time.Second, time.Second)
		}, MoveModel, Cause{Kind: FailModel, Status: 404, WaitMs: 1000, Count: 1, Model: "claude-opus-5-5"}},
		{"no failure seen", func(*State, *clock) {}, MoveLeftOut, Cause{}},
		{"a cancel is not the account's", func(s *State, c *clock) { failed(s, c, "claude-a", "", 499, "context canceled", 45*time.Second, 0) },
			MoveLeftOut, Cause{}},
		{"a removed account", func(s *State, c *clock) {
			s.UpdateInventory([]CredInfo{{ID: "claude-b", Provider: "claude"}})
		}, MoveGone, Cause{Reason: "removed"}},
		{"a disabled account", func(s *State, c *clock) {
			s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Disabled: true}, {ID: "claude-b", Provider: "claude"}})
		}, MoveGone, Cause{Reason: "disabled"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sw := moveAfter(t, tc.before)
			var got Cause
			if sw != nil && sw.Cause != nil {
				got = *sw.Cause
			}
			if sw == nil || sw.Kind != tc.kind || got != tc.cause {
				t.Fatalf("record %+v cause %+v, want %s %+v", sw, got, tc.kind, tc.cause)
			}
		})
	}
	t.Run("a used-up account that refused keeps its quota reason", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		setQuota(s, c, "claude-a", 0.9, 0, 24*time.Hour)
		failed(s, c, "claude-a", "", 429, "", time.Second, time.Second)
		c.add(time.Second)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		setQuota(s, c, "claude-a", 0.9, 1, 24*time.Hour) // refilled since
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveQuota || sw.Cause == nil || sw.Cause.Reason != "weekly quota used up" {
			t.Fatalf("record = %+v", sw)
		}
	})
	t.Run("an idle move", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		c.add(2 * time.Hour)
		setQuota(s, c, "claude-a", 0.1, 0.5, 24*time.Hour)
		setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveIdle || sw.Cause == nil || sw.Cause.Reason != "5-hour quota low" {
			t.Fatalf("record = %+v", sw)
		}
	})
}

// switch_back names the account a session moved off only while a pick has listed it for the
// session's model since it last failed, and it can serve.
func TestSwitchBackNeedsAListingSinceTheLastFailure(t *testing.T) {
	const opus, sonnet = "claude-opus-5-5", "claude-sonnet-5-5"
	moved := func(t *testing.T, fail func(s *State, c *clock)) (*State, *clock) {
		t.Helper()
		s, c := twoAccounts(t)
		s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
		intercepted(s, "t0", opus, 3)
		served(s, c, "claude:s1", pick(s, "claude:s1", opus, both).AuthID, false)
		fail(s, c)
		c.add(time.Second)
		served(s, c, "claude:s1", pick(s, "claude:s1", opus, []Candidate{credB}).AuthID, false)
		return s, c
	}
	back := func(s *State) string { return s.Build().Sessions["s1"].SwitchBack }
	listing := func(s *State, model string) {
		s.Pick(PickInput{Provider: "claude", Model: model, Canonical: "claude:other", Candidates: both})
	}

	t.Run("after a 529 at the first pick that lists it", func(t *testing.T) {
		s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
		if back(s) != "" {
			t.Fatal("present before any listing")
		}
		c.add(61 * time.Second)
		listing(s, opus)
		if back(s) != "claude-a" {
			t.Fatal("absent after a listing")
		}
	})
	t.Run("after a 503 with Retry-After 120, not while picks leave it out", func(t *testing.T) {
		s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 503, "", time.Second, time.Second) })
		c.add(61 * time.Second)
		s.Pick(PickInput{Provider: "claude", Model: opus, Canonical: "claude:other", Candidates: []Candidate{credB}})
		if back(s) != "" {
			t.Fatal("present while picks leave it out")
		}
		c.add(60 * time.Second)
		listing(s, opus)
		if back(s) != "claude-a" {
			t.Fatal("absent once listed")
		}
	})
	t.Run("after a 401 until listed", func(t *testing.T) {
		s, _ := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 401, "", time.Second, time.Second) })
		if back(s) != "" {
			t.Fatal("present before listed")
		}
		listing(s, opus)
		if back(s) != "claude-a" {
			t.Fatal("absent once listed")
		}
	})
	t.Run("after a lost connection at the next pick that lists it", func(t *testing.T) {
		s, _ := moved(t, func(s *State, c *clock) {
			failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
			c.add(76 * time.Second) // past its retry window
		})
		listing(s, opus)
		if back(s) != "claude-a" {
			t.Fatal("absent once listed")
		}
	})
	t.Run("listed only for another model", func(t *testing.T) {
		s, _ := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
		listing(s, sonnet)
		if back(s) != "" {
			t.Fatal("a Sonnet listing answered for Opus")
		}
	})
	t.Run("any later failure voids the listing", func(t *testing.T) {
		for _, f := range []struct {
			name   string
			status int
			text   string
		}{{"a credential-scoped 429 on Sonnet", 429, ""}, {"a request failure", 400, `{"error":{"message":"bad"}}`}} {
			t.Run(f.name, func(t *testing.T) {
				s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
				listing(s, opus)
				c.add(time.Second)
				s.Observe(Usage{Provider: "claude", Model: sonnet, SessionID: "claude:other", AuthID: "claude-a", RequestedAt: c.t,
					Failed: true, StatusCode: f.status, ErrorText: f.text, Latency: time.Second})
				if back(s) != "" {
					t.Fatal("present after a later failure")
				}
				c.add(2 * time.Second)
				listing(s, opus)
				if back(s) != "claude-a" {
					t.Fatal("absent after a later listing")
				}
			})
		}
	})
	t.Run("a compact request's failure voids every model's listing", func(t *testing.T) {
		s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
		listing(s, opus)
		c.add(time.Second)
		s.Intercept(InterceptInput{TraceID: "cmp", Format: "openai-response", Model: "gpt-6.1-sol", Path: "/v1/responses/compact"})
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:other", TraceID: "cmp", AuthID: "claude-a", RequestedAt: c.t,
			Failed: true, StatusCode: 400, Latency: time.Second})
		if back(s) != "" {
			t.Fatal("present after a compact failure")
		}
	})
	t.Run("an alias finds its own listings", func(t *testing.T) {
		s, c := twoAccounts(t)
		s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
		intercepted(s, "t0", "team-opus", 3)
		pick(s, "claude:s1", "team-opus", both)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "t0", AuthID: "claude-a", RequestedAt: c.t, Output: 5})
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(time.Second)
		intercepted(s, "t1", "team-opus", 3)
		pick(s, "claude:s1", "team-opus", []Candidate{credB})
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "t1", AuthID: "claude-b", RequestedAt: c.t, Output: 5})
		listing(s, opus)
		if back(s) != "" {
			t.Fatal("a listing for the executor's model answered for the alias")
		}
		listing(s, "team-opus")
		if back(s) != "claude-a" {
			t.Fatal("absent after a listing for the alias")
		}
	})
	t.Run("after a restart with no listing yet", func(t *testing.T) {
		s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
		listing(s, opus)
		saved, _ := json.Marshal(s.Export())
		var p Persisted
		_ = json.Unmarshal(saved, &p)
		restarted := New("boot-2", c.now)
		restarted.Import(p)
		restarted.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
		if back(restarted) != "" {
			t.Fatal("present after a restart")
		}
	})
	t.Run("a used-up account", func(t *testing.T) {
		s, c := moved(t, func(s *State, c *clock) { failed(s, c, "claude-a", "", 529, "", time.Second, time.Second) })
		listing(s, opus)
		setQuota(s, c, "claude-a", 0.9, 0, 24*time.Hour)
		if back(s) != "" {
			t.Fatal("present while used up")
		}
	})
	t.Run("after the user's own switch", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", opus, both).AuthID, true)
		s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
		listing(s, opus)
		if back(s) != "" {
			t.Fatal("offered after a user's own switch")
		}
	})
}

// The band reads every account reference as an opaque id, never a credential id with an email.
func TestTheBandSeesNoEmailInTheNewFields(t *testing.T) {
	s, c := newTestState()
	a, b := "claude-dana@example.com.json", "claude-kim@example.com.json"
	s.UpdateInventory([]CredInfo{{ID: a, Provider: "claude", Email: "dana@example.com"}, {ID: b, Provider: "claude", Email: "kim@example.com"}})
	setQuota(s, c, a, 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, b, 0.9, 0.5, 4*24*time.Hour)
	ca, cb := Candidate{ID: a, Provider: "claude"}, Candidate{ID: b, Provider: "claude"}
	served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", []Candidate{ca, cb}).AuthID, false)
	failed(s, c, a, "", 529, "", time.Second, time.Second)
	c.add(time.Second)
	served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", []Candidate{cb}).AuthID, false)
	pick(s, "claude:other", "claude-opus-5-5", []Candidate{ca, cb})
	snap := s.BuildForBand("s1", "", "")
	v := snap.Sessions["s1"]
	if v == nil || v.SwitchBack == "" || v.LastSwitch == nil || v.LastSwitch.Kind != MoveFailed {
		t.Fatalf("view = %+v", v)
	}
	raw, _ := json.Marshal(snap)
	if strings.Contains(string(raw), "@") || strings.Contains(string(raw), "dana") {
		t.Fatalf("an email in /band: %s", raw)
	}
}
