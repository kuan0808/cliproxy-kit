package core

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time      { return c.t }
func (c *clock) add(d time.Duration) { c.t = c.t.Add(d) }
func newTestState() (*State, *clock) {
	c := &clock{t: time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)}
	return New("boot-1", c.now), c
}

var (
	credA = Candidate{ID: "claude-a", Provider: "claude"}
	credB = Candidate{ID: "claude-b", Provider: "claude"}
	both  = []Candidate{credA, credB}
)

// setQuota gives a Claude credential fresh 5-hour and weekly windows.
func setQuota(s *State, c *clock, id string, five, weekly float64, weeklyReset time.Duration) {
	s.MergeWindows(id, "claude", []Window{
		{Kind: KindFiveHour, Remaining: five, ResetAt: c.t.Add(3 * time.Hour), ObservedAt: c.t},
		{Kind: KindWeekly, Remaining: weekly, ResetAt: c.t.Add(weeklyReset), ObservedAt: c.t},
	})
}

func pick(s *State, canonical, model string, cands []Candidate) PickResult {
	return s.Pick(PickInput{Provider: "claude", Model: model, Canonical: canonical, Parent: parentOf(canonical), Candidates: cands})
}

func parentOf(canonical string) string {
	if i := strings.Index(canonical, agentMarker); i >= 0 {
		return canonical[:i]
	}
	return ""
}

// served records a successful request; thread marks one that carried a message thread.
func served(s *State, c *clock, canonical, authID string, thread bool) {
	trace := ""
	if thread {
		trace = canonical + "@" + c.t.String()
		s.Intercept(InterceptInput{Session: RawSession(rootOnly(canonical)), TraceID: trace, Format: "claude", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5", Thread: "continue", Tools: 20})
	}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: canonical, ParentID: parentOf(canonical), TraceID: trace, AuthID: authID, RequestedAt: c.t})
}

func TestSoonestWeeklyResetWins(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 4*24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" || !got.Handled {
		t.Fatalf("pick = %+v, want claude-b", got)
	}
}

func TestFiveHourThresholdSkipsAccount(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.05, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v, want claude-b because claude-a is under the 5-hour threshold", got)
	}
}

// A new session takes the account whose weekly quota resets soonest among those with enough of
// their 5-hour window left: a quarter by default, or any part when that window resets within half
// an hour, as what is left of it then soon stops mattering.
func TestFiveHourHeadroomDecidesWhetherAnAccountIsReady(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.20, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.90, 0.5, 4*24*time.Hour)
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v, want claude-b: claude-a has under a quarter of its 5-hour window", got)
	}
	lowFive := func(reset time.Duration) *State {
		s, c := newTestState()
		w := Window{Kind: KindFiveHour, Remaining: 0.20, ObservedAt: c.t}
		if reset > 0 {
			w.ResetAt = c.t.Add(reset)
		}
		s.MergeWindows("claude-a", "claude", []Window{w, {Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
		setQuota(s, c, "claude-b", 0.90, 0.5, 4*24*time.Hour)
		return s
	}
	if got := pick(lowFive(20*time.Minute), "claude:s2", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("pick = %+v, want claude-a: its 5-hour window resets in 20 minutes", got)
	}
	// A window that does not say when it resets is not about to.
	if got := pick(lowFive(0), "claude:s3", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v, want claude-b: claude-a's low window has no reset", got)
	}
}

// A Fable request draws on Fable's own weekly window, so that window's reset orders the accounts.
func TestFableRequestsFollowFablesOwnWeek(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 2*24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 3*24*time.Hour)
	s.MergeWindows("claude-a", "claude", []Window{{Kind: "7d_fable", Remaining: 0.5, ResetAt: c.t.Add(5 * 24 * time.Hour), ObservedAt: c.t}})
	s.MergeWindows("claude-b", "claude", []Window{{Kind: "7d_fable", Remaining: 0.5, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
	if got := pick(s, "claude:s1", "claude-fable-5-1", both); got.AuthID != "claude-b" {
		t.Fatalf("fable pick = %+v, want claude-b, whose Fable week resets first", got)
	}
	if got := pick(s, "claude:s2", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("opus pick = %+v, want claude-a, whose own week resets first", got)
	}
}

// A session idle for an hour has lost its prompt cache anyway: when its account runs low, its next
// request moves to the best account at no cost. A session in use, or one the user switched, stays.
func TestAnIdleSessionMovesOffAnAccountRunningLow(t *testing.T) {
	s, c := newTestState()
	fresh := func(aFive float64) {
		setQuota(s, c, "claude-a", aFive, 0.5, 24*time.Hour)
		setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	}
	fresh(0.9)
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true)
	cmd := Command{CommandID: "c1", Session: "s2", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-a"}
	served(s, c, "claude:s2", pick(s, "claude:s2", "m", both).AuthID, true)
	if ack := s.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("switch ack = %+v", ack)
	}

	c.t = c.t.Add(30 * time.Minute)
	fresh(0.05)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("a session in use moved: %+v", got)
	}
	served(s, c, "claude:s1", "claude-a", true)

	c.t = c.t.Add(61 * time.Minute)
	fresh(0.05)
	got := pick(s, "claude:s1", "m", both)
	if got.AuthID != "claude-b" || !strings.Contains(got.Reason, "idle") {
		t.Fatalf("an idle session on a low account = %+v, want claude-b", got)
	}
	served(s, c, "claude:s1", "claude-b", false)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("after the move, pick = %+v", got)
	}
	if got := pick(s, "claude:s2", "m", both); got.AuthID != "claude-a" || got.Reason != switchedReason {
		t.Fatalf("a switched session moved: %+v", got)
	}
}

// An account read as used up often answers a while longer: its sessions stay until it turns a
// request away, and then every session on it leaves at its next request, not after a refusal of
// its own. With no ready account to go to, they stay.
func TestARefusalMovesEverySessionOffAUsedUpAccount(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true)
	served(s, c, "claude:s2", pick(s, "claude:s2", "m", both).AuthID, true)

	setQuota(s, c, "claude-a", 0.9, 0, 24*time.Hour)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("a used-up reading moved a session the account still serves: %+v", got)
	}

	refuse := func(id string, status int) {
		h := http.Header{}
		h.Set("anthropic-ratelimit-unified-7d-utilization", "1.0")
		h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprint(c.t.Add(24*time.Hour).Unix()))
		s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: id, RequestedAt: c.t, Failed: true, StatusCode: status, ResponseHeader: h})
	}
	// A failure of the request itself (a lost thread) is not a refusal, even on a used-up account.
	refuse("claude-a", http.StatusNotFound)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("a 404 moved the session: %+v", got)
	}
	setQuota(s, c, "claude-b", 0.9, 0, 4*24*time.Hour)
	refuse("claude-a", http.StatusTooManyRequests)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("with no ready account, a refused session moved: %+v", got)
	}

	setQuota(s, c, "claude-b", 0.9, 0.5, 5*24*time.Hour) // its next week
	for _, id := range []string{"claude:s1", "claude:s2"} {
		got := pick(s, id, "m", both)
		if got.AuthID != "claude-b" || !strings.HasPrefix(got.Reason, "previous account unavailable") {
			t.Fatalf("%s after a refusal = %+v, want claude-b", id, got)
		}
	}

	// A week later the account answers again, and a session bound to it stays.
	c.t = c.t.Add(25 * time.Hour)
	setQuota(s, c, "claude-a", 0.9, 1, 7*24*time.Hour)
	served(s, c, "claude:s3", "claude-a", true)
	setQuota(s, c, "claude-a", 0.9, 0, 7*24*time.Hour)
	if got := pick(s, "claude:s3", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("an old refusal moved a session: %+v", got)
	}
}

func TestSessionStaysOnItsAccount(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	got := pick(s, "claude:s1", "m", both)
	served(s, c, "claude:s1", got.AuthID, true)
	// claude-a's next week now resets after claude-b's: the session stays, a new session follows
	// the ranking.
	setQuota(s, c, "claude-a", 0.9, 0.5, 5*24*time.Hour)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("bound pick moved to %s", got.AuthID)
	}
	if got := pick(s, "claude:s2", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("new session pick = %s, want claude-b", got.AuthID)
	}
	// Another model in the same session uses the same account: the binding has no model in it.
	if got := pick(s, "claude:s1", "claude-haiku-4-5", both); got.AuthID != "claude-a" {
		t.Fatalf("second model pick = %s, want the session's claude-a", got.AuthID)
	}
}

func TestFailedRetryDoesNotMoveTheBinding(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true)
	// The host retries on claude-b only, and that attempt fails too.
	if got := pick(s, "claude:s1", "m", []Candidate{credB}); got.AuthID != "claude-b" || !strings.HasPrefix(got.Reason, "previous account unavailable") {
		t.Fatalf("retry pick = %+v", got)
	}
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-b", Failed: true, RequestedAt: c.t})
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("a failed attempt moved the session to %s", got.AuthID)
	}
}

func TestDisplacedSessionMovesOnSuccess(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
	pick(s, "claude:s1", "claude-opus-5-5[1m]", []Candidate{credB}) // claude-a cooling down
	served(s, c, "claude:s1", "claude-b", false)
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("after the move pick = %s, want claude-b, no flip back", got.AuthID)
	}
	if v := s.Build().Sessions["s1"]; v.LastSwitch == nil || v.LastSwitch.From != "claude-a" || v.AuthID != "claude-b" {
		t.Fatalf("session view = %+v", v)
	}
}

