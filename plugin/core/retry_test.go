package core

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const opus = "claude-opus-5-5"

var credC = Candidate{ID: "claude-c", Provider: "claude"}

// retrySetup is a Claude Code session s1 bound to claude-a (d•••) beside claude-b (k•••), its last
// main prompt `tokens` large.
func retrySetup(t *testing.T, tokens int64) (*State, *clock) {
	t.Helper()
	s, c := twoAccounts(t)
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Email: "dana@example.com"}, {ID: "claude-b", Provider: "claude", Email: "kim@example.com"}})
	if r := pick(s, "claude:s1", opus, both); r.AuthID != "claude-a" {
		t.Fatalf("setup pick %s", r.AuthID)
	}
	answered(s, c, "claude:s1", "claude-a")
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, CacheRead: tokens, Output: 5})
	s.TakeLog()
	return s, c
}

// answered records a success of session's request on authID, sent now.
func answered(s *State, c *clock, session, authID string) {
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: session, AuthID: authID, RequestedAt: c.t, CacheRead: 160_000, Output: 5, TTFT: time.Second})
}

func pk(s *State, cands ...Candidate) PickResult { return pick(s, "claude:s1", opus, cands) }

func boundTo(s *State) string { return s.bindings["claude|claude:s1"].AuthID }

func eventLines(s *State, ev string) []LogEntry {
	var out []LogEntry
	for _, e := range s.TakeLog() {
		if e.Ev == ev {
			out = append(out, e)
		}
	}
	return out
}

