package core

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

const fable = "claude-fable-5-2"

// fableSetup is two Claude accounts with their week half used, beside a Codex one, and a session s1
// asking for Fable; fableLeft sets what is left of each account's own Fable week.
func fableSetup(t *testing.T, cfg Config) (*State, *clock, RouteInput) {
	t.Helper()
	s, c := newTestState()
	s.UpdateInventory(inventory)
	s.SetConfig(cfg)
	for _, id := range []string{"claude-a", "claude-b"} {
		weeklyOnly(s, c, id, 0.5, 3*24*time.Hour)
	}
	return s, c, RouteInput{Session: "s1", RequestedModel: fable, BodyBytes: 30000, Available: []string{"claude", "codex"}, Turn: true}
}

func fableLeft(s *State, c *clock, id string, left float64) {
	s.MergeWindows(id, "claude", []Window{{Kind: "7d_fable", Remaining: left, ResetAt: c.t.Add(3 * 24 * time.Hour), ObservedAt: c.t}})
}

func routeOf(s *State) *Route { return s.Build().Sessions["s1"].Route }

// A model whose own limit is used up on every account runs what the fallback map names for it, by
// itself and within its provider; one account running out is not that.
func TestAModelUsedUpOnEveryAccountRunsItsFallback(t *testing.T) {
	s, c, in := fableSetup(t, Config{FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5"}})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0.4)
	if d := s.Route(in); d.Handled {
		t.Fatalf("one account out of Fable rerouted the session: %+v", d)
	}
	fableLeft(s, c, "claude-b", 0)
	d := s.Route(in)
	if !d.Handled || d.Provider != "claude" || d.Model != "claude-opus-5-5" {
		t.Fatalf("route = %+v, want claude-opus-5-5", d)
	}
	if r := routeOf(s); r == nil || !r.Auto || r.From != fable || r.Model != "claude-opus-5-5" {
		t.Fatalf("the session's route = %+v", r)
	}
	// It stands in for Fable alone: the session's other requests run as asked.
	for _, model := range []string{"claude-haiku-5-5", "claude-opus-5-5"} {
		other := in
		other.RequestedModel, other.Turn = model, false
		if d := s.Route(other); d.Handled {
			t.Fatalf("a %s request of the session was rerouted: %+v", model, d)
		}
	}
	if d := s.Intercept(InterceptInput{Session: "s1", Model: "claude-haiku-5-5", RequestedModel: "claude-haiku-5-5", Thread: "continue"}); d.Terminate {
		t.Fatalf("a Haiku request beside the route was stopped: %+v", d)
	}
	// A thread keeps one model: its continuation is sent again whole, on the fallback.
	d2 := s.Intercept(InterceptInput{Session: "s1", Model: "claude-opus-5-5", RequestedModel: fable, Thread: "continue"})
	if !d2.Terminate || d2.ErrorCode != threadUnsupported {
		t.Fatalf("a thread continuation on the fallback = %+v", d2)
	}
	if d := s.Intercept(InterceptInput{Session: "s1", Model: "claude-opus-5-5", RequestedModel: fable}); d.Terminate {
		t.Fatalf("a whole request on the fallback was stopped: %+v", d)
	}
}

// The map is followed again when what it names is used up too; a step to another provider happens
// by itself only under cross_provider auto.
func TestTheFallbackMapIsFollowedUntilAModelCanServe(t *testing.T) {
	chain := map[string]string{"claude-fable": "claude-opus-5-5", "claude": "codex:gpt-6-sol"}
	weeksGone := func(s *State, c *clock) {
		for _, id := range []string{"claude-a", "claude-b"} {
			weeklyOnly(s, c, id, 0, 3*24*time.Hour)
		}
	}
	s, c, in := fableSetup(t, Config{FallbackMap: chain})
	weeksGone(s, c)
	if d := s.Route(in); d.Handled || s.Build().Sessions["s1"].RouteNote != "" {
		t.Fatalf("cross_provider off crossed providers, or noted it: %+v %q", d, s.Build().Sessions["s1"].RouteNote)
	}
	s, c, in = fableSetup(t, Config{CrossProvider: "auto", FallbackMap: chain})
	weeksGone(s, c)
	if d := s.Route(in); !d.Handled || d.Provider != "codex" || d.Model != "gpt-6-sol" {
		t.Fatalf("route = %+v, want codex past the used-up Opus", d)
	}
	if r := routeOf(s); r == nil || r.From != "" {
		t.Fatalf("a route to another provider stands in for every model: %+v", r)
	}
	// A route whose own target runs out is decided again.
	s, c, in = fableSetup(t, Config{CrossProvider: "auto", FallbackMap: chain})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	if d := s.Route(in); d.Model != "claude-opus-5-5" {
		t.Fatalf("first route = %+v", d)
	}
	weeksGone(s, c)
	if d := s.Route(in); !d.Handled || d.Model != "gpt-6-sol" {
		t.Fatalf("after Opus ran out too: %+v", d)
	}
}

func TestChangingModelsEvaluatesItsOwnFallback(t *testing.T) {
	s, c, in := fableSetup(t, Config{CrossProvider: "auto", FallbackMap: map[string]string{
		"claude-fable": "claude-opus-5-5", "claude": "codex:gpt-6-sol",
	}})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	if d := s.Route(in); d.Model != "claude-opus-5-5" {
		t.Fatalf("initial Fable fallback = %+v", d)
	}
	for _, id := range []string{"claude-a", "claude-b"} {
		weeklyOnly(s, c, id, 0, 3*24*time.Hour)
	}
	in.RequestedModel, in.Turn = "claude-opus-5-5", false
	if d := s.Route(in); d.Handled || d.Refresh {
		t.Fatalf("a side request replaced the model route: %+v", d)
	}
	if r := routeOf(s); r == nil || r.From != fable {
		t.Fatalf("the side request discarded the Fable route: %+v", r)
	}
	in.Turn = true
	if d := s.Route(in); !d.Handled || d.Provider != "codex" || d.Model != "gpt-6-sol" {
		t.Fatalf("Opus after /model = %+v", d)
	}
	if v := s.Build().Sessions["s1"]; v.Route == nil || v.Route.From != "" || v.Model != "gpt-6-sol" || v.RequestedModel != in.RequestedModel {
		t.Fatalf("the new model's route is not visible: %+v", v)
	}
	if d := s.Intercept(InterceptInput{Session: in.Session, Model: "gpt-6-sol", RequestedModel: in.RequestedModel, Thread: "continue"}); !d.Terminate || d.ErrorCode != threadUnsupported {
		t.Fatalf("the new route did not request a whole-history replay: %+v", d)
	}
	if d := s.Intercept(InterceptInput{Session: in.Session, Model: "gpt-6-sol", RequestedModel: in.RequestedModel}); d.Terminate {
		t.Fatalf("the new route stopped its stateless replay: %+v", d)
	}
}

func TestIdleAutomaticRoutesRefreshUnknownQuota(t *testing.T) {
	for _, target := range []string{"claude-opus-5-5", "codex:gpt-6-sol"} {
		for _, recovered := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/recovered=%t", target, recovered), func(t *testing.T) {
				s, c, in := fableSetup(t, Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude-fable": target}})
				fableLeft(s, c, "claude-a", 0)
				fableLeft(s, c, "claude-b", 0)
				if d := s.Route(in); !d.Handled || d.Refresh {
					t.Fatalf("initial fallback = %+v", d)
				}
				c.add(10 * time.Minute)
				if d := s.Route(in); !d.Handled || d.Refresh {
					t.Fatalf("an ordinary turn requested polling: %+v", d)
				}
				at := routeOf(s).At
				c.add(61 * time.Minute)
				for range 2 {
					if d := s.Route(in); !d.Handled || !d.Refresh {
						t.Fatalf("stale quota after rest = %+v", d)
					}
					if r := routeOf(s); r == nil || !r.At.Equal(at) {
						t.Fatalf("unknown quota consumed the idle interval: %+v", r)
					}
					c.add(time.Second)
				}
				left := 0.0
				if recovered {
					left = 1
				}
				for _, id := range []string{"claude-a", "claude-b"} {
					weeklyOnly(s, c, id, 0.5, 3*24*time.Hour)
					fableLeft(s, c, id, left)
				}
				d := s.Route(in)
				if d.Refresh || d.Handled == recovered {
					t.Fatalf("after refreshed quota, recovered=%t: %+v", recovered, d)
				}
				if r := routeOf(s); recovered && r != nil || !recovered && (r == nil || !r.At.Equal(c.t)) {
					t.Fatalf("route after refreshed quota = %+v", r)
				}
			})
		}
	}
}