func TestSideRequestDoesNotMoveTheBinding(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	served(s, c, "claude:s1", "claude-b", false) // a title request the host sent elsewhere
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("a side request moved the session to %s", got.AuthID)
	}
}

func TestSubagentFollowsParentAndKeepsItsOwnThread(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 4*24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true) // claude-b
	setQuota(s, c, "claude-a", 0.9, 0.5, time.Hour)                         // ranking now prefers claude-a
	sub := "claude:s1:agent:x"
	if got := pick(s, sub, "m", both); got.AuthID != "claude-b" {
		t.Fatalf("subagent got %s, parent has claude-b", got.AuthID)
	}
	// The subagent's thread lands on claude-a after a retry; the parent stays on claude-b.
	pick(s, sub, "m", []Candidate{credA})
	served(s, c, sub, "claude-a", true)
	if got := pick(s, sub, "m", both); got.AuthID != "claude-a" {
		t.Fatalf("subagent pick = %s, want its own thread's claude-a", got.AuthID)
	}
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("subagent moved the parent to %s", got.AuthID)
	}
	if v := s.Build().Sessions["s1"]; v.Totals.Input != 0 || v.AuthID != "claude-b" {
		t.Fatalf("subagent counted in the main session: %+v", v)
	}
}

func TestModelBucketExhaustedSkipsAccount(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.MergeWindows("claude-a", "claude", []Window{{Kind: "7d_opus", Remaining: 0, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("opus pick = %s, want claude-b", got.AuthID)
	}
	if got := pick(s, "claude:s2", "claude-sonnet-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("sonnet pick = %s, want claude-a", got.AuthID)
	}
}

func TestUnknownAndStaleQuotaRankAfterKnown(t *testing.T) {
	s, c := newTestState()
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" || !got.Handled {
		t.Fatalf("all unknown pick = %+v, want claude-a by id", got)
	}
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	if got := pick(s, "claude:s2", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("known beats unknown: got %s", got.AuthID)
	}
	c.add(2 * time.Hour)
	if got := pick(s, "claude:s3", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("stale data counts as unknown: got %s", got.AuthID)
	}
}

func TestPassedResetWaitsForANewObservation(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0, 30*time.Minute)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	if r := s.classifyLocked(s.creds["claude-a"], "m", c.t); !r.Blocked {
		t.Fatalf("used-up account not blocked: %+v", r)
	}
	c.add(time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 8*24*time.Hour)
	// claude-a's weekly window reset, but nothing says what it has now: unknown, not full.
	if r := s.classifyLocked(s.creds["claude-a"], "m", c.t); r.Tier != 2 || r.Blocked {
		t.Fatalf("passed reset = %+v, want unknown", r)
	}
	setQuota(s, c, "claude-a", 0.9, 1, 7*24*time.Hour)
	if got := pick(s, "claude:s2", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("after a fresh observation claude-a resets first; got %s", got.AuthID)
	}
}

func TestKnownExhaustionIsNotMaskedByAMissingWindow(t *testing.T) {
	s, c := newTestState()
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 0, ResetAt: c.t.Add(time.Hour), ObservedAt: c.t}})
	if r := s.classifyLocked(s.credLocked("claude-a", "claude"), "m", c.t); !r.Blocked {
		t.Fatalf("weekly 0 without a 5-hour window = %+v, want blocked", r)
	}
}

func TestAggregateCooldownDoesNotBlock(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Unavailable: true, NextRetryAfter: c.t.Add(time.Hour)}})
	if r := s.classifyLocked(s.creds["claude-a"], "claude-opus-5-5", c.t); r.Blocked {
		t.Fatalf("a cooldown on some model blocked every model: %+v", r)
	}
	if got := s.Health("claude", "claude-opus-5-5"); got == "exhausted" {
		t.Fatalf("health = %s", got)
	}
}

func TestNoSessionIsUnhandled(t *testing.T) {
	s, _ := newTestState()
	if got := s.Pick(PickInput{Provider: "claude", Candidates: both}); got.Handled {
		t.Fatalf("pick without session handled: %+v", got)
	}
}

// Accounts of a provider whose quota quota-pilot cannot read are left to CLIProxyAPI's own
// routing: never picked, bound or listed, while their requests are still logged with tokens.
func TestOtherProvidersAreLeftToTheProxy(t *testing.T) {
	s, c := newTestState()
	gemini := []Candidate{{ID: "gemini-a", Provider: "gemini"}, {ID: "gemini-b", Provider: "gemini"}}
	if got := s.Pick(PickInput{Provider: "gemini", Canonical: "claude:s1", Candidates: gemini}); got.Handled {
		t.Fatalf("pick among gemini accounts handled: %+v", got)
	}
	mixed := []Candidate{credA, {ID: "gemini-a", Provider: "gemini"}}
	if got := s.Pick(PickInput{Providers: []string{"claude", "gemini"}, Canonical: "claude:s1", Candidates: mixed}); got.Handled {
		t.Fatalf("pick on a route mixing in gemini handled: %+v", got)
	}
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "gemini-a", Provider: "Gemini"}})
	s.Observe(Usage{Provider: "gemini", Model: "gemini-3-pro", SessionID: "claude:s1", AuthID: "gemini-b", RequestedAt: c.t, Input: 10, Output: 5})
	if _, ok := s.Account("gemini-a"); ok {
		t.Error("gemini account listed from the inventory")
	}
	if _, ok := s.Account("gemini-b"); ok {
		t.Error("gemini account listed from a usage record")
	}
	if _, ok := s.Account("claude-a"); !ok {
		t.Error("claude account missing")
	}
	if p := s.Build().Providers["gemini"]; p != nil {
		t.Errorf("gemini in the snapshot: %+v", p)
	}
	logged := s.TakeLog()
	if len(logged) != 1 || logged[0].Provider != "gemini" || logged[0].Output != 5 {
		t.Errorf("gemini request not logged with its tokens: %+v", logged)
	}
}

func TestSwitchCommand(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true)
	cmd := Command{CommandID: "c1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}
	if ack := s.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("switch ack = %+v", ack)
	}
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" || got.Reason != switchedReason {
		t.Fatalf("switched pick = %+v", got)
	}
	if v := s.Build().Sessions["s1"]; !v.Switched {
		t.Fatalf("session view not marked switched: %+v", v)
	}
	for name, bad := range map[string]Command{
		"other boot":      {CommandID: "c2", Session: "s1", BootID: "boot-0", CreatedAt: c.t, Action: "unroute"},
		"too old":         {CommandID: "c3", Session: "s1", BootID: "boot-1", CreatedAt: c.t.Add(-time.Hour), Action: "unroute"},
		"unknown account": {CommandID: "c4", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "x"},
		"superseded":      {CommandID: "c5", Session: "s1", BootID: "boot-1", CreatedAt: c.t.Add(-time.Second), Action: "switch", AuthID: "claude-a"},
	} {
		if ack := s.Apply(bad); ack.Status != "rejected" || ack.Reason == "" {
			t.Fatalf("%s: ack = %+v", name, ack)
		}
	}
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("rejected commands changed the account: %s", got.AuthID)
	}
}

// A thread answered late on another account, sent before a later request the bound account served,
// does not move the binding: the later one says where the thread lives now.
func TestAnOlderThreadedSuccessDoesNotMoveAFresherBinding(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	sentToB := c.t.Add(time.Second)
	c.add(2 * time.Second)
	served(s, c, "claude:s1", "claude-a", true) // sent after the request to b, answered first
	s.Intercept(InterceptInput{Session: "s1", TraceID: "late", Format: "claude", Model: "claude-opus-5-5", Thread: "continue", Tools: 20})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "late", AuthID: "claude-b", RequestedAt: sentToB})
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("binding moved to %s by an older answer", got.AuthID)
	}
}

// A thread still answering on the old account after the user switched leaves their choice.
func TestALateSuccessDoesNotUndoASwitch(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	if ack := s.Apply(Command{CommandID: "c1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}); ack.Status != "applied" {
		t.Fatalf("switch ack = %+v", ack)
	}
	served(s, c, "claude:s1", "claude-a", true)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" || got.Reason != switchedReason {
		t.Fatalf("after a late success on the old account, pick = %+v", got)
	}
	// The late answer came from the old account, whose cache it wrote.
	if v := s.Build().Sessions["s1"]; v.ServedAuthID != "claude-a" {
		t.Fatalf("served account = %s, want the one that answered", v.ServedAuthID)
	}
}

// A model's own week read long ago says nothing of now: that model's readiness is unknown.
func TestAStaleModelWindowLeavesThatModelUnknown(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.MergeWindows("claude-a", "claude", []Window{{Kind: "7d_fable", Remaining: 0, ResetAt: c.t.Add(5 * 24 * time.Hour), ObservedAt: c.t.Add(-2 * time.Hour)}})
	s.MergeWindows("claude-b", "claude", []Window{{Kind: "7d_fable", Remaining: 0.5, ResetAt: c.t.Add(5 * 24 * time.Hour), ObservedAt: c.t}})
	if got := pick(s, "claude:s1", "claude-fable-5-1", both); got.AuthID != "claude-b" {
		t.Fatalf("fable pick = %+v, want claude-b: claude-a's Fable week was read two hours ago", got)
	}
}