func TestAHangGetsOneRetry(t *testing.T) {
	hang := func(t *testing.T, tokens int64) (*State, *clock) {
		s, c := retrySetup(t, tokens)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 0, `Post "http://x": EOF`, 135*time.Second, 0)
		return s, c
	}
	t.Run("the round's other picks are declined and the next round's retry works", func(t *testing.T) {
		s, c := hang(t, 160_000)
		r := pk(s, credB)
		if !r.Reject || r.Reason != "quota-pilot: d••• hung for 2m 15s; retrying it now; k••• is next if needed" {
			t.Fatalf("pick = %+v", r)
		}
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("retry pick = %+v", r)
		}
		if v := s.Build().Sessions["s1"]; v.Retry == nil || v.Retry.TryStartedAt.IsZero() || v.Retry.Try != 1 {
			t.Fatalf("view = %+v", v.Retry)
		}
		c.add(2 * time.Second)
		answered(s, c, "claude:s1", "claude-a")
		v := s.Build().Sessions["s1"]
		if v.Retry != nil || v.RetryOutcome == nil || v.RetryOutcome.Cause.Kind != FailHang || v.LastSwitch != nil || boundTo(s) != "claude-a" {
			t.Fatalf("view = %+v outcome %+v", v, v.RetryOutcome)
		}
		if lines := eventLines(s, EventRetry); len(lines) != 1 || !lines[0].OK || lines[0].Try != 1 {
			t.Fatalf("retry lines = %+v", lines)
		}
	})
	t.Run("a retry that hangs again ends it, the account rests and the session moves", func(t *testing.T) {
		s, c := hang(t, 160_000)
		pk(s, both...)
		c.add(130 * time.Second)
		failed(s, c, "claude-a", "", 0, `Post "http://x": EOF`, 130*time.Second, 0)
		if !resting(s, "claude-a") {
			t.Fatal("not resting after two hangs")
		}
		if r := pk(s, both...); r.AuthID != "claude-b" {
			t.Fatalf("pick = %+v", r)
		}
		answered(s, c, "claude:s1", "claude-b")
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveRest || sw.Cause.Kind != FailHang || sw.Cause.Count != 2 {
			t.Fatalf("record %+v", sw)
		}
	})
	t.Run("a retry cancelled with no answer marks the binding, and the next message moves", func(t *testing.T) {
		s, c := hang(t, 160_000)
		pk(s, both...)
		c.add(45 * time.Second)
		failed(s, c, "claude-a", "", 499, "context canceled", 45*time.Second, 0)
		if resting(s, "claude-a") || !s.hung[episodeKey{"claude|claude:s1", opus}] {
			t.Fatal("not marked, or rests for a cancel")
		}
		if r := pk(s, both...); r.AuthID != "claude-b" {
			t.Fatalf("pick = %+v", r)
		}
		answered(s, c, "claude:s1", "claude-b")
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveFailed || sw.Cause.Kind != FailHang || sw.Cause.LastRetry == nil ||
			sw.Cause.LastRetry.Kind != FailRequest || sw.Cause.LastRetry.Answered || sw.Cause.Retries != 1 {
			t.Fatalf("record %+v cause %+v", sw, sw.Cause)
		}
	})
	for _, f := range []struct {
		name       string
		wait, ttft time.Duration
	}{{"a retry that streamed, then was cancelled, leaves no mark", 4 * time.Second, time.Second},
		{"a retry that answered at 35 s and was cancelled at 45 s leaves no mark", 45 * time.Second, 35 * time.Second}} {
		t.Run(f.name, func(t *testing.T) {
			s, c := hang(t, 160_000)
			pk(s, both...)
			c.add(f.wait)
			failed(s, c, "claude-a", "", 499, "context canceled", f.wait, f.ttft)
			if r := pk(s, both...); r.AuthID != "claude-a" {
				t.Fatalf("pick = %+v", r)
			}
		})
	}
	t.Run("a hang that ends with a 503 waits for a large session only", func(t *testing.T) {
		for _, tc := range []struct {
			tokens int64
			reject bool
		}{{160_000, true}, {40_000, false}} {
			s, c := retrySetup(t, tc.tokens)
			pk(s, both...)
			c.add(135 * time.Second)
			failed(s, c, "claude-a", "", 503, `{"error":{"message":"timed out"}}`, 135*time.Second, 135*time.Second)
			if r := pk(s, credB); r.Reject != tc.reject {
				t.Fatalf("%d tokens: pick %+v", tc.tokens, r)
			}
		}
	})
	t.Run("a hang that ends with a bare deadline is retried for any size", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 0, "context deadline exceeded", 135*time.Second, 0)
		if r := pk(s, credB); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("retry pick %+v", r)
		}
	})
	t.Run("a 529 episode's retry that hangs ends the episode", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(61 * time.Second)
		pk(s, both...)
		c.add(40 * time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", 40*time.Second, 0)
		if v := s.Build().Sessions["s1"]; v.Retry != nil {
			t.Fatalf("retry %+v", v.Retry)
		}
		if r := pk(s, credB); r.Reject {
			t.Fatalf("declined after the retry hung: %+v", r)
		}
	})
}

func TestADroppedConnectionIsRetriedInTheSameRequest(t *testing.T) {
	s, c := retrySetup(t, 4_000)
	pk(s, both...)
	failed(s, c, "claude-a", "", 0, "unexpected EOF", time.Second, 0)
	if r := pk(s, credB); !r.Reject {
		t.Fatalf("pick %+v", r)
	}
	if r := pk(s, both...); r.AuthID != "claude-a" {
		t.Fatalf("retry pick %+v", r)
	}
	c.add(time.Second)
	answered(s, c, "claude:s1", "claude-a")
	if boundTo(s) != "claude-a" || s.Build().Sessions["s1"].LastSwitch != nil {
		t.Fatal("moved")
	}
	log := s.TakeLog()
	var fails, oks int
	for _, e := range log {
		switch {
		case e.F == FailConnection:
			fails++
		case e.Ev == EventRetry && e.OK:
			oks++
		case e.Ev == EventMove:
			t.Fatalf("a move line: %+v", e)
		}
	}
	if fails != 1 || oks != 1 {
		t.Fatalf("log = %+v", log)
	}
}

