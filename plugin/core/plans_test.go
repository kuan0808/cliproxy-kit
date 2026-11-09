package core

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

// weeklyOnly gives a Claude account a full usage reading that names a weekly window and no 5-hour
// one: a plan without a 5-hour limit.
func weeklyOnly(s *State, c *clock, id string, weekly float64, reset time.Duration) {
	s.MergePoll(id, "claude", []Window{{Kind: KindWeekly, Remaining: weekly, ResetAt: c.t.Add(reset), ObservedAt: c.t}}, false)
}

// A plan without a 5-hour limit is ranked by its week: the provider said the account has no such
// window, so nothing waits for one.
func TestAnAccountWithoutAFiveHourWindowIsRankedByItsWeek(t *testing.T) {
	s, c := newTestState()
	weeklyOnly(s, c, "claude-a", 0.5, 4*24*time.Hour)
	weeklyOnly(s, c, "claude-b", 0.5, 24*time.Hour)
	if got := pick(s, "claude:s1", "claude-opus-5-5", both); got.AuthID != "claude-b" || got.Reason != "weekly quota resets soonest" {
		t.Fatalf("pick = %+v, want claude-b, whose week resets first", got)
	}
	if h := s.Health("claude", "claude-opus-5-5"); h != "unknown" {
		t.Fatalf("health before the account list = %q", h)
	}
	s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
	if h := s.Health("claude", "claude-opus-5-5"); h != "healthy" {
		t.Fatalf("health = %q, want healthy", h)
	}
	// One whose 5-hour window is only not read yet (headers named its week alone) still waits.
	s.MergeWindows("claude-c", "claude", []Window{{Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(time.Hour), ObservedAt: c.t}})
	if got := pick(s, "claude:s2", "claude-opus-5-5", []Candidate{credA, credB, credC}); got.AuthID != "claude-b" {
		t.Fatalf("pick = %+v, want claude-b: claude-c's 5-hour window is not known yet", got)
	}
}

// The Fable limit comes in the response headers as the window `7d_oi`, as Claude Code reads it.
func TestTheFableWindowIsReadFromTheHeaders(t *testing.T) {
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.4")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1794744000")
	h.Set("anthropic-ratelimit-unified-7d_oi-utilization", "0.37")
	h.Set("anthropic-ratelimit-unified-7d_oi-reset", "1794700000")
	h.Set("anthropic-ratelimit-unified-7d_oi-surpassed-threshold", "0.25")
	h.Set("anthropic-ratelimit-unified-overage-status", "rejected")
	got := map[string]Window{}
	for _, w := range WindowsFromHeaders("claude", h, now) {
		got[w.Kind] = w
	}
	fable := got["7d_fable"]
	if len(got) != 2 || fmt.Sprintf("%.2f", fable.Remaining) != "0.63" || fable.ResetAt.Unix() != 1794700000 {
		t.Fatalf("windows = %+v", got)
	}
	h.Set("anthropic-ratelimit-unified-7d_oi-status", "rejected")
	for _, w := range WindowsFromHeaders("claude", h, now) {
		if w.Kind == "7d_fable" && w.Remaining != 0 {
			t.Fatalf("a rejected Fable window = %+v", w)
		}
	}
}

// The usage endpoint lists a model's own weekly limit as a `weekly_scoped` row of `limits`, named by
// the model it is for.
func TestTheFableWindowIsReadFromTheUsageEndpoint(t *testing.T) {
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	body := []byte(`{"five_hour":null,"seven_day":{"utilization":40,"resets_at":"2026-11-13T08:00:00+00:00"},"seven_day_sonnet":null,
		"limits":[
			{"kind":"weekly_all","group":"weekly","percent":40,"resets_at":"2026-11-13T08:00:00+00:00","scope":null,"severity":"normal","is_active":true},
			{"kind":"weekly_scoped","group":"weekly","percent":12,"resets_at":"2026-11-14T00:00:00+00:00","scope":{"model":{"display_name":"Fable"}},"severity":"normal","is_active":false},
			{"kind":"weekly_scoped","group":"weekly","percent":3,"resets_at":null,"scope":{"surface":{"display_name":"Cowork"}},"severity":"normal","is_active":false}
		]}`)
	ws, full, scoped := WindowsFromUsageBody("claude", body, now)
	got := map[string]Window{}
	for _, w := range ws {
		got[w.Kind] = w
	}
	fable := got["7d_fable"]
	if !full || !scoped || len(got) != 2 || fable.Remaining != 0.88 || !fable.ResetAt.Equal(time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("windows = %+v full %v scoped %v", got, full, scoped)
	}
	// An answer without `limits` says nothing of a model's own window.
	if _, full, scoped = WindowsFromUsageBody("claude", []byte(`{"seven_day":{"utilization":40}}`), now); !full || scoped {
		t.Fatalf("a reading without limits: full %v scoped %v", full, scoped)
	}
	for name, kind := range map[string]string{"Fable": "7d_fable", "Claude Fable 5.2": "7d_fable", "Sonnet": "7d_sonnet", "Mythos Preview": "7d_mythos_preview"} {
		if got := ScopedKind(name); got != kind {
			t.Errorf("ScopedKind(%q) = %q, want %q", name, got, kind)
		}
	}
}