// A route to another model of the session's own provider runs that model.
func TestARouteToAnotherModelOfTheSameProviderRunsIt(t *testing.T) {
	s, c := newTestState()
	served(s, c, "claude:s1", "claude-a", true)
	s.Apply(Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "claude", Model: "claude-sonnet-5-5"})
	d := s.Route(RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 1000, Available: []string{"claude"}, Turn: true})
	if !d.Handled || d.Provider != "claude" || d.Model != "claude-sonnet-5-5" {
		t.Fatalf("route to sonnet = %+v", d)
	}
	if d := s.Route(RouteInput{Session: "s1", RequestedModel: "claude-sonnet-5-5", BodyBytes: 1000, Available: []string{"claude"}, Turn: true}); d.Handled {
		t.Fatalf("a request already on the route's model was rerouted: %+v", d)
	}
	// One the router could not send there is stopped, not served by the original model unasked.
	if d := s.Intercept(InterceptInput{Session: "s1", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5"}); !d.Terminate {
		t.Fatalf("a request the route did not run went through: %+v", d)
	}
	if d := s.Intercept(InterceptInput{Session: "s1", Model: "claude-sonnet-5-5", RequestedModel: "claude-opus-5-5"}); d.Terminate {
		t.Fatalf("a request the route ran was stopped: %+v", d)
	}
}

// An account switch goes by where the next turn goes, not where the last one ran.
func TestASwitchFollowsWhereTheNextTurnGoes(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", AuthID: "codex-a", RequestedAt: c.t})
	s.Route(RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 1000, Available: []string{"claude", "codex"}, Turn: true})
	if ack := s.Apply(Command{CommandID: "c1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}); ack.Status != "applied" {
		t.Fatalf("switch back on Claude after a Codex reply = %+v", ack)
	}
	// The next turn asks for Sonnet after an Opus reply: an account out of Sonnet quota is refused.
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-a", RequestedAt: c.t})
	s.Route(RouteInput{Session: "s2", RequestedModel: "claude-sonnet-5-5", BodyBytes: 1000, Available: []string{"claude"}, Turn: true})
	s.MergeWindows("claude-b", "claude", []Window{{Kind: "7d_sonnet", Remaining: 0, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
	if ack := s.Apply(Command{CommandID: "c2", Session: "s2", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}); ack.Status != "rejected" {
		t.Fatalf("switch to an account out of the next model's quota = %+v", ack)
	}
}

func TestSwitchRejectsBlockedAccount(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0, 24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	ack := s.Apply(Command{CommandID: "p1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
	if ack.Status != "rejected" {
		t.Fatalf("switch to a used-up account = %+v", ack)
	}
}

func TestObserveIgnoresLateRecordsAndLateQuota(t *testing.T) {
	s, c := newTestState()
	t0 := c.t
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: t0, CacheRead: 100, Input: 10})
	c.add(time.Minute)
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "1")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1791590400")
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, CacheCreation: 500, ResponseHeader: h})
	// A long stream that started earlier reports last, with the quota it saw back then.
	old := http.Header{}
	old.Set("anthropic-ratelimit-unified-7d-utilization", "0.2")
	old.Set("anthropic-ratelimit-unified-7d-reset", "1791590400")
	c.add(time.Minute)
	s.Observe(Usage{Provider: "claude", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: t0.Add(time.Second), ResponseHeader: old})
	if w := s.creds["claude-a"].Windows[KindWeekly]; w.Remaining != 0 {
		t.Fatalf("late record overwrote newer quota: %+v", w)
	}
	// Nor is it a fall that settles once five minutes have passed: it was read before the 100%.
	c.add(6 * time.Minute)
	if rem, _, _, _ := s.effective(s.creds["claude-a"], KindWeekly, c.t); rem != 0 {
		t.Fatalf("late record started the window over: remaining %v", rem)
	}
	v := s.Build().Sessions["s1"]
	if v.Totals.CacheRead != 100 || v.Totals.CacheCreation != 500 || v.Last.CacheCreation != 500 {
		t.Fatalf("session tokens = %+v / %+v", v.Totals, v.Last)
	}
}

func TestClaudeHeaders(t *testing.T) {
	now := time.Unix(1791000000, 0)
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.13")
	h.Set("anthropic-ratelimit-unified-5h-reset", "1791076200")
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.33")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1791590400")
	h.Set("anthropic-ratelimit-unified-7d-status", "allowed")
	h.Set("anthropic-ratelimit-unified-reset", "1791076200")
	got := map[string]Window{}
	for _, w := range WindowsFromHeaders("claude", h, now) {
		got[w.Kind] = w
	}
	if len(got) != 2 || got["5h"].Remaining != 0.87 || got["7d"].ResetAt.Unix() != 1791590400 {
		t.Fatalf("claude windows = %+v", got)
	}
	h.Set("anthropic-ratelimit-unified-5h-status", "rejected")
	for _, w := range WindowsFromHeaders("claude", h, now) {
		if w.Kind == "5h" && w.Remaining != 0 {
			t.Fatalf("rejected window remaining = %v", w.Remaining)
		}
	}
}

func TestCodexHeadersAndBodies(t *testing.T) {
	now := time.Unix(1791000000, 0)
	h := http.Header{}
	h.Set("x-codex-primary-used-percent", "6")
	h.Set("x-codex-primary-window-minutes", "10080")
	h.Set("x-codex-primary-reset-at", "1791590554")
	h.Set("x-codex-secondary-window-minutes", "0")
	ws := WindowsFromHeaders("codex", h, now)
	if len(ws) != 1 || ws[0].Kind != "7d" || ws[0].Remaining != 0.94 {
		t.Fatalf("codex header windows = %+v", ws)
	}
	body := []byte(`{"rate_limit":{"primary_window":{"used_percent":20,"limit_window_seconds":18000,"reset_at":1791010000},"secondary_window":null}}`)
	ws, full := WindowsFromUsageBody("codex", body, now)
	if !full || len(ws) != 1 || ws[0].Kind != "5h" || ws[0].Remaining != 0.8 {
		t.Fatalf("codex body windows = %+v", ws)
	}
	claude := []byte(`{"five_hour":{"utilization":14,"resets_at":"2026-10-04T01:10:00.49+00:00"},"seven_day":{"utilization":33,"resets_at":"2026-10-10T00:00:00+00:00"},"iguana_necktie":{"utilization":null},"extra_usage":{"utilization":null}}`)
	if ws, full = WindowsFromUsageBody("claude", claude, now); !full || len(ws) != 2 {
		t.Fatalf("claude body windows = %+v", ws)
	}
	if _, full = WindowsFromUsageBody("codex", []byte(`{"error":"x"}`), now); full {
		t.Fatal("an answer without rate limits read as a full reading")
	}
	// A Claude answer that names no window says nothing of them; one naming a window as null does.
	for _, body := range []string{`null`, `{}`, `{"error":"temporarily unavailable"}`} {
		if _, full = WindowsFromUsageBody("claude", []byte(body), now); full {
			t.Fatalf("%s read as a full reading", body)
		}
	}
	if ws, full = WindowsFromUsageBody("claude", []byte(`{"five_hour":null,"seven_day":{"utilization":10}}`), now); !full || len(ws) != 1 {
		t.Fatalf("a reading without a 5-hour window = %+v %v", ws, full)
	}
	// A WebSocket quota event says only how long is left.
	h = http.Header{}
	h.Set("x-codex-primary-window-minutes", "10080")
	h.Set("x-codex-primary-used-percent", "42")
	h.Set("x-codex-primary-reset-after-seconds", "3600")
	if ws = WindowsFromHeaders("codex", h, now); len(ws) != 1 || !ws[0].ResetAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("relative reset = %+v", ws)
	}
}

var inventory = []CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}, {ID: "codex-a", Provider: "codex"}}

func TestHealth(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0, 24*time.Hour)
	if got := s.Health("claude", "m"); got != "unknown" {
		t.Fatalf("health before the inventory loaded = %s", got)
	}
	s.UpdateInventory(inventory)
	if got := s.Health("claude", "m"); got != "exhausted" {
		t.Fatalf("all blocked health = %s", got)
	}
	setQuota(s, c, "claude-b", 0.05, 0.5, 25*time.Hour) // its next week
	if got := s.Health("claude", "m"); got != "healthy" {
		t.Fatalf("low but serving health = %s", got)
	}
	c.add(3 * time.Hour)
	if got := s.Health("claude", "m"); got != "unknown" {
		t.Fatalf("stale health = %s", got)
	}
}

func TestSnapshotFlagsImminentSwitch(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory[:2])
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	// Running low is no switch: the session keeps its account until it cannot serve.
	setQuota(s, c, "claude-a", 0.04, 0.5, 24*time.Hour)
	if v := s.Build().Sessions["s1"]; v.SwitchImminent {
		t.Fatalf("a low account flagged a switch: %+v", v)
	}
	setQuota(s, c, "claude-a", 0, 0.5, 24*time.Hour)
	snap := s.Build()
	v := snap.Sessions["s1"]
	if !v.SwitchImminent || v.NextAuthID != "claude-b" || snap.Providers["claude"].Credentials[1].BackAt.IsZero() {
		t.Fatalf("session view = %+v", v)
	}
	if snap.Sequence != 2 || s.Build().Sequence != 3 {
		t.Fatalf("sequence does not advance")
	}
	if order := snap.Providers["claude"].Credentials; order[0].ID != "claude-b" || order[0].Order != 1 || order[1].Sessions != 1 {
		t.Fatalf("routing order = %+v %+v", order[0], order[1])
	}
	if acks := snap.Acks; acks == nil {
		t.Fatalf("acks must be an empty list, not null")
	}
}