func TestA529WaitsForItsAccountInALargeSession(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
	c.add(10 * time.Second)
	if r := pk(s, credB); !r.Reject || r.Reason != "quota-pilot: d••• returned HTTP 529; retrying it in about 50s; k••• is next if needed" {
		t.Fatalf("pick %+v", r)
	}
	c.add(50 * time.Second)
	if r := pk(s, credB); !r.Reject {
		t.Fatalf("pick at 60 s %+v", r)
	}
	if r := pk(s, both...); r.AuthID != "claude-a" {
		t.Fatalf("pick once offered %+v", r)
	}
	t.Run("a pause past the give-up promises no retry", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t.Add(-time.Second), Failed: true,
			StatusCode: 503, Latency: time.Second, TTFT: time.Second, ResponseHeader: http.Header{"Retry-After": {"120"}}})
		if r := pk(s, credB); r.Reason != "quota-pilot: d••• returned HTTP 503; waiting up to 75s for it; k••• is next if needed" {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("another account, when none is known to take over", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Email: "dana@example.com"}, {ID: "claude-b", Provider: "claude", Email: "kim@example.com", Disabled: true}})
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		if r := pk(s, credB); !strings.HasSuffix(r.Reason, "; another account is next if needed") {
			t.Fatalf("pick %+v", r)
		}
	})
}

func TestWhatIsNeverDeclined(t *testing.T) {
	t.Run("a small session's 529 fails over at once", func(t *testing.T) {
		s, c := retrySetup(t, 40_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		if r := pk(s, credB); r.Reject || r.AuthID != "claude-b" {
			t.Fatalf("pick %+v", r)
		}
	})
	for _, f := range []struct {
		name   string
		status int
		text   string
	}{{"a 418", 418, ""}, {"a 422 model_not_found", 422, `{"error":{"code":"model_not_found"}}`}, {"a 400 unknown_model", 400, `{"error":{"code":"unknown_model"}}`}} {
		t.Run(f.name, func(t *testing.T) {
			s, c := retrySetup(t, 160_000)
			failed(s, c, "claude-a", "", f.status, f.text, time.Second, time.Second)
			if r := pk(s, credB); r.Reject {
				t.Fatalf("pick %+v", r)
			}
		})
	}
	t.Run("a Codex session", func(t *testing.T) {
		s, c := newTestState()
		a, b := Candidate{ID: "codex-a", Provider: "codex"}, Candidate{ID: "codex-b", Provider: "codex"}
		pickCodex := func(cands ...Candidate) PickResult {
			return s.Pick(PickInput{Provider: "codex", Model: "gpt-6.1-sol", Canonical: "codex:c1", Candidates: cands})
		}
		pickCodex(a)
		s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", SessionID: "codex:c1", AuthID: "codex-a", RequestedAt: c.t, Output: 5})
		s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", SessionID: "codex:c1", AuthID: "codex-a", RequestedAt: c.t, Failed: true, ErrorText: "EOF", Latency: time.Second})
		if r := pickCodex(b); r.Reject {
			t.Fatalf("pick %+v", r)
		}
	})
}

func TestAnEpisodeEnds(t *testing.T) {
	t.Run("its retries spent", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
		for try := 1; try <= 2; try++ {
			if r := pk(s, credB); !r.Reject {
				t.Fatalf("before try %d: %+v", try, r)
			}
			pk(s, both...)
			c.add(time.Second)
			failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
		}
		if resting(s, "claude-a") {
			t.Fatal("retries within 10 s of the first failure rested the account")
		}
		if r := pk(s, credB); r.Reject {
			t.Fatalf("declined with its retries spent: %+v", r)
		}
		if lines := eventLines(s, EventRetry); len(lines) != 2 || lines[1].Try != 2 || lines[1].F != FailConnection || lines[1].OK {
			t.Fatalf("retry lines %+v", lines)
		}
	})
	t.Run("75 s with no retry started", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(76 * time.Second)
		if r := pk(s, credB); r.Reject {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("a sign-in failure, and the refreshed request answers there", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(61 * time.Second)
		pk(s, both...)
		failed(s, c, "claude-a", "", 401, "", time.Second, time.Second)
		if r := pk(s, credB); r.Reject {
			t.Fatalf("pick %+v", r)
		}
		answered(s, c, "claude:s1", "claude-a")
		if boundTo(s) != "claude-a" {
			t.Fatal("moved")
		}
	})
	t.Run("the account starting to rest", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 502, "", time.Second, time.Second)
		c.add(61 * time.Second)
		pk(s, both...)
		c.add(time.Second)
		failed(s, c, "claude-a", "", 502, "", time.Second, time.Second)
		if !resting(s, "claude-a") {
			t.Fatal("not resting")
		}
		if r := pk(s, both...); r.AuthID != "claude-b" {
			t.Fatalf("pick %+v", r)
		}
	})
	for _, gone := range []struct {
		name string
		list []CredInfo
	}{{"the account removed", []CredInfo{{ID: "claude-b", Provider: "claude", Email: "kim@example.com"}}},
		{"the account disabled", []CredInfo{{ID: "claude-a", Provider: "claude", Email: "dana@example.com", Disabled: true}, {ID: "claude-b", Provider: "claude", Email: "kim@example.com"}}}} {
		t.Run(gone.name, func(t *testing.T) {
			s, c := retrySetup(t, 160_000)
			failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
			in := PickInput{Provider: "claude", Model: opus, Canonical: "claude:s1", Candidates: []Candidate{credB}}
			c.add(6 * time.Second)
			if !s.NeedsAccountList(in) {
				t.Fatal("an old account list is not read again while the episode runs")
			}
			s.UpdateInventory(gone.list)
			if s.NeedsAccountList(in) {
				t.Fatal("read again with no episode")
			}
			if r := s.Pick(in); r.Reject || r.AuthID != "claude-b" {
				t.Fatalf("pick %+v", r)
			}
			// A late failure of the removed account is history: no episode.
			failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
			if v := s.Build().Sessions["s1"]; v.Retry != nil {
				t.Fatalf("retry %+v", v.Retry)
			}
		})
	}
}

