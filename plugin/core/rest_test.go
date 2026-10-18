package core

import (
	"encoding/json"
	"testing"
	"time"
)

// attemptEnds records a failed attempt of session s on authID, sent `wait` before it ends now.
func attemptEnds(s *State, c *clock, session, authID string, status int, text string, wait, ttft time.Duration) {
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: session, AuthID: authID,
		RequestedAt: c.t.Add(-wait), Failed: true, StatusCode: status, ErrorText: text, Latency: wait, TTFT: ttft})
}

func resting(s *State, id string) bool {
	c := s.creds[id]
	return c != nil && c.health.resting(s.now())
}

func restLeft(s *State, id string) time.Duration { return s.creds[id].health.until.Sub(s.now()) }

func TestFailureMomentsAndRests(t *testing.T) {
	t.Run("requests that hung from different times and failed together are one moment", func(t *testing.T) {
		s, c := twoAccounts(t)
		c.add(135 * time.Second)
		for _, sent := range []time.Duration{135, 105, 60} {
			attemptEnds(s, c, "claude:s1", "claude-a", 0, "EOF", sent*time.Second, 0)
		}
		if resting(s, "claude-a") || s.creds["claude-a"].health.moments != 1 {
			t.Fatalf("moments %d", s.creds["claude-a"].health.moments)
		}
	})
	t.Run("three sessions failing in one second are one moment", func(t *testing.T) {
		s, c := twoAccounts(t)
		for _, sess := range []string{"claude:s1", "claude:s2", "claude:s3"} {
			attemptEnds(s, c, sess, "claude-a", 529, "", time.Second, time.Second)
		}
		if resting(s, "claude-a") {
			t.Fatal("one moment rested the account")
		}
	})
	t.Run("a second moment within 15 minutes rests it, and each failed trial doubles the rest", func(t *testing.T) {
		s, c := twoAccounts(t)
		attemptEnds(s, c, "claude:s1", "claude-a", 529, "", time.Second, time.Second)
		c.add(14 * time.Minute)
		attemptEnds(s, c, "claude:s1", "claude-a", 529, "", time.Second, time.Second)
		if !resting(s, "claude-a") || restLeft(s, "claude-a") != 5*time.Minute {
			t.Fatalf("first rest: resting %v, left %v", resting(s, "claude-a"), restLeft(s, "claude-a"))
		}
		for _, want := range []time.Duration{10, 20, 40, 60, 60} {
			c.add(restLeft(s, "claude-a") + time.Second)
			if resting(s, "claude-a") || !s.creds["claude-a"].health.trial(c.t) {
				t.Fatal("not on trial after the rest")
			}
			// A trial failure long after the previous moment still rests it at once.
			c.add(20 * time.Minute)
			attemptEnds(s, c, "claude:s1", "claude-a", 502, "", time.Second, time.Second)
			if !resting(s, "claude-a") || restLeft(s, "claude-a") != want*time.Minute {
				t.Fatalf("rest after a failed trial: %v, want %v", restLeft(s, "claude-a"), want*time.Minute)
			}
		}
		// One success ends it, and the count starts over.
		s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Output: 5})
		attemptEnds(s, c, "claude:s1", "claude-a", 502, "", time.Second, time.Second)
		if resting(s, "claude-a") {
			t.Fatal("still resting after a success and one failure")
		}
		c.add(time.Minute)
		attemptEnds(s, c, "claude:s1", "claude-a", 502, "", time.Second, time.Second)
		if !resting(s, "claude-a") || restLeft(s, "claude-a") != 5*time.Minute {
			t.Fatalf("after a success the first rest is 5 minutes again, got %v", restLeft(s, "claude-a"))
		}
	})
	t.Run("two moments more than 15 minutes apart do not", func(t *testing.T) {
		s, c := twoAccounts(t)
		attemptEnds(s, c, "claude:s1", "claude-a", 529, "", time.Second, time.Second)
		c.add(16 * time.Minute)
		attemptEnds(s, c, "claude:s1", "claude-a", 529, "", time.Second, time.Second)
		if resting(s, "claude-a") {
			t.Fatal("rested after moments 16 minutes apart")
		}
	})
	t.Run("two quick 507s 61 s apart", func(t *testing.T) {
		s, c := twoAccounts(t)
		attemptEnds(s, c, "claude:s1", "claude-a", 507, "", time.Second, time.Second)
		c.add(61 * time.Second)
		attemptEnds(s, c, "claude:s1", "claude-a", 507, "", time.Second, time.Second)
		if !resting(s, "claude-a") || restLeft(s, "claude-a") != 5*time.Minute {
			t.Fatal("two server failures did not rest the account")
		}
	})
}