func TestUnknownProviderIsLeftOut(t *testing.T) {
	s, _ := newTestState()
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "stray", Provider: "unknown"}})
	if _, ok := s.Build().Providers["unknown"]; ok {
		t.Fatalf("an unknown provider reached the snapshot")
	}
}

func TestMaskEmail(t *testing.T) {
	if got := MaskEmail("dana@example.com"); got != "d•••" {
		t.Fatalf("MaskEmail = %q", got)
	}
}

func TestRouteOverrideAndAuto(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	avail := []string{"claude", "codex"}
	setQuota(s, c, "claude-a", 0, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0, 24*time.Hour)
	in := RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 30000, Available: avail, Turn: true}
	if d := s.Route(in); d.Handled {
		t.Fatalf("cross_provider off routed: %+v", d)
	}
	s.SetConfig(Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude": "codex:gpt-6-sol"}})
	if d := s.Route(in); !d.Handled || d.Provider != "codex" || d.Model != "gpt-6-sol" {
		t.Fatalf("auto route = %+v", d)
	}
	// The route sticks after Claude recovers, until the user ends it.
	setQuota(s, c, "claude-b", 0.9, 0.5, 25*time.Hour)
	if d := s.Route(in); !d.Handled {
		t.Fatalf("route dropped mid-session: %+v", d)
	}
	// The routed turn is answered, so the session is its key's to command.
	s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", AuthID: "codex-a", RequestedAt: c.t})
	cmd := Command{CommandID: "u1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "unroute"}
	if ack := s.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("unroute ack = %+v", ack)
	}
	if d := s.Route(in); d.Handled {
		t.Fatalf("route still active after unroute: %+v", d)
	}
}

func TestAutoRouteNeedsExhaustedAndFit(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	s.SetConfig(Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude": "codex:gpt-6-sol"}})
	in := RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 30000, Available: []string{"claude", "codex"}, Turn: true}
	setQuota(s, c, "claude-a", 0, 0.5, 24*time.Hour) // claude-b unknown
	if d := s.Route(in); d.Handled {
		t.Fatalf("unknown health routed: %+v", d)
	}
	setQuota(s, c, "claude-b", 0, 0.5, 24*time.Hour)
	big := in
	big.BodyBytes = 3 * 300000
	if d := s.Route(big); d.Handled {
		t.Fatalf("over-long request routed: %+v", d)
	}
	if v := s.Build().Sessions["s1"]; v.RouteNote == "" {
		t.Fatalf("no handoff note for over-long request")
	}
	if d := s.Route(in); !d.Handled {
		t.Fatalf("fitting request not routed: %+v", d)
	}
}

func TestRoutedSessionDropsThreadsAndNeverFallsBack(t *testing.T) {
	s, c := newTestState()
	served(s, c, "claude:s1", "claude-a", true)
	cmd := Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "gpt-6-sol"}
	if ack := s.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("route ack = %+v", ack)
	}
	avail := []string{"claude", "codex"}
	if d := s.Route(RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 1000, Available: avail, Turn: true}); !d.Handled || d.Model != "gpt-6-sol" {
		t.Fatalf("override route = %+v", d)
	}
	// A thread continuation would reach Codex without its history: Claude Code must resend it whole.
	d := s.Intercept(InterceptInput{Session: "s1", Model: "gpt-6-sol", RequestedModel: "claude-opus-5-5", Thread: "continue"})
	if !d.Terminate || d.ErrorCode != threadUnsupported {
		t.Fatalf("thread on a routed session = %+v", d)
	}
	if d := s.Intercept(InterceptInput{Session: "s1", Model: "gpt-6-sol", RequestedModel: "claude-opus-5-5"}); d.Terminate {
		t.Fatalf("stateless routed request stopped: %+v", d)
	}
	// The route cannot run (Codex has no account): stop instead of serving it from Claude.
	if d := s.Route(RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 1000, Available: []string{"claude"}, Turn: true}); d.Handled {
		t.Fatalf("route without a codex account handled: %+v", d)
	}
	d = s.Intercept(InterceptInput{Session: "s1", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5"})
	if !d.Terminate || !strings.Contains(d.Message, "no account") {
		t.Fatalf("fallback to the original provider not stopped: %+v", d)
	}
	if d := s.Intercept(InterceptInput{Session: "s2", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5", Thread: "continue"}); d.Terminate {
		t.Fatalf("an unrouted session was stopped: %+v", d)
	}
}

// The band and a Codex hook read with a client key the proxy accepted for a request in the last week:
// the key itself is never kept, only its hash, and it lasts across a restart.
func TestAClientKeyTheProxyAcceptedReadsTheQuota(t *testing.T) {
	s, c := newTestState()
	known := func(st *State, key string) bool { _, ok := st.Client(key); return ok }
	if known(s, "sk-device") {
		t.Fatal("a key no request used was accepted")
	}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-device"})
	if !known(s, "sk-device") || known(s, "sk-other") || known(s, "") {
		t.Fatal("the accepted key was not told apart")
	}
	saved := s.Export()
	if raw, _ := json.Marshal(saved); strings.Contains(string(raw), "sk-device") {
		t.Fatalf("the key itself was kept: %s", raw)
	}
	r, rc := newTestState()
	r.Import(saved)
	if !known(r, "sk-device") {
		t.Fatal("the key was forgotten across a restart")
	}
	rc.add(clientTTL + time.Minute)
	if known(r, "sk-device") {
		t.Fatal("a key unused for over a week was still accepted")
	}
}

// A proxy without api-keys lets any client in, and so any band; once it asks for keys, only theirs.
func TestAProxyWithoutKeysLetsEveryBandIn(t *testing.T) {
	s, c := newTestState()
	// A model call of the host's own, with neither a key nor a session, says nothing of clients.
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", AuthID: "claude-a", RequestedAt: c.t})
	if _, ok := s.Client("sk-any"); ok {
		t.Fatal("a request with no session opened the band")
	}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t})
	if id, ok := s.Client("sk-any"); !ok || id != "" {
		t.Fatalf("a keyless proxy's band = %q, %v", id, ok)
	}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-device"})
	if _, ok := s.Client("sk-any"); ok {
		t.Fatal("a proxy that asks for keys now still let any key in")
	}
	// A stream sent before the proxy asked for keys, answered late, does not open it again, though
	// the plugin was loaded anew meanwhile: the key's own time moves on only hourly.
	c.add(10 * time.Minute)
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-device"})
	r, rc := newTestState()
	rc.t = c.t
	r.Import(s.Export())
	for _, st := range []*State{s, r} {
		st.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t.Add(-time.Minute)})
		if _, ok := st.Client("sk-any"); ok {
			t.Fatal("a late keyless answer let any key in again")
		}
	}
	// The watermark is when that keyed request was sent, not when it was answered: a keyless
	// request sent after it, once the proxy asks for no keys again, opens it, across a reload too;
	// and then every key is the keyless client, one it accepted before included.
	sent := c.t
	c.add(20 * time.Minute)
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-a", RequestedAt: sent, ClientKey: "sk-device"})
	r, rc = newTestState()
	rc.t = c.t
	r.Import(s.Export())
	r.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s3", AuthID: "claude-a", RequestedAt: sent.Add(10 * time.Minute)})
	if id, ok := r.Client("sk-device"); !ok || id != "" {
		t.Fatalf("an accepted key on a proxy open again = %q, %v", id, ok)
	}
	if _, ok := s.Client("sk-device"); !ok {
		t.Fatal("the key it accepted was refused")
	}
}

// A band commands only a session that runs on its own key, even knowing another's id.
func TestABandCommandsOnlyASessionOfItsOwnKey(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	// Another key's request under its id that fails before its own first answer takes nothing.
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-dana", Failed: true})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-alex"})
	if s.BuildForBand("s1", "", clientID("sk-dana")).Sessions["s1"] != nil || s.BuildForBand("s1", "", clientID("sk-alex")).Sessions["s1"] == nil {
		t.Fatal("a band saw another key's session, or not its own")
	}
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-dana"})
	other := clientID("sk-dana")
	cmd := Command{CommandID: "c1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b", Client: other}
	if ack := s.Apply(cmd); ack.Status != "rejected" {
		t.Fatalf("another key's switch = %+v", ack)
	}
	cmd.CommandID, cmd.Client = "c2", clientID("sk-alex")
	if ack := s.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("its own key's switch = %+v", ack)
	}
	// A request of another key under its id does not take it over.
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-dana", Failed: true})
	cmd.CommandID, cmd.Client = "c3", other
	if ack := s.Apply(cmd); ack.Status != "rejected" {
		t.Fatalf("another key's switch after its request = %+v", ack)
	}
	// Its owner stays as long as the account it chose: past a day idle, and across a restart.
	c.add(3 * 24 * time.Hour)
	s.Sweep()
	r, rc := newTestState()
	rc.t = c.t
	r.Import(s.Export())
	cmd.CommandID, cmd.Action, cmd.CreatedAt = "c4", "unroute", c.t
	if ack := r.Apply(cmd); ack.Status != "rejected" {
		t.Fatalf("another key's command after a pause and a restart = %+v", ack)
	}
	cmd.CommandID, cmd.Client = "c5", clientID("sk-alex")
	if ack := r.Apply(cmd); ack.Status != "applied" {
		t.Fatalf("its own key's command after a pause = %+v", ack)
	}
	// A session the proxy has not seen is no one's to command.
	cmd.CommandID, cmd.Session = "c6", "s-unseen"
	if ack := r.Apply(cmd); ack.Status != "rejected" {
		t.Fatalf("a command for an unseen session = %+v", ack)
	}
}