func TestEndingStopsTheDeclinesAndNothingMore(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	failed(s, c, "claude-a", "", 429, "", time.Second, time.Second) // rate-limited: never rests
	for range 2 {
		c.add(30 * time.Second)
		pk(s, both...)
		failed(s, c, "claude-a", "", 429, "", time.Second, time.Second)
	}
	c.add(16 * time.Second) // 76 s after the first failure
	if r := pk(s, both...); r.AuthID != "claude-a" {
		t.Fatalf("A and B offered: %+v", r)
	}
	if r := pk(s, credB); r.Reject || r.AuthID != "claude-b" {
		t.Fatalf("only B offered: %+v", r)
	}
}

func TestTheWindowBoundsWhenARetryStartsNotHowLongItRuns(t *testing.T) {
	t.Run("a retry that starts at 61 s and works at 120 s keeps the session", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(61 * time.Second)
		pk(s, both...)
		sent := c.t
		c.add(59 * time.Second)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: sent, CacheRead: 160_000, Output: 5})
		if v := s.Build().Sessions["s1"]; v.RetryOutcome == nil || v.Retry != nil || boundTo(s) != "claude-a" {
			t.Fatalf("view %+v", v)
		}
	})
	t.Run("another request answered elsewhere at 80 s moves it, and the retry's later success does not move it back", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(61 * time.Second)
		pk(s, both...)
		sent := c.t
		c.add(19 * time.Second)
		if r := pk(s, credB); r.Reject {
			t.Fatalf("declined after 75 s: %+v", r)
		}
		answered(s, c, "claude:s1", "claude-b")
		c.add(40 * time.Second)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: sent, CacheRead: 160_000, Output: 5})
		if boundTo(s) != "claude-b" || len(eventLines(s, EventMove)) != 1 {
			t.Fatalf("bound to %s", boundTo(s))
		}
	})
}