// A model's own window the headers named stays until a usage reading that lists such windows leaves
// it out: only that says it is gone. One no header named is one the account does not have.
func TestOnlyAReadingThatListsModelWindowsSaysOneIsGone(t *testing.T) {
	s, c := newTestState()
	absent := func() string {
		for _, cv := range s.Build().Providers["claude"].Credentials {
			if cv.ID == "claude-a" {
				kinds := []string{}
				for _, w := range cv.Windows {
					kinds = append(kinds, w.Kind)
				}
				return fmt.Sprint(kinds, cv.Absent)
			}
		}
		return ""
	}
	week := Window{Kind: KindWeekly, Remaining: 0.5, ResetAt: c.t.Add(24 * time.Hour), ObservedAt: c.t}
	s.MergePoll("claude-a", "claude", []Window{week}, false)
	if got := absent(); got != "[7d] [5h 7d_fable 7d_opus 7d_sonnet]" {
		t.Fatalf("with no header naming it: %s", got)
	}
	s.MergeWindows("claude-a", "claude", []Window{{Kind: "7d_fable", Remaining: 0.8, ResetAt: c.t.Add(48 * time.Hour), ObservedAt: c.t}})
	s.MergePoll("claude-a", "claude", []Window{week}, false)
	if got := absent(); got != "[7d 7d_fable] [5h 7d_opus 7d_sonnet]" {
		t.Fatalf("after a reading without limits: %s", got)
	}
	s.MergePoll("claude-a", "claude", []Window{week}, true)
	if got := absent(); got != "[7d] [5h 7d_fable 7d_opus 7d_sonnet]" {
		t.Fatalf("after a reading that lists them: %s", got)
	}
}

// The plan is named as the provider names it, when its profile says; else by what the profile tells.
func TestTheProvidersOwnPlanNameWins(t *testing.T) {
	for body, want := range map[string]string{
		`{"account":{"has_claude_max":true},"organization":{"rate_limit_tier":"default_claude_max_20x","plan_display_name":"Ultra"}}`:        "Ultra",
		`{"account":{"has_claude_max":true},"organization":{"rate_limit_tier":"default_claude_max_20x","plan_display_name":"  "}}`:           "Max 20x",
		`{"account":{"has_claude_max":true},"organization":{"rate_limit_tier":"default_claude_max_20x","plan_display_name":"<b>Ultra</b>"}}`: "Max 20x",
		`{"account":{"has_claude_max":true},"organization":{"rate_limit_tier":"default_claude_max_5x","plan_display_name":null}}`:            "Max 5x",
	} {
		if got := ClaudePlan([]byte(body)); got != want {
			t.Errorf("ClaudePlan(%s) = %q, want %q", body, got, want)
		}
	}
}

// A binding that expired takes its retry marks with it: a session resumed days later starts clean,
// on whatever account it is given then.
func TestAnExpiredBindingTakesItsHungMarkWithIt(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	pk(s, both...)
	c.add(135 * time.Second)
	failed(s, c, "claude-a", "", 0, "EOF", 135*time.Second, 0)
	pk(s, both...)
	c.add(2 * time.Second)
	failed(s, c, "claude-a", "", 0, "read: connection reset by peer", time.Second, 0)
	if !s.hung[episodeKey{"claude|claude:s1", opus}] {
		t.Fatal("setup: the binding is not marked")
	}
	c.add(25 * time.Hour)
	s.Sweep()
	given := pk(s, both...)
	answered(s, c, "claude:s1", given.AuthID)
	if r := pk(s, both...); r.AuthID != given.AuthID {
		t.Fatalf("the resumed session left %s, the account it was just given: %+v", given.AuthID, r)
	}
}

// The refusal that first says a window is used up is a quota refusal, by its own headers: the
// session leaves at once, with no retry on an account that has nothing left.
func TestTheFirstRefusalAtALimitIsAQuotaRefusal(t *testing.T) {
	s, c := retrySetup(t, 160_000)
	pk(s, both...)
	c.add(2 * time.Second)
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "1.0")
	h.Set("anthropic-ratelimit-unified-7d-status", "rejected")
	h.Set("anthropic-ratelimit-unified-7d-reset", fmt.Sprint(c.t.Add(24*time.Hour).Unix()))
	s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t.Add(-time.Second),
		Failed: true, StatusCode: 429, ErrorText: `{"type":"error","error":{"type":"rate_limit_error","message":"limit reached"}}`,
		Latency: time.Second, TTFT: time.Second, ResponseHeader: h})
	if r := pk(s, credB); r.Reject || r.AuthID != "claude-b" {
		t.Fatalf("the pick after the refusal = %+v, want claude-b at once", r)
	}
	answered(s, c, "claude:s1", "claude-b")
	sw := s.Build().Sessions["s1"].LastSwitch
	if sw == nil || sw.Kind != MoveQuota || sw.Cause == nil || sw.Cause.Reason != "weekly quota used up" {
		t.Fatalf("record %+v", sw)
	}
}