func TestBandSnapshotHasNoEmailsOrPaths(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory([]CredInfo{{ID: "claude-dana@example.com.json", Provider: "claude", Email: "dana@example.com"}, {ID: "claude-alex@example.com.json", Provider: "claude", Email: "alex@example.com"}})
	setQuota(s, c, "claude-dana@example.com.json", 0, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-alex@example.com.json", 0.9, 0.5, 48*time.Hour)
	served(s, c, "claude:s1", "claude-dana@example.com.json", true)
	s.NoteError("open /Users/dana/.cli-proxy-api/claude-dana@example.com.json: permission denied")
	served(s, c, "claude:s2", "claude-alex@example.com.json", true)
	band := s.BuildForBand("s1", "", "")
	raw, _ := json.Marshal(band)
	if strings.Contains(string(raw), "@") || strings.Contains(string(raw), "/Users/") {
		t.Fatalf("band snapshot leaks: %s", raw)
	}
	// The band reads acknowledgements as a list: none is an empty one.
	if !strings.Contains(string(raw), `"acks":[]`) {
		t.Fatalf("band snapshot acks: %s", raw)
	}
	// A band sees its own session, not the others the proxy serves.
	if _, other := band.Sessions["s2"]; other || len(band.Sessions) != 1 {
		t.Fatalf("band snapshot sessions = %v", band.Sessions)
	}
	v := band.Sessions["s1"]
	if v.AuthID == "" || v.AuthID != band.Providers["claude"].Credentials[1].ID || v.NextAuthID != band.Providers["claude"].Credentials[0].ID {
		t.Fatalf("opaque ids do not line up: session %+v", v)
	}
	if s.Build().Providers["claude"].Credentials[0].Label != "a•••" {
		t.Fatalf("label not masked")
	}
}

func TestBindingsRoutesAndSessionsSurviveARestart(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 4*24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	served(s, c, "claude:s2", "claude-a", true)
	s.Apply(Command{CommandID: "r", Session: "s2", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "gpt-6-sol"})
	raw, _ := json.Marshal(s.Export())
	c.add(2 * time.Hour)
	next := New("boot-2", c.now)
	var p Persisted
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	next.Import(p)
	// The band reads the session's account at once, before the session's next reply.
	if v, ok := next.Build().Sessions["s1"]; !ok || v.AuthID != "claude-a" || v.Model != "claude-opus-5-5" {
		t.Fatalf("session after a restart = %+v", v)
	}
	setQuota(next, c, "claude-a", 0.9, 0.5, 4*24*time.Hour)
	setQuota(next, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	if got := pick(next, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("after a restart the session moved to %s", got.AuthID)
	}
	if d := next.Route(RouteInput{Session: "s2", RequestedModel: "claude-opus-5-5", BodyBytes: 100, Available: []string{"claude", "codex"}}); !d.Handled {
		t.Fatalf("route lost in the restart")
	}
}

// The quota last read survives a restart, with when it was read: until the next reading routing
// still keeps new sessions off a used-up account, and the report and the band still know the
// window; read long ago, it is stale like any old reading.
func TestQuotaReadingsSurviveARestart(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Email: "ann@example.com"}, {ID: "claude-b", Provider: "claude"}})
	s.SetPlan("claude-a", "claude", "Max 20x")
	s.MergeWindows("claude-a", "claude", []Window{
		{Kind: KindFiveHour, Remaining: 0.9, ResetAt: c.t.Add(3 * time.Hour), ObservedAt: c.t},
		{Kind: KindWeekly, Remaining: 0, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t},
	})
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	raw, _ := json.Marshal(s.Export())
	restart := func(after time.Duration) *State {
		c.add(after)
		next := New("boot-2", c.now)
		var p Persisted
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		next.Import(p)
		return next
	}

	next := restart(2 * time.Minute)
	if got := pick(next, "claude:new", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("a new session right after a restart went to %s", got.AuthID)
	}
	info, ok := next.Account("claude-a")
	if !ok || !info.ResetAt.Equal(c.t.Add(-2*time.Minute+24*time.Hour)) || info.Plan != "Max 20x" || info.Label != "a•••" {
		t.Fatalf("account after a restart = %+v", info)
	}

	// Read three hours before: kept, but stale, so it no longer blocks.
	later := restart(3 * time.Hour)
	if r := later.classifyLocked(later.creds["claude-a"], "m", c.t); r.Blocked {
		t.Fatalf("an old reading still blocks: %+v", r)
	}
	if info, _ := later.Account("claude-a"); info.ResetAt.IsZero() {
		t.Fatalf("the weekly window was forgotten")
	}
}

func TestFallbackPickIsDeterministic(t *testing.T) {
	if got := FallbackPick([]Candidate{credB, credA}); got != "claude-a" {
		t.Fatalf("FallbackPick = %s", got)
	}
	if got := FallbackPick(nil); got != "" {
		t.Fatalf("FallbackPick(nil) = %q", got)
	}
}

func TestPlans(t *testing.T) {
	for body, want := range map[string]string{
		`{"account":{"has_claude_max":true,"has_claude_pro":false},"organization":{"rate_limit_tier":"default_claude_max_20x"}}`: "Max 20x",
		`{"account":{"has_claude_max":true},"organization":{}}`:                                                                  "Max",
		`{"account":{"has_claude_max":false,"has_claude_pro":true}}`:                                                             "Pro",
		`{"account":{"has_claude_max":false,"has_claude_pro":false}}`:                                                            "Free",
		`{"account":{"has_claude_max":true},"organization":{"organization_type":"claude_team","subscription_status":"active"}}`:  "Team",
		`{}`: "",
	} {
		if got := ClaudePlan([]byte(body)); got != want {
			t.Fatalf("ClaudePlan(%s) = %q, want %q", body, got, want)
		}
	}
	if got := CodexPlan([]byte(`{"plan_type":"pro","rate_limit":{}}`)); got != "Pro 200" {
		t.Fatalf("CodexPlan pro = %q", got)
	}
	if got := CodexPlan([]byte(`{"plan_type":"plus"}`)); got != "Plus" {
		t.Fatalf("CodexPlan plus = %q", got)
	}
	s, _ := newTestState()
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}})
	s.SetPlan("claude-a", "claude", "Max 20x")
	if got := s.BuildForBand("", "", "").Providers["claude"].Credentials[0].Plan; got != "Max 20x" {
		t.Fatalf("snapshot plan = %q", got)
	}
}

func TestASideRequestLeavesTheSessionModel(t *testing.T) {
	s, c := newTestState()
	turn := func(trace, model string, tools int) {
		s.Intercept(InterceptInput{Session: "s1", TraceID: trace, Format: "claude", Model: model, RequestedModel: model, Tools: tools})
		s.Observe(Usage{Provider: "claude", Model: model, SessionID: "claude:s1", TraceID: trace, AuthID: "claude-a", RequestedAt: c.t, Output: 9})
		c.t = c.t.Add(time.Second)
	}
	turn("t1", "claude-opus-5-5", 19)
	turn("t2", "claude-sonnet-5", 0) // Claude Code's permission check, between two turns
	view := s.Build().Sessions["s1"]
	if view.Model != "claude-opus-5-5" {
		t.Fatalf("session model = %q, want the conversation's", view.Model)
	}
	if log := s.TakeLog(); len(log) != 2 || log[1].Model != "claude-sonnet-5" {
		t.Fatalf("the side request still counts as usage: %+v", log)
	}
}

// Use that falls back without a new period (a plan change) is taken, and marked so the plan is read
// again; a step back is a trailing reading.
func TestAWindowThatStartsOverIsMarked(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.74, 24*time.Hour)
	c.t = c.t.Add(time.Minute)
	setQuota(s, c, "claude-a", 0.9, 0.73, 24*time.Hour)
	if !s.StartedOver("claude-a").IsZero() {
		t.Fatal("a step back marked a start over")
	}
	c.t = c.t.Add(time.Minute)
	setQuota(s, c, "claude-a", 0.9, 1, 24*time.Hour)
	fell := c.t
	if info, _ := s.Account("claude-a"); !s.StartedOver("claude-a").IsZero() {
		t.Fatalf("a fall taken before it settled: %+v", info)
	}
	c.t = c.t.Add(6 * time.Minute)
	info, _ := s.Account("claude-a")
	if s.StartedOver("claude-a") != fell || info.ResetAt != fell.Add(24*time.Hour) {
		t.Fatalf("started over %v reset %v", s.StartedOver("claude-a"), info.ResetAt)
	}
	if v := s.Build().Providers["claude"].Credentials[0]; v.Windows[1].Remaining != 1 {
		t.Fatalf("weekly window = %+v", v.Windows)
	}
}

