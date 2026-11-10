package core

import (
	"encoding/json"
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

func TestSnapshotResolvesManualFallbackOffersWithZeroResets(t *testing.T) {
	for _, mode := range []string{"off", "auto"} {
		for _, tc := range []struct{ source, sourceKind, target, kind string }{
			{fable, "7d_fable", "claude-opus-5-5", "5h"},
			{fable, "7d_fable", "claude-opus-5-5", "7d"},
			{fable, "7d_fable", "claude-opus-5-5", "7d_opus"},
			{fable, "7d_fable", "claude-sonnet-5-5", "7d_sonnet"},
			{"claude-opus-5-5", "7d_opus", fable, "7d_fable"},
		} {
			t.Run(mode+"/"+tc.kind, func(t *testing.T) {
				s, c := newTestState()
				s.UpdateInventory(inventory)
				s.SetConfig(Config{CrossProvider: mode, FallbackMap: map[string]string{
					tc.source: tc.target, tc.target: "codex:gpt-6-sol",
				}})
				for _, id := range []string{"claude-a", "claude-b"} {
					s.MergePoll(id, "claude", []Window{{Kind: "7d", Remaining: 0.5, ObservedAt: c.t}}, false)
				}
				s.MergePoll("codex-a", "codex", []Window{{Kind: "7d", Remaining: 0.5, ObservedAt: c.t}}, false)
				in := RouteInput{Session: "s1", RequestedModel: tc.source, Available: []string{"claude", "codex"}, Turn: true}
				if d := s.Route(in); d.Handled {
					t.Fatalf("a healthy source was routed: %+v", d)
				}
				for _, id := range []string{"claude-a", "claude-b"} {
					s.MergeWindows(id, "claude", []Window{{Kind: tc.sourceKind, Remaining: 0, ObservedAt: c.t}})
				}
				if v := s.Build().Sessions["s1"]; v.Fallback == nil || *v.Fallback != (FallbackOffer{Provider: "claude", Model: tc.target}) {
					t.Fatalf("skipped a target that can still serve: %+v", v.Fallback)
				}
				for _, id := range []string{"claude-a", "claude-b"} {
					s.MergeWindows(id, "claude", []Window{{Kind: tc.kind, Remaining: 0, ObservedAt: c.t}})
				}
				raw, err := json.Marshal(s.BuildForBand("s1", tc.source, ""))
				if err != nil {
					t.Fatal(err)
				}
				var wire struct {
					Sessions map[string]struct {
						Fallback *FallbackOffer `json:"fallback"`
						Route    *Route         `json:"route"`
					} `json:"sessions"`
					Providers map[string]struct {
						Credentials []struct {
							Windows []struct {
								Kind    string `json:"kind"`
								ResetAt string `json:"reset_at"`
							} `json:"windows"`
						} `json:"credentials"`
					} `json:"providers"`
				}
				if err := json.Unmarshal(raw, &wire); err != nil {
					t.Fatal(err)
				}
				v := wire.Sessions["s1"]
				if v.Fallback == nil || *v.Fallback != (FallbackOffer{Provider: "codex", Model: "gpt-6-sol"}) || v.Route != nil {
					t.Fatalf("manual offer with %s: %s", mode, raw)
				}
				zeroes := 0
				for _, cred := range wire.Providers["claude"].Credentials {
					for _, w := range cred.Windows {
						if w.Kind == tc.kind && w.ResetAt == "0001-01-01T00:00:00Z" {
							zeroes++
						}
					}
				}
				if zeroes != 2 {
					t.Fatalf("serialized snapshot lost unset %s resets: %s", tc.kind, raw)
				}
				if d := s.Route(in); d.Handled != (mode == "auto") || d.Handled && (d.Provider != "codex" || d.Model != "gpt-6-sol") {
					t.Fatalf("manual offer changed automatic policy: %+v", d)
				}
			})
		}
	}
}

func TestSnapshotOmitsUnavailableManualFallbacks(t *testing.T) {
	for _, mode := range []string{"off", "auto"} {
		for _, reason := range []string{"healthy", "one account available", "unknown", "all targets exhausted", "no account", "no map", "cycle"} {
			t.Run(mode+"/"+reason, func(t *testing.T) {
				cfg := Config{CrossProvider: mode, FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5", "claude": "codex:gpt-6-sol"}}
				s, c, in := fableSetup(t, cfg)
				s.Route(in)
				if reason != "healthy" && reason != "unknown" {
					fableLeft(s, c, "claude-a", 0)
					if reason != "one account available" {
						fableLeft(s, c, "claude-b", 0)
					}
				}
				switch reason {
				case "unknown":
					c.add(26 * time.Minute)
				case "all targets exhausted", "no account", "cycle":
					for _, id := range []string{"claude-a", "claude-b"} {
						weeklyOnly(s, c, id, 0, 3*24*time.Hour)
					}
					if reason == "all targets exhausted" {
						s.MergeWindows("codex-a", "codex", []Window{{Kind: "7d", Remaining: 0, ObservedAt: c.t}})
					} else if reason == "no account" {
						s.UpdateInventory([]CredInfo{{ID: "claude-a", Provider: "claude"}, {ID: "claude-b", Provider: "claude"}})
					} else {
						cfg.FallbackMap["claude"] = fable
						s.SetConfig(cfg)
					}
				case "no map":
					s.SetConfig(Config{CrossProvider: mode})
				}
				if v := s.Build().Sessions["s1"]; v.Fallback != nil {
					t.Fatalf("%s offered a fallback: %+v", reason, v.Fallback)
				}
			})
		}
	}
}

func TestManualOfferLeavesContextFitToTheRoute(t *testing.T) {
	s, c, in := fableSetup(t, Config{FallbackMap: map[string]string{"claude-fable": "codex:proxy-model"}})
	s.Route(in)
	s.Observe(Usage{Provider: "claude", Model: fable, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	if v := s.Build().Sessions["s1"]; v.Fallback == nil || *v.Fallback != (FallbackOffer{Provider: "codex", Model: "proxy-model"}) {
		t.Fatalf("context check suppressed the manual offer: %+v", v.Fallback)
	}
	ack := s.Apply(Command{CommandID: "offer", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "proxy-model"})
	if ack.Status != "applied" {
		t.Fatalf("manual route command: %+v", ack)
	}
	if d := s.Route(in); d.Handled {
		t.Fatalf("route ran without a known context size: %+v", d)
	}
	if d := s.Intercept(InterceptInput{Session: "s1", RequestedModel: fable, Model: fable}); !d.Terminate {
		t.Fatalf("unfitted manual route returned to the source: %+v", d)
	}
}

func TestExplicitProviderAliasesPassTheRouteIntercept(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			s, c, in := fableSetup(t, Config{CrossProvider: "auto",
				FallbackMap: map[string]string{"claude-fable": provider + ":team-opus"}, ContextLengths: map[string]int{"team-opus": 1000000}})
			fableLeft(s, c, "claude-a", 0)
			fableLeft(s, c, "claude-b", 0)
			if d := s.Route(in); !d.Handled || d.Provider != provider || d.Model != "team-opus" {
				t.Fatalf("alias route = %+v", d)
			}
			for _, tc := range []struct {
				model string
				stop  bool
			}{{"team-opus", false}, {"TEAM-OPUS", false}, {fable, true}, {"gpt-6-sol", true}} {
				if d := s.Intercept(InterceptInput{Session: "s1", RequestedModel: fable, Model: tc.model}); d.Terminate != tc.stop {
					t.Fatalf("intercept model %s = %+v, want stop=%t", tc.model, d, tc.stop)
				}
			}
			if d := s.Intercept(InterceptInput{Session: "s1", RequestedModel: fable, Model: "team-opus", Thread: "continue"}); !d.Terminate || d.ErrorCode != threadUnsupported {
				t.Fatalf("alias thread continuation = %+v", d)
			}
		})
	}
}

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

func TestFallbackChainsKeepExplicitProviders(t *testing.T) {
	for _, mode := range []string{"off", "auto"} {
		t.Run(mode, func(t *testing.T) {
			s, c, in := fableSetup(t, Config{CrossProvider: mode, FallbackMap: map[string]string{
				"claude-fable": "codex:proxy-model", "codex": "claude-opus-5-5",
			}})
			s.Route(in)
			s.Observe(Usage{Provider: "claude", Model: fable, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t})
			for _, id := range []string{"claude-a", "claude-b"} {
				fableLeft(s, c, id, 0)
			}
			s.MergePoll("codex-a", "codex", []Window{{Kind: "7d", Remaining: 0, ObservedAt: c.t}}, false)
			if v := s.BuildForBand("s1", fable, "").Sessions["s1"]; v.Fallback == nil || *v.Fallback != (FallbackOffer{Provider: "claude", Model: "claude-opus-5-5"}) {
				t.Fatalf("manual offer lost the intermediate provider: %+v", v.Fallback)
			}
			if d := s.Route(in); d.Handled != (mode == "auto") || d.Handled && (d.Provider != "claude" || d.Model != "claude-opus-5-5") {
				t.Fatalf("automatic chain lost the intermediate provider: %+v", d)
			}
			if a := s.Apply(Command{CommandID: "custom", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "route", Provider: "codex", Model: "proxy-model"}); a.Status != "applied" {
				t.Fatalf("custom route = %+v", a)
			}
			if v := s.BuildForBand("s1", fable, "").Sessions["s1"]; v.Provider != "codex" || v.Model != "proxy-model" || v.Fallback == nil || *v.Fallback != (FallbackOffer{Provider: "claude", Model: "claude-opus-5-5"}) {
				t.Fatalf("snapshot lost its known provider: %+v", v)
			}
		})
	}
}

func TestAttemptedRouteReadsAlwaysFinalize(t *testing.T) {
	for _, target := range []string{"claude-opus-5-5", "codex:gpt-6-sol"} {
		for _, inventoryFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/inventoryFirst=%t", target, inventoryFirst), func(t *testing.T) {
				s, c, in := fableSetup(t, Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude-fable": target}})
				for _, id := range []string{"claude-a", "claude-b"} {
					fableLeft(s, c, id, 0)
				}
				initial := s.Route(in)
				if !initial.Handled {
					t.Fatalf("initial route = %+v", initial)
				}
				c.add(61 * time.Minute)
				if inventoryFirst {
					weeklyOnly(s, c, "claude-a", 0.5, 7*24*time.Hour)
					fableLeft(s, c, "claude-a", 1)
					if d := s.Route(in); !d.Recheck || d.Refresh {
						t.Fatalf("first read = %+v, want inventory", d)
					}
					list := append([]CredInfo{}, inventory...)
					list[0].Disabled = true
					list = append(list, CredInfo{ID: "new-account", Provider: "claude"})
					s.UpdateInventory(list)
					in.InventoryRead = "done"
					if d := s.Route(in); !d.Refresh || d.Recheck {
						t.Fatalf("second read = %+v, want quota", d)
					}
					in.QuotaRead = "failed"
				} else {
					if d := s.Route(in); !d.Refresh || d.Recheck {
						t.Fatalf("first read = %+v, want quota", d)
					}
					weeklyOnly(s, c, "claude-a", 0.5, 7*24*time.Hour)
					fableLeft(s, c, "claude-a", 1)
					in.QuotaRead = "done"
					if d := s.Route(in); !d.Recheck || d.Refresh {
						t.Fatalf("second read = %+v, want inventory", d)
					}
					in.InventoryRead = "failed"
				}
				if d := s.Route(in); !d.Handled || d.Refresh || d.Recheck || d.Provider != initial.Provider || d.Model != initial.Model {
					t.Fatalf("attempted reads left an unfinished route: %+v", d)
				}
				if r := routeOf(s); r == nil || !r.At.Equal(c.t) {
					t.Fatalf("kept route did not advance: %+v", r)
				}
				if d := s.Intercept(InterceptInput{Session: "s1", RequestedModel: fable, Model: initial.Model}); d.Terminate {
					t.Fatalf("kept route stopped the whole-history request: %+v", d)
				}
			})
		}
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
				if d := s.Route(in); d.Handled || !d.Refresh {
					t.Fatalf("stale quota after rest = %+v", d)
				}
				if r := routeOf(s); r == nil || !r.At.Equal(at) {
					t.Fatalf("route finalized before reading quota: %+v", r)
				}
				left := 0.0
				if recovered {
					left = 1
				}
				for _, id := range []string{"claude-a", "claude-b"} {
					weeklyOnly(s, c, id, 0.5, 3*24*time.Hour)
					fableLeft(s, c, id, left)
				}
				in.QuotaRead = "done"
				s.UpdateInventory(inventory)
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

func TestActiveFallbacksSurviveQuotaReadTimeoutsAndRestarts(t *testing.T) {
	for _, target := range []string{"claude-opus-5-5", "codex:gpt-6-sol"} {
		t.Run(target, func(t *testing.T) {
			s, c, in := fableSetup(t, Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude-fable": target}})
			fableLeft(s, c, "claude-a", 0)
			fableLeft(s, c, "claude-b", 0)
			if d := s.Route(in); !d.Handled {
				t.Fatalf("initial route = %+v", d)
			}
			for range 26 {
				c.add(61 * time.Minute)
				if d := s.Route(in); !d.Refresh {
					t.Fatalf("idle route did not request a reading: %+v", d)
				}
				s.TakeDirty()
				in.QuotaRead = "failed"
				if d := s.Route(in); !d.Handled || d.Refresh {
					t.Fatalf("timeout did not finalize the routed request: %+v", d)
				}
				in.QuotaRead = ""
				if !s.TakeDirty() {
					t.Fatal("route activity was not marked for saving")
				}
				s.Sweep()
				if r := routeOf(s); r == nil || !r.At.Equal(c.t) {
					t.Fatalf("Sweep discarded active fallback: %+v", r)
				}
				next := New("restarted", c.now)
				next.SetConfig(s.Config())
				next.Import(s.Export())
				s = next
				s.UpdateInventory(inventory)
				if r := routeOf(s); r == nil || !r.At.Equal(c.t) {
					t.Fatalf("Import discarded active fallback: %+v", r)
				}
			}
			saved := s.Export()
			c.add(24*time.Hour + time.Second)
			s.Sweep()
			if r, ok := s.Export().Routes["claude:s1"]; ok {
				t.Fatalf("unused automatic route did not expire: %+v", r)
			}
			next := New("expired", c.now)
			next.SetConfig(s.Config())
			next.Import(saved)
			if r, ok := next.Export().Routes["claude:s1"]; ok {
				t.Fatalf("Import restored an expired automatic route: %+v", r)
			}
		})
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
		s.UpdateInventory(inventory)
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

func TestAutomaticRouteChangesWaitForFreshInventory(t *testing.T) {
	for _, target := range []string{"claude-opus-5-5", "codex:gpt-6-sol"} {
		for _, replace := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/replace=%t", target, replace), func(t *testing.T) {
				s, c, in := fableSetup(t, Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude-fable": target}})
				for _, id := range []string{"claude-a", "claude-b"} {
					fableLeft(s, c, id, 0)
				}
				if d := s.Route(in); !d.Handled {
					t.Fatalf("initial route = %+v", d)
				}
				before := *routeOf(s)
				c.add(time.Minute)
				if !replace {
					c.add(time.Hour)
				}
				for _, id := range []string{"claude-a", "claude-b"} {
					weeklyOnly(s, c, id, 0.5, 3*24*time.Hour)
					left := 0.0
					if !replace && id == "claude-a" {
						left = 1
					}
					fableLeft(s, c, id, left)
					if replace && before.Provider == "claude" {
						s.MergeWindows(id, "claude", []Window{{Kind: "7d_opus", Remaining: 0, ObservedAt: c.t}})
					}
				}
				list := append([]CredInfo{}, inventory...)
				if replace {
					if before.Provider == "codex" {
						s.MergePoll("codex-a", "codex", []Window{{Kind: "7d", Remaining: 0, ObservedAt: c.t}}, false)
					}
					list = append(list, CredInfo{ID: "new-account", Provider: before.Provider})
				} else {
					list[0].Disabled = true
				}
				if d := s.Route(in); !d.Recheck || d.Handled || d.Refresh {
					t.Fatalf("stale inventory did not stop route change: %+v", d)
				}
				if r := routeOf(s); r == nil || *r != before {
					t.Fatalf("route changed before inventory was read: %+v", r)
				}
				s.UpdateInventory(list)
				if d := s.Route(in); !d.Handled || d.Recheck || d.Refresh || d.Model != before.Model || d.Provider != before.Provider {
					t.Fatalf("fresh inventory did not preserve the working route: %+v", d)
				}
			})
		}
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

func TestBandOmitsManagementFallbackActivityAcrossClientKeys(t *testing.T) {
	s, c, in := fableSetup(t, Config{FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5"}})
	s.Observe(Usage{Provider: "claude", Model: fable, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t, ClientKey: "sk-a"})
	s.Observe(Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s2", AuthID: "claude-b", RequestedAt: c.t, ClientKey: "sk-b"})
	fableLeft(s, c, "claude-a", 0)
	fableLeft(s, c, "claude-b", 0)
	if d := s.Route(in); !d.Handled || d.Model != "claude-opus-5-5" {
		t.Fatalf("initial fallback = %+v", d)
	}
	for _, q := range []struct {
		session, key string
		own          bool
	}{
		{"s1", "sk-b", false},
		{"s2", "sk-b", true},
		{"s1", "sk-a", true},
		{"", "sk-b", false},
	} {
		client, ok := s.Client(q.key)
		if !ok {
			t.Fatalf("client key was not accepted: %s", q.key)
		}
		band := s.BuildForBand(q.session, fable, client)
		if q.own {
			if band.Sessions[q.session] == nil {
				t.Fatalf("own session was hidden: %+v", band.Sessions)
			}
			if q.session == "s1" && (band.Sessions["s1"].Route == nil || band.Sessions["s1"].Route.Model != "claude-opus-5-5") {
				t.Fatalf("own route was hidden: %+v", band.Sessions["s1"])
			}
		} else if len(band.Sessions) != 0 {
			t.Fatalf("another client's session was disclosed: %+v", band.Sessions)
		}
		raw, err := json.Marshal(band)
		if err != nil {
			t.Fatal(err)
		}
		var wire struct {
			Providers map[string]map[string]json.RawMessage `json:"providers"`
		}
		if err := json.Unmarshal(raw, &wire); err != nil {
			t.Fatal(err)
		}
		for provider, view := range wire.Providers {
			if _, present := view["fallbacks"]; present {
				t.Fatalf("/band disclosed %s fallback activity to %s: %s", provider, q.key, raw)
			}
		}
	}
	got := s.Build().Providers["claude"].Fallbacks
	if len(got) != 1 || got[0] != (FallbackView{From: fable, Model: "claude-opus-5-5", Sessions: 1}) {
		t.Fatalf("management lost its fallback aggregate: %+v", got)
	}
}