func TestAnEpisodeFollowsThePicksModel(t *testing.T) {
	t.Run("an alias", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		s.Intercept(InterceptInput{Session: "s1", TraceID: "t1", Format: "claude", Model: "team-opus", RequestedModel: "team-opus", Tools: 3})
		pick(s, "claude:s1", "team-opus", both)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "t1", AuthID: "claude-a", RequestedAt: c.t.Add(-time.Second),
			Failed: true, ErrorText: "EOF", Latency: time.Second})
		if r := pick(s, "claude:s1", "team-opus", []Candidate{credB}); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
		if r := pick(s, "claude:s1", opus, []Candidate{credB}); r.Reject {
			t.Fatalf("declined under the executor's model: %+v", r)
		}
		// A record sent before a pick of the alias went elsewhere meets the boundary.
		c.add(time.Second)
		s.Intercept(InterceptInput{Session: "s1", TraceID: "t2", Format: "claude", Model: "team-opus", RequestedModel: "team-opus", Tools: 3})
		sent := c.t
		c.add(76 * time.Second)
		pick(s, "claude:s1", "team-opus", []Candidate{credB}) // the episode over: another account
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "t2", AuthID: "claude-a", RequestedAt: sent,
			Failed: true, ErrorText: "EOF", Latency: time.Second})
		if r := pick(s, "claude:s1", "team-opus", []Candidate{credB}); r.Reject {
			t.Fatalf("a late record started an episode: %+v", r)
		}
	})
	t.Run("a route to another provider's model", func(t *testing.T) {
		s, c := newTestState()
		xa, xb := Candidate{ID: "codex-a", Provider: "codex"}, Candidate{ID: "codex-b", Provider: "codex"}
		routed := func(cands ...Candidate) PickResult {
			return s.Pick(PickInput{Provider: "codex", Model: "gpt-6-sol", Canonical: "claude:s1", Candidates: cands})
		}
		routed(xa)
		s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", AuthID: "codex-a", RequestedAt: c.t, Output: 5})
		s.Intercept(InterceptInput{Session: "s1", TraceID: "r1", Format: "claude", Model: "gpt-6-sol", RequestedModel: opus, Tools: 3})
		s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", TraceID: "r1", AuthID: "codex-a", RequestedAt: c.t,
			Failed: true, ErrorText: "EOF", Latency: time.Second})
		if r := routed(xb); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
		if _, ok := s.episodes[episodeKey{"codex|claude:s1", "gpt-6-sol"}]; !ok {
			t.Fatalf("episodes %+v", s.episodes)
		}
	})
}

func TestTheHungMark(t *testing.T) {
	t.Run("a hang whose retry fails at once", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
		pk(s, both...)
		c.add(2 * time.Second)
		failed(s, c, "claude-a", "", 0, "read: connection reset by peer", time.Second, 0)
		if resting(s, "claude-a") {
			t.Fatal("one failure moment rested the account")
		}
		if r := pk(s, both...); r.AuthID != "claude-b" {
			t.Fatalf("A and B offered: %+v", r)
		}
		if r := pk(s, credA); r.AuthID != "claude-a" {
			t.Fatalf("only A offered: %+v", r)
		}
		// A success on A by another request of the binding clears it.
		answered(s, c, "claude:s1", "claude-a")
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("after a success on A: %+v", r)
		}
	})
	t.Run("a switch clears it", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
		pk(s, both...)
		failed(s, c, "claude-a", "", 499, "context canceled", time.Second, 0)
		s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-a"})
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("a hang whose retry answered, then failed, leaves none", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
		pk(s, both...)
		c.add(10 * time.Second)
		failed(s, c, "claude-a", "", 0, "unexpected EOF", 10*time.Second, 2*time.Second)
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("a retry that hung marks it, whatever began the episode", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
		c.add(20 * time.Second)
		answered(s, c, "claude:other", "claude-a") // another session: A's failure moments start over
		pk(s, both...)
		c.add(40 * time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", 40*time.Second, 0)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:other", AuthID: "claude-b", RequestedAt: c.t, Failed: true, ErrorText: "connection reset", Latency: time.Second})
		if resting(s, "claude-a") {
			t.Fatal("resting")
		}
		if r := pk(s, both...); r.AuthID == "claude-a" {
			t.Fatalf("pick %+v", r)
		}
	})
}