func TestAReadingThatTrailsByAStepKeepsTheHigherUse(t *testing.T) {
	s, c := newTestState()
	reset := c.t.Add(3 * 24 * time.Hour)
	read := func(remaining float64, resetAt time.Time, source string) {
		s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: remaining, ResetAt: resetAt, ObservedAt: c.t, Source: source}})
		c.add(time.Second)
	}
	read(0.02, reset, "poll")
	read(0.03, reset.Add(-time.Second), "header") // the header lags the poll by a step
	if got := s.Build().Providers["claude"].Credentials[0].Windows[0].Remaining; !near(got, 0.02) {
		t.Fatalf("remaining = %v, want the poll's 0.02", got)
	}
	read(0.97, reset.Add(7*24*time.Hour), "poll") // a new period starts over
	if got := s.Build().Providers["claude"].Credentials[0].Windows[0].Remaining; !near(got, 0.97) {
		t.Fatalf("remaining after the reset = %v", got)
	}
}

func TestARefusedRequestStillLogsItsReading(t *testing.T) {
	s, c := newTestState()
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "1.0")
	h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprint(c.t.Add(24*time.Hour).Unix()))
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Failed: true, ResponseHeader: h})
	log := s.TakeLog()
	if len(log) != 1 || !log[0].Poll || log[0].Used7d == nil || !near(*log[0].Used7d, 1) || log[0].Output != 0 {
		t.Fatalf("log = %+v", log)
	}
	// The 5-hour window's reading and reset are logged too.
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.25")
	h.Set("anthropic-ratelimit-unified-5h-reset", fmt.Sprint(c.t.Add(3*time.Hour).Unix()))
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Output: 10, ResponseHeader: h})
	log = s.TakeLog()
	if len(log) != 1 || log[0].Used5h == nil || !near(*log[0].Used5h, 0.25) || log[0].Reset5 != c.t.Add(3*time.Hour).UnixMilli() {
		t.Fatalf("log = %+v", log)
	}
	// So are the service tier the request asked for and the one the provider reported.
	s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", AuthID: "codex-a", RequestedAt: c.t, Output: 10, TierAsked: "priority", TierServed: "default"})
	if log = s.TakeLog(); len(log) != 1 || log[0].TierAsked != "priority" || log[0].TierServed != "default" {
		t.Fatalf("log = %+v", log)
	}
}

func TestTheViewShowsWhereTheNextTurnGoes(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory[:2])
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	if ack := s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"}); ack.Status != "applied" {
		t.Fatalf("switch ack = %+v", ack)
	}
	v := s.Build().Sessions["s1"]
	if v.AuthID != "claude-b" || v.ServedAuthID != "claude-a" || !v.Switched {
		t.Fatalf("after a switch, before the next reply: %+v", v)
	}
	if order := s.Build().Providers["claude"].Credentials; order[0].Sessions+order[1].Sessions != 1 {
		t.Fatalf("the session counts once: %+v %+v", order[0], order[1])
	}
	s.Apply(Command{CommandID: "r1", Session: "s1", BootID: "boot-1", CreatedAt: c.t.Add(time.Second), Action: "route", Provider: "codex", Model: "gpt-6-sol"})
	if v := s.Build().Sessions["s1"]; v.Provider != "codex" || v.Model != "gpt-6-sol" || v.AuthID != "" {
		t.Fatalf("routed, before the first routed reply: %+v", v)
	}
}

func TestASideRequestDoesNotMoveTheConversation(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	// claude-a stops being offered; the permission check runs on claude-b.
	if got := pick(s, "claude:s1", "claude-sonnet-5", []Candidate{credB}); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v", got)
	}
	s.Intercept(InterceptInput{Session: "s1", TraceID: "side", Format: "claude", Model: "claude-sonnet-5", RequestedModel: "claude-sonnet-5"})
	s.Observe(Usage{Provider: "claude", Model: "claude-sonnet-5", SessionID: "claude:s1", TraceID: "side", AuthID: "claude-b", RequestedAt: c.t})
	if v := s.Build().Sessions["s1"]; v.AuthID != "claude-a" {
		t.Fatalf("a side request moved the conversation to %s", v.AuthID)
	}
	// The next turn lands elsewhere and takes the binding with it.
	pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB})
	served(s, c, "claude:s1", "claude-b", false)
	if v := s.Build().Sessions["s1"]; v.AuthID != "claude-b" {
		t.Fatalf("the turn did not move the conversation: %s", v.AuthID)
	}
}

func TestRouteNotesClearOnceTheReasonIsGone(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	s.SetConfig(Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude": "codex:gpt-6-sol"}})
	setQuota(s, c, "claude-a", 0, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0, 0.5, 24*time.Hour)
	long := RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 3 * 300000, Available: []string{"claude", "codex"}, Turn: true}
	s.Route(long)
	if s.Build().Sessions["s1"].RouteNote == "" {
		t.Fatalf("no note for a conversation too long to route")
	}
	side := long
	side.Turn, side.BodyBytes = false, 100
	s.Route(side) // a side request says nothing about the conversation
	if s.Build().Sessions["s1"].RouteNote == "" {
		t.Fatalf("a side request cleared the note")
	}
	setQuota(s, c, "claude-b", 0.9, 0.5, 25*time.Hour)
	c.add(6 * time.Minute) // its 5-hour window's fall settles
	s.Route(long)
	if note := s.Build().Sessions["s1"].RouteNote; note != "" {
		t.Fatalf("note kept after Claude recovered: %q", note)
	}
}

func TestAPassedFiveHourResetIsNotInvented(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.2, 0.5, 24*time.Hour)
	c.add(6 * time.Hour)
	for _, w := range s.Build().Providers["claude"].Credentials[0].Windows {
		if w.Kind == KindFiveHour && (!w.ResetAt.IsZero() || w.Remaining != 1) {
			t.Fatalf("5-hour window after its reset: %+v", w)
		}
	}
}

func TestContentNamedSessionsStayOutOfTheSnapshot(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	served(s, c, "lcp:v1:abc", "claude-a", false)
	snap := s.Build()
	if len(snap.Sessions) != 0 || snap.Providers["claude"].Credentials[0].Sessions != 0 {
		t.Fatalf("snapshot = %+v", snap.Sessions)
	}
}

func TestNextWeeklyResetRollsOnByWholeWeeks(t *testing.T) {
	reset := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	week := 7 * 24 * time.Hour
	for _, c := range []struct {
		now  time.Time
		want time.Time
	}{
		{reset.Add(-time.Hour), reset},
		{reset, reset.Add(week)},
		{reset.Add(week + time.Hour), reset.Add(2 * week)},
	} {
		if got := NextWeeklyReset(reset, c.now); !got.Equal(c.want) {
			t.Errorf("at %v: %v, want %v", c.now, got, c.want)
		}
	}
}

// A Codex conversation lives on the account that answers it, so a child thread that ran elsewhere
// while its parent's account was not offered keeps its own account, and the parent keeps its own.
func TestACodexChildThreadKeepsItsOwnAccount(t *testing.T) {
	s, c := newTestState()
	a, b := Candidate{ID: "codex-a", Provider: "codex"}, Candidate{ID: "codex-b", Provider: "codex"}
	for id, reset := range map[string]time.Duration{"codex-a": 24 * time.Hour, "codex-b": 4 * 24 * time.Hour} {
		s.MergeWindows(id, "codex", []Window{{Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(reset), ObservedAt: c.t}})
	}
	pickCodex := func(canonical, parent string, cands ...Candidate) string {
		return s.Pick(PickInput{Provider: "codex", Model: "gpt-6.1-sol", Canonical: canonical, Parent: parent, Candidates: cands}).AuthID
	}
	run := func(canonical, parent, authID, trace string) {
		s.Intercept(InterceptInput{TraceID: trace, Format: "openai-response", Model: "gpt-6.1-sol", RequestedModel: "gpt-6.1-sol", Tier: "priority"})
		s.Observe(Usage{Provider: "codex", Model: "gpt-6.1-sol", SessionID: canonical, ParentID: parent, TraceID: trace, AuthID: authID, RequestedAt: c.t, Output: 10})
	}
	if got := pickCodex("codex:P", "", a, b); got != "codex-a" {
		t.Fatalf("parent pick = %s", got)
	}
	run("codex:P", "", "codex-a", "t1")
	if got := pickCodex("codex:C", "codex:P", b); got != "codex-b" {
		t.Fatalf("child pick while A is not offered = %s", got)
	}
	run("codex:C", "codex:P", "codex-b", "t2")
	if child, parent := pickCodex("codex:C", "codex:P", a, b), pickCodex("codex:P", "", a, b); child != "codex-b" || parent != "codex-a" {
		t.Fatalf("child %s, parent %s: want codex-b and codex-a", child, parent)
	}
}