// Only the failures the proxy holds no account back for count toward rest.
func TestOnlyFailuresTheProxyDoesNotCoolCount(t *testing.T) {
	cases := []struct {
		name   string
		status int
		text   string
		wait   time.Duration
		ttft   time.Duration
		trace  bool // a compact request
	}{
		{"a fast-mode entitlement 429", 429, `{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}`, time.Second, time.Second, false},
		{"another 429", 429, `{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}`, time.Second, time.Second, false},
		{"a 401", 401, "", time.Second, time.Second, false},
		{"a generic 404", 404, `{"error":{"type":"not_found_error","message":"not found"}}`, time.Second, time.Second, false},
		{"a compact 404", 404, `{"error":{"message":"not found"}}`, time.Second, time.Second, true},
		{"a 400 a stop-and-cooldown rule cools", 400, `{"error":{"message":"bad"}}`, time.Second, time.Second, false},
		{"a request failure", 499, "context canceled", 45 * time.Second, 0, false},
		{"a refused grant with no status after 40 s", 0, "token refresh failed: invalid_grant", 40 * time.Second, 0, false},
		{"a 422 model_not_found", 422, `{"error":{"code":"model_not_found"}}`, time.Second, time.Second, false},
		{"a 400 unknown_model", 400, `{"error":{"code":"unknown_model"}}`, time.Second, time.Second, false},
		{"a 404 saying model_not_supported", 404, `{"error":{"message":"model_not_supported"}}`, time.Second, time.Second, false},
		{"a 400 not available for your plan", 400, `{"error":{"message":"not available for your plan"}}`, time.Second, time.Second, false},
	}
	for _, f := range cases {
		t.Run(f.name, func(t *testing.T) {
			s, c := twoAccounts(t)
			served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
			for range 2 {
				c.add(61 * time.Second)
				trace := ""
				if f.trace {
					trace = "cmp-" + c.t.String()
					s.Intercept(InterceptInput{TraceID: trace, Format: "openai-response", Model: "claude-opus-5-5", Path: "/v1/responses/compact"})
				}
				s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", TraceID: trace, AuthID: "claude-a",
					RequestedAt: c.t.Add(-f.wait), Failed: true, StatusCode: f.status, ErrorText: f.text, Latency: f.wait, TTFT: f.ttft})
			}
			if resting(s, "claude-a") {
				t.Fatal("rested")
			}
			// The account keeps its sessions: the next turn stays, with no cold move.
			if got := pick(s, "claude:s1", "claude-sonnet-5-5", both); got.AuthID != "claude-a" {
				t.Fatalf("session moved to %s", got.AuthID)
			}
		})
	}
}

// restOn rests claude-a with two 529 moments.
func restOn(s *State, c *clock, id string) {
	attemptEnds(s, c, "claude:x", id, 529, "", time.Second, time.Second)
	c.add(time.Minute)
	attemptEnds(s, c, "claude:x", id, 529, "", time.Second, time.Second)
}

func TestARestingAccountServesOnlyWhenNothingElseCan(t *testing.T) {
	t.Run("a new session gets any other account that can serve, whatever its tier", func(t *testing.T) {
		s, c := newTestState()
		setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
		setQuota(s, c, "claude-b", 0.05, 0.5, 4*24*time.Hour) // 5-hour low: tier 3, but it can serve
		restOn(s, c, "claude-a")
		if got := pick(s, "claude:new", "claude-opus-5-5", both); got.AuthID != "claude-b" {
			t.Fatalf("new session got %s", got.AuthID)
		}
		snap := s.Build()
		if order := snap.Providers["claude"].Credentials; order[0].ID != "claude-b" || order[1].Rest == nil || order[1].Reason != "resting after 2 failures" {
			t.Fatalf("order %+v, %+v", order[0], order[1])
		}
		if exp := s.BuildForBand("", "claude-opus-5-5", "").Expected["claude"]; exp != opaqueID("claude-b") {
			t.Fatalf("expected %s", exp)
		}
	})
	t.Run("alone, it still serves", func(t *testing.T) {
		s, c := newTestState()
		setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
		restOn(s, c, "claude-a")
		if got := pick(s, "claude:new", "claude-opus-5-5", []Candidate{credA}); got.AuthID != "claude-a" {
			t.Fatalf("got %s", got.AuthID)
		}
	})
}