func TestWhatEscDoes(t *testing.T) {
	t.Run("a cancel during the first hang starts nothing", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		pk(s, both...)
		c.add(135 * time.Second)
		failed(s, c, "claude-a", "", 499, "context canceled", 135*time.Second, 0)
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("a cancel while Claude Code waits between retries leaves the episode running", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(30 * time.Second) // Esc: no attempt was upstream, so no record
		if r := pk(s, credB); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
		if r := pk(s, both...); r.AuthID != "claude-a" {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("a switch ends the episode", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
		if r := pk(s, both...); r.AuthID != "claude-b" || s.Build().Sessions["s1"].Retry != nil {
			t.Fatalf("pick %+v", r)
		}
	})
}

// A marked binding is announced like a resting account, toward the account a failover takes now.
func TestAHungBindingIsAnnounced(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	pk(s, both...)
	c.add(135 * time.Second)
	failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
	pk(s, both...)
	c.add(45 * time.Second)
	failed(s, c, "claude-a", "", 499, "context canceled", 45*time.Second, 0)
	v := s.Build().Sessions["s1"]
	if !v.SwitchImminent || v.SwitchReason != "got no answer" || v.NextAuthID != "claude-b" || v.Takeover != "claude-b" {
		t.Fatalf("view %+v", v)
	}
	// Absent while no account is known to take it.
	failed(s, c, "claude-b", "", 404, `{"error":{"type":"not_found_error"}}`, time.Second, time.Second)
	if v := s.Build().Sessions["s1"]; v.SwitchImminent || v.Takeover != "" {
		t.Fatalf("view %+v", v)
	}
}

// The account that takes over is one a pick has offered for the session's model: B, offered for
// Sonnet but not for Opus (the host cools it for Opus), takes over no Opus session, so the band's
// rows name none.
func TestTheTakeoverIsOfferedForTheSessionsModel(t *testing.T) {
	s, c := twoAccounts(t)
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Email: "dana@example.com"}, {ID: "claude-b", Provider: "claude", Email: "kim@example.com"}})
	if r := pick(s, "claude:s1", opus, []Candidate{credA}); r.AuthID != "claude-a" {
		t.Fatalf("pick %s", r.AuthID)
	}
	answered(s, c, "claude:s1", "claude-a")
	pick(s, "claude:s2", "claude-sonnet-5-5", both)
	if v := s.Build().Sessions["s1"]; v.Takeover != "" {
		t.Fatalf("takeover %q with B offered only for Sonnet", v.Takeover)
	}
	pk(s, both...)
	if v := s.Build().Sessions["s1"]; v.Takeover != "claude-b" {
		t.Fatalf("takeover %q with B offered for Opus", v.Takeover)
	}
}