// An automatic route ends by itself only when that costs nothing: what it stood in for can serve
// again and the session has rested past its cache. Until then it stays, and `back` ends it.
func TestAnAutomaticRouteEndsOnceItCostsNothing(t *testing.T) {
	s, c, in := fableSetup(t, Config{FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5"}})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	if d := s.Route(in); !d.Handled {
		t.Fatalf("setup route = %+v", d)
	}
	fresh := func() {
		for _, id := range []string{"claude-a", "claude-b"} {
			weeklyOnly(s, c, id, 0.5, 3*24*time.Hour)
			s.MergeWindows(id, "claude", []Window{{Kind: "7d_fable", Remaining: 1, ResetAt: c.t.Add(7 * 24 * time.Hour), ObservedAt: c.t}})
		}
	}
	c.add(10 * time.Minute)
	fresh()
	if d := s.Route(in); !d.Handled || d.Model != "claude-opus-5-5" {
		t.Fatalf("the route ended while the fallback's cache was warm: %+v", d)
	}
	c.add(61 * time.Minute)
	fresh()
	if d := s.Route(in); d.Handled || routeOf(s) != nil {
		t.Fatalf("after an hour's rest with Fable back: %+v route %+v", d, routeOf(s))
	}
}

// A refusal names the limit that refused it, when no window of its own does.
func TestARefusalNamesTheWindowThatIsUsedUp(t *testing.T) {
	now := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.4")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1794744000")
	h.Set("anthropic-ratelimit-unified-status", "rejected")
	h.Set("anthropic-ratelimit-unified-representative-claim", "seven_day_overage_included")
	h.Set("anthropic-ratelimit-unified-reset", "1794700000")
	got := map[string]string{}
	for _, w := range WindowsFromHeaders("claude", h, now) {
		got[w.Kind] = fmt.Sprintf("%.1f@%d", w.Remaining, w.ResetAt.Unix())
	}
	if len(got) != 2 || got["7d"] != "0.6@1794744000" || got["7d_fable"] != "0.0@1794700000" {
		t.Fatalf("windows = %v", got)
	}
	h.Set("anthropic-ratelimit-unified-status", "allowed")
	if ws := WindowsFromHeaders("claude", h, now); len(ws) != 1 {
		t.Fatalf("an answered request named a used-up window: %+v", ws)
	}
}