func TestASessionLeavesARestingAccountAtItsNextTurn(t *testing.T) {
	t.Run("to an account that can serve, and the move says rest", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		restOn(s, c, "claude-a")
		got := pick(s, "claude:s1", "claude-opus-5-5", both)
		if got.AuthID != "claude-b" {
			t.Fatalf("pick = %s", got.AuthID)
		}
		served(s, c, "claude:s1", got.AuthID, false)
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveRest || sw.Cause == nil || sw.Cause.Count != 2 || sw.Cause.Kind != FailOverloaded || !sw.Cause.Until.After(c.t) {
			t.Fatalf("record %+v cause %+v", sw, sw.Cause)
		}
	})
	t.Run("the provider's only account resting keeps its session", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credA}).AuthID, false)
		restOn(s, c, "claude-a")
		if got := pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credA}); got.AuthID != "claude-a" {
			t.Fatalf("pick = %s", got.AuthID)
		}
	})
	t.Run("every other account cooling for the session's model keeps it", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		restOn(s, c, "claude-a")
		// The proxy offers only A for Opus: B cools for it.
		if got := pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credA}); got.AuthID != "claude-a" {
			t.Fatalf("pick = %s", got.AuthID)
		}
	})
	t.Run("a failover that leaves it resting says both", func(t *testing.T) {
		s, c := twoAccounts(t)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, false)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(time.Minute)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB}).AuthID, false)
		sw := s.Build().Sessions["s1"].LastSwitch
		if sw == nil || sw.Kind != MoveRest || sw.Cause.Count != 2 || sw.Cause.Status != 529 {
			t.Fatalf("record %+v", sw)
		}
	})
}

func TestRestLivesInMemoryAndIsNoQuotaLimit(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	restOn(s, c, "claude-a")
	restOn(s, c, "claude-b")
	if h := s.Health("claude", "claude-opus-5-5"); h == "exhausted" {
		t.Fatal("every account resting reads exhausted")
	}
	s.SetConfig(Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude": "codex:gpt-6-sol"}})
	if d := s.Route(RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 3000, Available: []string{"claude", "codex"}, Turn: true}); d.Handled {
		t.Fatalf("routed for rest: %+v", d)
	}
	saved, _ := json.Marshal(s.Export())
	var p Persisted
	_ = json.Unmarshal(saved, &p)
	back := New("boot-2", c.now)
	back.Import(p)
	if back.creds["claude-a"].health.level != 0 {
		t.Fatal("a rest survived a restart")
	}
}

// A session bound to a resting account is warned of its move only toward an account a pick has
// listed for its model since that account last failed.
func TestTheRestingWarningNamesOnlyAListedAccount(t *testing.T) {
	const opus, sonnet = "claude-opus-5-5", "claude-sonnet-5-5"
	setup := func(t *testing.T) (*State, *clock) {
		s, c := twoAccounts(t)
		s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
		intercepted(s, "t0", opus, 3)
		served(s, c, "claude:s1", pick(s, "claude:s1", opus, []Candidate{credA}).AuthID, false)
		restOn(s, c, "claude-a")
		return s, c
	}
	view := func(s *State) *SessionView { return s.Build().Sessions["s1"] }
	t.Run("the provider's only account", func(t *testing.T) {
		s, _ := setup(t)
		delete(s.creds, "claude-b")
		if v := view(s); v.SwitchImminent {
			t.Fatalf("view %+v", v)
		}
	})
	t.Run("the other listed only for another model", func(t *testing.T) {
		s, _ := setup(t)
		s.Pick(PickInput{Provider: "claude", Model: sonnet, Canonical: "claude:other", Candidates: both})
		if v := view(s); v.SwitchImminent {
			t.Fatalf("view %+v", v)
		}
	})
	t.Run("the other listed for the model, then failing", func(t *testing.T) {
		s, c := setup(t)
		s.Pick(PickInput{Provider: "claude", Model: opus, Canonical: "claude:other", Candidates: both})
		v := view(s)
		if !v.SwitchImminent || v.NextAuthID != "claude-b" || v.SwitchReason != "resting after 2 failures" {
			t.Fatalf("view %+v", v)
		}
		c.add(time.Second)
		attemptEnds(s, c, "claude:other", "claude-b", 404, `{"error":{"type":"not_found_error","message":"not found"}}`, time.Second, time.Second)
		if v := view(s); v.SwitchImminent {
			t.Fatalf("after B failed: %+v", v)
		}
	})
}