func TestEveryRequestOfTheBindingTakesPart(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
	if r := pick(s, "claude:s1:agent:x", opus, []Candidate{credB}); !r.Reject {
		t.Fatalf("a subagent's pick %+v", r)
	}
	// A side request's success on A ends it kept.
	s.Intercept(InterceptInput{Session: "s1", TraceID: "side", Format: "claude", Model: opus, RequestedModel: opus})
	c.add(61 * time.Second)
	pk(s, both...)
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "side", AuthID: "claude-a", RequestedAt: c.t, Output: 5})
	if v := s.Build().Sessions["s1"]; v.Retry != nil || v.RetryOutcome == nil {
		t.Fatalf("view %+v", v)
	}
	// A side request's success elsewhere never moves the binding.
	s.Intercept(InterceptInput{Session: "s1", TraceID: "side2", Format: "claude", Model: opus, RequestedModel: opus})
	pk(s, credB)
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", TraceID: "side2", AuthID: "claude-b", RequestedAt: c.t, Output: 5})
	if boundTo(s) != "claude-a" {
		t.Fatal("a side request moved the binding")
	}
}

func TestARecordSentBeforeTheGenerationSaysNothing(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	sent := c.t
	c.add(time.Second)
	s.Apply(Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "claude", Model: "claude-sonnet-5-5"})
	s.Apply(Command{CommandID: "u1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "unroute"})
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: sent, Failed: true, StatusCode: 529, Latency: time.Second})
	if r := pk(s, credB); r.Reject {
		t.Fatalf("a record from before the route started an episode: %+v", r)
	}
}

// A pick that does not offer the bound account waits up to 200 ms for the record of the attempt it
// was just answered with.
func TestAPickWaitsBrieflyForTheRecordOfTheAttemptOnItsAccount(t *testing.T) {
	late := func(s *State, c *clock, after time.Duration) chan struct{} {
		done := make(chan struct{})
		sent := c.t
		go func() {
			defer close(done)
			time.Sleep(after)
			s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: sent, Failed: true, ErrorText: "EOF", Latency: time.Millisecond})
		}()
		return done
	}
	t.Run("a record within the wait starts the retry", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		pk(s, both...)
		done := late(s, c, 50*time.Millisecond)
		if r := pk(s, credB); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
		<-done
	})
	t.Run("a record after 300 ms starts nothing, and the move stands once", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		pk(s, both...)
		done := late(s, c, 300*time.Millisecond)
		if r := pk(s, credB); r.Reject || r.AuthID != "claude-b" {
			t.Fatalf("pick %+v", r)
		}
		<-done
		if r := pk(s, credB); r.Reject {
			t.Fatalf("the late record started an episode: %+v", r)
		}
		c.add(time.Second)
		answered(s, c, "claude:s1", "claude-b")
		sw := s.Build().Sessions["s1"].LastSwitch
		if boundTo(s) != "claude-b" || sw == nil || sw.Kind != MoveFailed || len(eventLines(s, EventMove)) != 1 {
			t.Fatalf("bound to %s, record %+v", boundTo(s), sw)
		}
	})
	t.Run("a failure of an attempt sent after the boundary starts a new episode", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		pk(s, both...)
		done := late(s, c, 300*time.Millisecond)
		pk(s, credB)
		<-done
		c.add(time.Second)
		pk(s, both...)
		c.add(time.Second)
		failed(s, c, "claude-a", "", 0, "EOF", time.Second, 0)
		if r := pk(s, credB); !r.Reject {
			t.Fatalf("pick %+v", r)
		}
	})
	t.Run("delivered after the success elsewhere, it rewrites nothing", func(t *testing.T) {
		s, c := retrySetup(t, 4_000)
		pk(s, both...)
		sent := c.t
		s.mu.Lock()
		delete(s.inflight, episodeKey{"claude|claude:s1", opus}) // as after the 200 ms wait
		s.mu.Unlock()
		pk(s, credB)
		c.add(time.Second)
		answered(s, c, "claude:s1", "claude-b")
		before := *s.Build().Sessions["s1"].LastSwitch
		s.TakeLog()
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: sent, Failed: true, ErrorText: "EOF", Latency: time.Millisecond})
		if boundTo(s) != "claude-b" || *s.Build().Sessions["s1"].LastSwitch != before || len(eventLines(s, EventMove)) != 0 {
			t.Fatal("the late record rewrote the move")
		}
	})
}
