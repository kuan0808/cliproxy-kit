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
		s.Intercept(InterceptInput{Session: RawSession(rootOnly(canonical)), TraceID: trace, Model: "claude-opus-5-5", RequestedModel: "claude-opus-5-5", Thread: "continue", Tools: 20})
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
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindFiveHour, Remaining: 0.20, ResetAt: c.t.Add(20 * time.Minute), ObservedAt: c.t}})
	if got := pick(s, "claude:s2", "claude-opus-5-5", both); got.AuthID != "claude-a" {
		t.Fatalf("pick = %+v, want claude-a: its 5-hour window resets in 20 minutes", got)
	}
	// A window that does not say when it resets is not about to.
	s.MergeWindows("claude-a", "claude", []Window{{Kind: KindFiveHour, Remaining: 0.20, ObservedAt: c.t.Add(time.Second)}})
	if got := pick(s, "claude:s3", "claude-opus-5-5", both); got.AuthID != "claude-b" {
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

	refuse := func(id string) {
		h := http.Header{}
		h.Set("anthropic-ratelimit-unified-7d-utilization", "1.0")
		h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprint(c.t.Add(24*time.Hour).Unix()))
		s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: id, RequestedAt: c.t, Failed: true, ResponseHeader: h})
	}
	setQuota(s, c, "claude-b", 0.9, 0, 4*24*time.Hour)
	refuse("claude-a")
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-a" {
		t.Fatalf("with no ready account, a refused session moved: %+v", got)
	}

	setQuota(s, c, "claude-b", 0.9, 0.5, 4*24*time.Hour)
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
	// claude-b now resets sooner: the session stays, a new session follows the ranking.
	setQuota(s, c, "claude-b", 0.9, 0.5, time.Hour)
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
	served(s, c, "claude:s1", pick(s, "claude:s1", "m", both).AuthID, true)
	pick(s, "claude:s1", "m", []Candidate{credB}) // claude-a cooling down
	served(s, c, "claude:s1", "claude-b", false)
	if got := pick(s, "claude:s1", "m", both); got.AuthID != "claude-b" {
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
	ws = WindowsFromUsageBody("codex", body, now)
	if len(ws) != 1 || ws[0].Kind != "5h" || ws[0].Remaining != 0.8 {
		t.Fatalf("codex body windows = %+v", ws)
	}
	claude := []byte(`{"five_hour":{"utilization":14,"resets_at":"2026-10-04T01:10:00.49+00:00"},"seven_day":{"utilization":33,"resets_at":"2026-10-10T00:00:00+00:00"},"iguana_necktie":{"utilization":null},"extra_usage":{"utilization":null}}`)
	if ws = WindowsFromUsageBody("claude", claude, now); len(ws) != 2 {
		t.Fatalf("claude body windows = %+v", ws)
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
	setQuota(s, c, "claude-b", 0.05, 0.5, 24*time.Hour)
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
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	if d := s.Route(in); !d.Handled {
		t.Fatalf("route dropped mid-session: %+v", d)
	}
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

func TestBandSnapshotHasNoEmailsOrPaths(t *testing.T) {
	s, c := newTestState()
	s.SetConfig(Config{BandTokens: []string{"tok-1"}})
	s.UpdateInventory([]CredInfo{{ID: "claude-dana@example.com.json", Provider: "claude", Email: "dana@example.com"}, {ID: "claude-alex@example.com.json", Provider: "claude", Email: "alex@example.com"}})
	setQuota(s, c, "claude-dana@example.com.json", 0, 0.5, 24*time.Hour)
	setQuota(s, c, "claude-alex@example.com.json", 0.9, 0.5, 48*time.Hour)
	served(s, c, "claude:s1", "claude-dana@example.com.json", true)
	s.NoteError("open /Users/dana/.cli-proxy-api/claude-dana@example.com.json: permission denied")
	served(s, c, "claude:s2", "claude-alex@example.com.json", true)
	band := s.BuildForBand("s1")
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
	if !s.BandTokenAllowed("tok-1") || s.BandTokenAllowed("tok-2") || s.BandTokenAllowed("") {
		t.Fatalf("band token check wrong")
	}
}

func TestBindingsRoutesAndSessionsSurviveARestart(t *testing.T) {
	s, c := newTestState()
	setQuota(s, c, "claude-a", 0.9, 0.5, 4*24*time.Hour)
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
	served(s, c, "claude:s1", "claude-a", true)
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
	if got := s.BuildForBand("").Providers["claude"].Credentials[0].Plan; got != "Max 20x" {
		t.Fatalf("snapshot plan = %q", got)
	}
}

func TestASideRequestLeavesTheSessionModel(t *testing.T) {
	s, c := newTestState()
	turn := func(trace, model string, tools int) {
		s.Intercept(InterceptInput{Session: "s1", TraceID: trace, Model: model, RequestedModel: model, Tools: tools})
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
	info, _ := s.Account("claude-a")
	if s.StartedOver("claude-a") != c.t || info.ResetAt != c.t.Add(24*time.Hour) {
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
	s.Intercept(InterceptInput{Session: "s1", TraceID: "side", Model: "claude-sonnet-5", RequestedModel: "claude-sonnet-5"})
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
	setQuota(s, c, "claude-b", 0.9, 0.5, 24*time.Hour)
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