// A request's log line says what the client asked for, as Intercept read it (Claude's fast mode is
// not a service tier the host reads), and whether it came from another device.
func TestAUsageLineCarriesWhatTheRequestAsked(t *testing.T) {
	s, c := newTestState()
	s.Intercept(InterceptInput{Session: "s1", TraceID: "fast", Format: "claude", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5", Tools: 3, Tier: "fast", Remote: true})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "fast", AuthID: "claude-a", RequestedAt: c.t, Output: 10, TierAsked: "auto"})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "unseen", AuthID: "claude-a", RequestedAt: c.t, Output: 10, TierAsked: "auto"})
	log := s.TakeLog()
	if len(log) != 2 || log[0].TierAsked != "fast" || !log[0].Remote || log[1].TierAsked != "auto" || log[1].Remote {
		t.Fatalf("log = %+v", log)
	}
}

// Only Claude Code sends requests beside its conversation, and they offer no tools; a turn that
// continues a message thread inherits its tools and is a turn all the same. Codex has no side
// requests.
func TestOnlyAClaudeRequestWithoutToolsOrThreadIsASideRequest(t *testing.T) {
	s, c := newTestState()
	turn := func(trace, format string, tools int, thread string) bool {
		c.t = c.t.Add(time.Second)
		s.Intercept(InterceptInput{Session: "s1", TraceID: trace, Format: format, Model: "m-" + trace, RequestedModel: "claude-opus-5-5", Tools: tools, Thread: thread})
		provider := "claude"
		if format != "claude" {
			provider = "codex"
		}
		s.Observe(Usage{Provider: provider, Model: "m-" + trace, SessionID: "claude:s1", TraceID: trace, AuthID: "claude-a", RequestedAt: c.t, Output: 10})
		return s.sessions["claude:s1"].Model == "m-"+trace
	}
	switch {
	case !turn("tools", "claude", 3, ""):
		t.Fatal("a turn with tools")
	case turn("side", "claude", 0, ""):
		t.Fatal("a side request moved the session")
	case !turn("continue", "claude", 0, "continue"):
		t.Fatal("a thread continuation without tools")
	case !turn("codex", "openai-response", 0, ""):
		t.Fatal("a Codex request without tools")
	}
}

// A request beside the conversation on another model, which the bound account can still serve,
// does not undo the move of the conversation's own model; and a request sent before a binding was
// set cannot take it back when it answers late.
func TestABindingMovesByModelAndByWhenTheRequestWasSent(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", pick(s, "claude:s1", "claude-opus-5-5", both).AuthID, true)
	if got := pick(s, "claude:s1", "claude-opus-5-5", []Candidate{credB}); got.AuthID != "claude-b" {
		t.Fatalf("pick while claude-a cannot serve Opus = %+v", got)
	}
	if got := pick(s, "claude:s1", "claude-haiku-4-5", both); got.AuthID != "claude-a" {
		t.Fatalf("Haiku pick = %+v", got)
	}
	sent := c.t
	c.t = c.t.Add(time.Minute)
	served(s, c, "claude:s1", "claude-b", false)
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("the Opus success elsewhere did not move the session: %+v", got)
	}
	// claude-a answers a threaded request sent before the move.
	s.Intercept(InterceptInput{Session: "s1", TraceID: "late", Format: "claude", Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5", Thread: "continue", Tools: 20})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", TraceID: "late", AuthID: "claude-a", RequestedAt: sent})
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" {
		t.Fatalf("a late answer took the session back: %+v", got)
	}
}

// The live state follows the window rules (window.go): a high reading of the old window read just
// after a start-over is passed over, a lower one read late is too, a reading naming an earlier reset
// is, and a full reading drops a window the account no longer has.
func TestTheLiveStateFollowsTheWindowRules(t *testing.T) {
	s, c := newTestState()
	reset := c.t.Add(24 * time.Hour)
	read := func(used float64, at time.Duration, resetAt time.Time) {
		s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 1 - used, ResetAt: resetAt, ObservedAt: c.t.Add(at), Source: "header"}})
	}
	weekly := func(at time.Duration) float64 {
		s.mu.Lock()
		defer s.mu.Unlock()
		rem, _, _, _ := s.effective(s.creds["claude-a"], KindWeekly, c.t.Add(at))
		return 1 - rem
	}
	read(0.26, 0, reset)
	read(0, time.Second, reset)
	read(0.26, 2*time.Second, reset)
	read(0, 3*time.Second, reset)
	if got := weekly(time.Minute); !near(got, 0.26) {
		t.Fatalf("while the fall waits: %v", got)
	}
	if got := weekly(10 * time.Minute); !near(got, 0) || s.StartedOver("claude-a").IsZero() {
		t.Fatalf("after it settles: %v", got)
	}
	read(0.50, 20*time.Minute, reset)
	read(0.40, 21*time.Minute, reset)
	read(0.50, 22*time.Minute, reset)
	read(0.30, 23*time.Minute, reset.Add(-7*24*time.Hour)) // the window before, read late
	if got := weekly(40 * time.Minute); !near(got, 0.50) {
		t.Fatalf("late readings moved the window: %v", got)
	}
	// A full reading without a 5-hour window: the account has none, rather than one not read.
	s.MergePoll("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 0.5, ResetAt: reset, ObservedAt: c.t.Add(41 * time.Minute)}})
	if _, present, absent := s.FiveHour("claude-a"); present || !absent {
		t.Fatal("5-hour window not absent")
	}
}

// After the plan changes, a fall smaller than resetDrop that settles starts the window over: a plan
// change can begin a window that had used little.
func TestAfterAPlanChangeASmallFallStartsTheWindowOver(t *testing.T) {
	s, c := newTestState()
	reset := c.t.Add(24 * time.Hour)
	s.SetPlan("claude-a", "claude", "Max 5x")
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 0.96, ResetAt: reset, ObservedAt: c.t}})
	s.SetPlan("claude-a", "claude", "Max 20x")
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindWeekly, Remaining: 1, ResetAt: reset, ObservedAt: c.t.Add(time.Minute)}})
	s.mu.Lock()
	rem, _, _, _ := s.effective(s.creds["claude-a"], KindWeekly, c.t.Add(10*time.Minute))
	s.mu.Unlock()
	if !near(rem, 1) {
		t.Fatalf("remaining %v, want the window started over", rem)
	}
	if log := s.TakeLog(); len(log) < 2 || log[len(log)-2].Plan != "Max 20x" {
		t.Fatalf("no plan line in %+v", log)
	}
}

// A restart keeps which windows the account does not have, and a reading dated ahead of the clock
// (it was set back since) does not count as fresh.
func TestARestartKeepsAbsenceAndDistrustsTheFuture(t *testing.T) {
	s, c := newTestState()
	s.MergePoll("codex-a", "codex", []Window{{Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t.Add(time.Hour)}})
	saved := s.Export()
	r, _ := newTestState()
	r.Import(saved)
	if _, _, absent := r.FiveHour("codex-a"); !absent {
		t.Fatal("absence lost")
	}
	r.mu.Lock()
	_, _, present, fresh := r.effective(r.creds["codex-a"], KindWeekly, c.t)
	r.mu.Unlock()
	if !present || fresh {
		t.Fatalf("a reading from the future: present %v fresh %v", present, fresh)
	}
	// A Claude reading that names no model window of its own says the account has none: one
	// another account has shows as no such quota here, not as not reported.
	s.MergePoll("claude-a", "claude", []Window{{Kind: KindFiveHour, Remaining: 0.9, ObservedAt: c.t}, {Kind: KindWeekly, Remaining: 0.5, ObservedAt: c.t}})
	var absent []string
	for _, cv := range s.Build().Providers["claude"].Credentials {
		if cv.ID == "claude-a" {
			absent = cv.Absent
		}
	}
	if fmt.Sprint(absent) != "[7d_fable 7d_opus 7d_sonnet]" {
		t.Fatalf("absent = %v", absent)
	}
}

// Once the host's list is read, a late record of an account it no longer holds is history: it does
// not bring the account back, though its line is logged.
func TestALateRecordDoesNotBringARemovedAccountBack(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	s.UpdateInventory(inventory[1:]) // claude-a removed
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, Output: 10})
	if s.creds["claude-a"] != nil || len(s.TakeLog()) != 1 {
		t.Fatal("a removed account came back, or its usage was lost")
	}
}