// The snapshot says which sessions run a fallback, for the ledger, and shows a model's route only
// while the session still asks for that model.
func TestTheSnapshotTellsWhoRunsAFallback(t *testing.T) {
	s, c, in := fableSetup(t, Config{FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5"}})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	s.Route(in)
	snap := s.Build()
	if got := fmt.Sprintf("%+v", snap.Providers["claude"].Fallbacks); got != "[{From:claude-fable-5-2 Model:claude-opus-5-5 Sessions:1}]" {
		t.Fatalf("fallbacks = %s", got)
	}
	if v := snap.Sessions["s1"]; v.Model != "claude-opus-5-5" || v.Route == nil {
		t.Fatalf("the session's next turn = %s, route %+v", v.Model, v.Route)
	}
	// The reader picks Sonnet with /model: its turns run as asked, and nothing says fallback.
	sonnet := in
	sonnet.RequestedModel = "claude-sonnet-5-5"
	s.Route(sonnet)
	snap = s.Build()
	if v := snap.Sessions["s1"]; v.Model != "claude-sonnet-5-5" || v.Route != nil || len(snap.Providers["claude"].Fallbacks) != 0 {
		t.Fatalf("after /model sonnet: next turn %s, route %+v, fallbacks %+v", v.Model, v.Route, snap.Providers["claude"].Fallbacks)
	}
}