// An automatic takeover acts on the host's list as it is now: an old list asks to be read again.
func TestATakeoverWaitsForAFreshAccountList(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory(inventory)
	s.SetConfig(Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude": "codex:gpt-6-sol"}})
	setQuota(s, c, "claude-a", 0.9, 0, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0, 24*time.Hour)
	c.add(time.Minute)
	in := RouteInput{Session: "s1", RequestedModel: "claude-opus-5-5", BodyBytes: 30000, Available: []string{"claude", "codex"}, Turn: true}
	if d := s.Route(in); d.Handled || !d.Recheck {
		t.Fatalf("with a minute-old list: %+v", d)
	}
	s.UpdateInventory(inventory)
	if d := s.Route(in); !d.Handled || d.Provider != "codex" {
		t.Fatalf("with a fresh list: %+v", d)
	}
}

// Two credentials of one provider account count as the one the host holds, else the one read last;
// a credential alone for its account is left as it is.
func TestCredentialsOfOneAccountCountAsOne(t *testing.T) {
	s, c := newTestState()
	s.UpdateInventory([]CredInfo{{ID: "codex-new", Provider: "codex"}})
	s.SetIdentity("codex-old", "codex:acct-1")
	c.add(time.Hour)
	s.SetIdentity("codex-new", "codex:acct-1")
	s.SetIdentity("codex-other", "codex:acct-2")
	if got := s.Canonical(); len(got) != 1 || got["codex-old"] != "codex-new" {
		t.Fatalf("canonical = %v", got)
	}
	s.UpdateInventory([]CredInfo{{ID: "claude-x", Provider: "claude"}})
	c.add(time.Minute)
	s.SetIdentity("codex-old", "codex:acct-1") // read again, later
	if got := s.Canonical(); got["codex-new"] != "codex-old" {
		t.Fatalf("neither held: canonical = %v", got)
	}
	r, _ := newTestState()
	r.Import(s.Export())
	if got := r.Canonical(); got["codex-new"] != "codex-old" {
		t.Fatalf("after a restart: canonical = %v", got)
	}
	// Both held: the snapshot says which counts under which, so a pool counts the quota once.
	s.UpdateInventory([]CredInfo{{ID: "codex-new", Provider: "codex"}, {ID: "codex-old", Provider: "codex"}})
	same := map[string]string{}
	for _, cv := range s.Build().Providers["codex"].Credentials {
		same[cv.ID] = cv.SameAs
	}
	if same["codex-new"] != "codex-old" || same["codex-old"] != "" {
		t.Fatalf("same account: %v", same)
	}
	// An enabled credential counts the account over a disabled one, so the pool keeps it.
	s.UpdateInventory([]CredInfo{{ID: "codex-new", Provider: "codex"}, {ID: "codex-old", Provider: "codex", Disabled: true}})
	if _, got := s.BuildWithCanonical(); got["codex-old"] != "codex-new" {
		t.Fatalf("with the read-last credential disabled: canonical = %v", got)
	}
	if band := s.BuildForBand("", "", ""); band.Providers["codex"].Credentials[1].SameAs != band.Providers["codex"].Credentials[0].ID &&
		band.Providers["codex"].Credentials[0].SameAs != band.Providers["codex"].Credentials[1].ID {
		t.Fatal("the band's ids for the same account do not match")
	}
}

// Accounts are named apart: as many leading characters as it takes, up to four, then a number.
func TestAccountsAreNamedApart(t *testing.T) {
	got := UniqueLabels(map[string]string{"a": "kelly@x.com", "b": "kyle@x.com", "c": "dana@x.com", "d": "sam@x.com", "e": "sam@y.com"})
	want := map[string]string{"a": "ke•••", "b": "ky•••", "c": "d•••", "d": "sam•••", "e": "sam•••2"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("labels = %v", got)
	}
}

// Low headroom is a preference, being used up is not being able to serve: an account that can serve
// comes before one that cannot, whatever their ids, and a refused session may leave for it.
func TestAnAccountThatCanServeComesBeforeOneThatCannot(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0, 24*time.Hour)     // used up
	setQuota(s, c, "claude-b", 0.2, 0.5, 4*24*time.Hour) // 5-hour quota low, serving
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v, want the account that can serve", got)
	}
	s.bindings["claude|claude:s2"] = &Binding{AuthID: "claude-a", LastUsed: c.t}
	s.creds["claude-a"].refusedAt = c.t
	if got := pick(s, "claude:s2", "m", both); got.AuthID != "claude-b" {
		t.Fatalf("a refused session stayed: %+v", got)
	}
}

// The host offers an account for the model asked: a cooldown it reports on some other model does
// not hold it back; at exactly the threshold an account has enough of its 5-hour window.
func TestAnOfferedAccountIsRankedOnItsQuota(t *testing.T) {
	s, c := newTestState()
	s.SetConfig(Config{MinFiveHourLeftPercent: 10})
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude", Unavailable: true, NextRetryAfter: c.t.Add(time.Hour)}, {ID: "claude-b", Provider: "claude"}})
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("pick = %+v: a cooldown elsewhere held claude-a back", got)
	}
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindFiveHour, Remaining: 1 - 0.9, ResetAt: c.t.Add(3 * time.Hour), ObservedAt: c.t.Add(time.Second)}})
	if got := pick(s, "claude:s2", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("pick = %+v: 10%% left is the threshold, not under it", got)
	}
}

// A turn's need on another model is the conversation as its last turn read it, or the request when
// larger, with attachments counted as attachments and room for the answer it allows; a model's
// family and suffixes find its context window.
func TestARouteMeasuresTheConversation(t *testing.T) {
	s, _ := newTestState()
	sess := &session{Last: Tokens{Input: 10, CacheRead: 250000, CacheCreation: 5000, Output: 1000}}
	if got := needOf(sess, RouteInput{BodyBytes: 3000}); got != 256010+outputReserveTokens {
		t.Fatalf("need of a short continuation = %d", got)
	}
	if got := needOf(&session{}, RouteInput{BodyBytes: 3000, Attachments: 2, MaxOutput: 8000}); got != 1000+2*attachmentTokens+8000 {
		t.Fatalf("need of a request = %d", got)
	}
	for model, want := range map[string]int{"claude-fable-5-1": 1000000, "claude-opus-5-5[1m]": 1000000, "gpt-6.1-sol": 272000, "llama": 0} {
		if got := s.contextLengthLocked(model); got != want {
			t.Errorf("%s: %d, want %d", model, got, want)
		}
	}
	if s.fitsLocked("gpt-6-sol", needOf(sess, RouteInput{BodyBytes: 3000})) == "" {
		t.Fatal("a 256k conversation passed for gpt-6-sol's 272k, with no room left for the answer")
	}
}

// A session's view names the accounts that cannot serve its next model, so the band does not offer
// them: one with its Fable window used up, for a session on Fable.
func TestASessionViewNamesTheAccountsThatCannotServeIt(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	s.MergeWindows("claude-b", "claude", []Window{{Kind: "7d_fable", Remaining: 0, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}})
	served(s, c, "claude:s1", "claude-a", false)
	s.Route(RouteInput{Session: "s1", RequestedModel: "claude-fable-5-1", Turn: true})
	if v := s.Build().Sessions["s1"]; fmt.Sprint(v.Blocked) != "[claude-b]" {
		t.Fatalf("blocked = %v", v.Blocked)
	}
	if v := s.BuildForBand("s1", "", "").Sessions["s1"]; len(v.Blocked) != 1 || v.Blocked[0] == "claude-b" {
		t.Fatalf("remote blocked = %v", v.Blocked)
	}
}

// What a user chose lasts as long as a session can be resumed; what the proxy chose, a day unused.
func TestAChoiceOutlastsAPause(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
	served(s, c, "claude:s2", "claude-a", true)
	s.Apply(Command{CommandID: "c1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
	s.Apply(Command{CommandID: "c2", Session: "s2", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "gpt-6-sol"})
	c.add(3 * 24 * time.Hour) // a weekend
	s.Sweep()
	r, _ := newTestState()
	r.Import(s.Export())
	for _, st := range []*State{s, r} {
		if b := st.bindings["claude|claude:s1"]; b == nil || b.AuthID != "claude-b" {
			t.Fatalf("the account chosen = %+v", b)
		}
		if _, ok := st.routes["claude:s2"]; !ok {
			t.Fatal("the route chosen was dropped")
		}
		if b := st.bindings["claude|claude:s2"]; b != nil {
			t.Fatalf("the account the proxy chose = %+v", b)
		}
	}
	c.add(choiceTTL)
	s.Sweep()
	if len(s.bindings) != 0 || len(s.routes) != 0 {
		t.Fatalf("past a month: %v %v", s.bindings, s.routes)
	}
}

// A Codex turn counts its cached input once, as a Claude one does: routing sizes the conversation
// from it, and a restart keeps it.
func TestACodexTurnCountsItsCacheOnce(t *testing.T) {
	s, c := newTestState()
	s.Observe(Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "claude:s1", AuthID: "codex-a", RequestedAt: c.t,
		Input: 200_000, CacheRead: 140_000, Output: 1_000})
	r, _ := newTestState()
	r.Import(s.Export())
	for _, st := range []*State{s, r} {
		if last := st.Build().Sessions["s1"].Last; last.Input != 60_000 || last.CacheRead != 140_000 {
			t.Fatalf("last turn = %+v", last)
		}
	}
	if need := needOf(r.sessions["claude:s1"], RouteInput{BodyBytes: 3000}); need != 201_000+outputReserveTokens {
		t.Fatalf("need = %d", need)
	}
}

// The band is told the account a new session gets for its model, as a pick ranks them: a model
// with a weekly window of its own goes by that window's reset.
func TestTheBandIsToldTheAccountANewSessionGets(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
	s.MergeWindows("claude-a", "claude", []Window{{Kind: "7d_fable", Remaining: 0.5, ResetAt: c.t.Add(20 * 24 * time.Hour), ObservedAt: c.t}})
	s.MergeWindows("claude-b", "claude", []Window{{Kind: "7d_fable", Remaining: 0.5, ResetAt: c.t.Add(2 * time.Hour), ObservedAt: c.t}})
	for model, want := range map[string]string{"claude-opus-5-5": "claude-a", "claude-fable-5-1": "claude-b"} {
		if got := s.BuildForBand("s1", model, "").Expected["claude"]; got != opaqueID(want) {
			t.Errorf("%s: expected %s, want %s", model, got, opaqueID(want))
		}
		if got := pick(s, "claude:new-"+model, model, both); got.AuthID != want {
			t.Errorf("%s: a pick took %s, want %s", model, got.AuthID, want)
		}
	}
}
