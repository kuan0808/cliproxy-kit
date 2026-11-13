package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

func fallbackState() *core.State {
	s := core.New("route-test", nil)
	s.SetConfig(core.Config{FallbackMap: map[string]string{"claude-fable": "claude-opus-5-5"}})
	s.UpdateInventory([]core.CredInfo{{ID: "a", Provider: "claude"}, {ID: "b", Provider: "claude"}})
	for _, id := range []string{"a", "b"} {
		now := time.Now()
		s.MergePoll(id, "claude", []core.Window{
			{Kind: "7d", Remaining: 0.5, ResetAt: now.Add(24 * time.Hour), ObservedAt: now},
			{Kind: "7d_fable", Remaining: 0, ResetAt: now.Add(24 * time.Hour), ObservedAt: now},
		}, true)
	}
	return s
}

func fableRoute(t *testing.T, body string) pluginapi.ModelRouteResponse {
	t.Helper()
	raw, err := json.Marshal(pluginapi.ModelRouteRequest{
		RequestedModel: "claude-fable-5-2", AvailableProviders: []string{"claude", "codex"},
		Headers: http.Header{"X-Claude-Code-Session-Id": {"s1"}}, Body: []byte(body),
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := route(raw)
	if err != nil {
		t.Fatal(err)
	}
	var env struct{ Result pluginapi.ModelRouteResponse }
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatal(err)
	}
	return env.Result
}

func TestThreadContinuationsCreateFallbackRoutes(t *testing.T) {
	saved := state
	defer func() { state = saved }()
	for _, tc := range []struct {
		name, body string
		turn       bool
	}{
		{"tools", `{"tools":[{"name":"Bash"}]}`, true},
		{"continue", `{"thread":{"type":"continue"}}`, true},
		{"main", `{"thread":{"type":"continue"},"metadata":{"user_id":"{\"agent_id\":\"main\"}"}}`, true},
		{"side", `{"tools":[]}`, false},
		{"agent", `{"thread":{"type":"continue"},"metadata":{"user_id":"{\"agent_id\":\"a1\"}"}}`, false},
		{"parent", `{"thread":{"type":"continue"},"metadata":{"parent_session_id":"p1"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state = fallbackState()
			d := fableRoute(t, tc.body)
			if d.Handled != tc.turn {
				t.Fatalf("route = %+v, main turn = %t", d, tc.turn)
			}
			if !tc.turn {
				if v := state.Build().Sessions["s1"]; v.Route != nil || v.RequestedModel != "" {
					t.Fatalf("a side request changed the conversation: %+v", v)
				}
				return
			}
			if d.Target != "claude" || d.TargetModel != "claude-opus-5-5" {
				t.Fatalf("fallback = %+v", d)
			}
			if v := state.Build().Sessions["s1"]; v.RequestedModel != "claude-fable-5-2" {
				t.Fatalf("requested model not tracked: %+v", v)
			}
			if d := state.Intercept(core.InterceptInput{Session: "s1", RequestedModel: "claude-fable-5-2", Model: "claude-opus-5-5", Thread: "continue"}); !d.Terminate || d.ErrorCode != "thread_unsupported_request" {
				t.Fatalf("thread replay = %+v", d)
			}
			if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled || d.TargetModel != "claude-opus-5-5" {
				t.Fatalf("stateless replay = %+v", d)
			}
		})
	}
}

func TestInterceptRefreshesBoundContinuations(t *testing.T) {
	savedState, savedHost := state, callHost
	defer func() { state, callHost = savedState, savedHost }()
	const model = "claude-opus-5-5"
	for _, binding := range []string{"main", "child", "inherited"} {
		for _, change := range []string{"disabled", "removed", "empty", "failed", "incomplete", "unchanged"} {
			t.Run(binding+"/"+change, func(t *testing.T) {
				now := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
				state = core.New("intercept-test", func() time.Time { return now })
				state.UpdateInventory([]core.CredInfo{{ID: "a", Provider: "claude"}, {ID: "b", Provider: "claude"}})
				state.Observe(core.Usage{Provider: "claude", Model: model, SessionID: "claude:s1", AuthID: "a", RequestedAt: now})
				canonical, parent, owner := "claude:s1", "", "a"
				if binding != "main" {
					canonical, parent = "claude:s1:agent:child", "claude:s1"
					if binding == "child" {
						owner = "b"
						state.Intercept(core.InterceptInput{Session: "s1", Format: "claude", Thread: "create", TraceID: "child"})
						state.Observe(core.Usage{Provider: "claude", Model: model, SessionID: canonical, ParentID: parent,
							AuthID: owner, TraceID: "child", RequestedAt: now})
					}
				}
				files := []pluginapi.HostAuthFileEntry{{ID: "a", AuthIndex: "1", Provider: "claude"}, {ID: "b", AuthIndex: "2", Provider: "claude"}}
				var calls int
				callHost = func(method string, _ any) (json.RawMessage, error) {
					if method != pluginabi.MethodHostAuthList {
						t.Fatalf("unexpected host call %s", method)
					}
					calls++
					if change == "failed" {
						return nil, fmt.Errorf("inventory unavailable")
					}
					return json.Marshal(map[string]any{"files": files})
				}
				raw, err := json.Marshal(pluginapi.RequestInterceptRequest{SourceFormat: "claude", Model: model, RequestedModel: model,
					Body: []byte(`{"thread":{"type":"continue"}}`), Metadata: map[string]any{"canonical_session_id": canonical, "parent_session_id": parent}})
				if err != nil {
					t.Fatal(err)
				}
				run := func() pluginapi.RequestInterceptResponse {
					t.Helper()
					out, err := intercept(raw)
					if err != nil {
						t.Fatal(err)
					}
					var env struct {
						Result pluginapi.RequestInterceptResponse
					}
					if err := json.Unmarshal(out, &env); err != nil {
						t.Fatal(err)
					}
					return env.Result
				}
				if d := run(); d.Terminate || calls != 0 {
					t.Fatalf("fresh inventory: %+v, reads %d", d, calls)
				}
				switch change {
				case "disabled":
					for i := range files {
						files[i].Disabled = files[i].ID == owner
					}
				case "removed":
					for i, file := range files {
						if file.ID == owner {
							files = append(files[:i], files[i+1:]...)
							break
						}
					}
				case "empty":
					files = nil
				case "incomplete":
					files[0].AuthIndex = ""
				}
				now = now.Add(6 * time.Second)
				d := run()
				replay := change == "disabled" || change == "removed" || change == "empty"
				if d.Terminate != replay || calls != 1 {
					t.Fatalf("%s inventory: %+v, reads %d, want replay %v", change, d, calls, replay)
				}
				if replay {
					var body struct {
						Error struct {
							Details struct {
								ErrorCode string `json:"error_code"`
							} `json:"details"`
						} `json:"error"`
					}
					if err := json.Unmarshal(d.ResponseBody, &body); err != nil || d.StatusCode != http.StatusBadRequest || body.Error.Details.ErrorCode != "thread_unsupported_request" {
						t.Fatalf("stateless replay response: %+v, %s", d, d.ResponseBody)
					}
				}
			})
		}
	}
}

func TestIdleRouteRefreshHasABoundedDeadline(t *testing.T) {
	saved := state
	savedPoll := pollTurn
	savedHost := callHost
	defer func() { state, pollTurn, callHost = saved, savedPoll, savedHost }()
	synctest.Test(t, func(t *testing.T) {
		pollTurn = make(chan struct{}, 1)
		state = fallbackState()
		if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled {
			t.Fatalf("initial route = %+v", d)
		}
		pollTurn <- struct{}{}
		defer func() { <-pollTurn }()
		for range 2 {
			time.Sleep(61 * time.Minute)
			started := time.Now()
			d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`)
			if !d.Handled || d.TargetModel != "claude-opus-5-5" || time.Since(started) != 2*time.Second {
				t.Fatalf("refresh deadline: route %+v, elapsed %s", d, time.Since(started))
			}
			synctest.Wait()
			if r := state.Build().Sessions["s1"].Route; r == nil || !r.At.Equal(time.Now()) {
				t.Fatalf("timed-out refresh did not record route activity: %+v", r)
			}
			started = time.Now()
			if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled || time.Since(started) != 0 {
				t.Fatalf("an ordinary routed request polled: %+v", d)
			}
		}
		time.Sleep(61 * time.Minute)
		for _, id := range []string{"a", "b"} {
			now := time.Now()
			state.MergePoll(id, "claude", []core.Window{
				{Kind: "7d", Remaining: 0.5, ResetAt: now.Add(7 * 24 * time.Hour), ObservedAt: now},
				{Kind: "7d_fable", Remaining: 1, ResetAt: now.Add(7 * 24 * time.Hour), ObservedAt: now},
			}, true)
		}
		callHost = func(string, any) (json.RawMessage, error) { return nil, fmt.Errorf("inventory unavailable") }
		started := time.Now()
		if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled || d.TargetModel != "claude-opus-5-5" || time.Since(started) != 0 {
			t.Fatalf("failed inventory recheck did not keep serving the route: %+v", d)
		}
		if r := state.Build().Sessions["s1"].Route; r == nil || !r.At.Equal(time.Now()) {
			t.Fatalf("failed inventory recheck did not record route activity: %+v", r)
		}
		if d := state.Intercept(core.InterceptInput{Session: "s1", RequestedModel: "claude-fable-5-2", Model: "claude-opus-5-5"}); d.Terminate {
			t.Fatalf("kept route stopped the whole-history request: %+v", d)
		}
	})
}

func TestFailedQuotaReadsKeepServingTheRoute(t *testing.T) {
	savedState, savedHost, savedPoll := state, callHost, pollTurn
	savedPolled, savedPlan, savedEmpty := polledAt, planReadAt, emptiedSince
	defer func() {
		state, callHost, pollTurn = savedState, savedHost, savedPoll
		polledAt, planReadAt, emptiedSince = savedPolled, savedPlan, savedEmpty
	}()
	for _, failure := range []string{"inventory", "login"} {
		t.Run(failure, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				state = fallbackState()
				pollTurn = make(chan struct{}, 1)
				polledAt, planReadAt = map[string]time.Time{}, map[string]time.Time{}
				if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled {
					t.Fatalf("initial route = %+v", d)
				}
				time.Sleep(61 * time.Minute)
				var lists, logins atomic.Int32
				callHost = func(method string, _ any) (json.RawMessage, error) {
					if method == pluginabi.MethodHostAuthList {
						lists.Add(1)
						if failure == "inventory" {
							return nil, fmt.Errorf("inventory unavailable")
						}
						return json.Marshal(map[string]any{"files": []pluginapi.HostAuthFileEntry{
							{ID: "a", AuthIndex: "1", Provider: "claude"}, {ID: "b", AuthIndex: "2", Provider: "claude"},
						}})
					}
					logins.Add(1)
					return nil, fmt.Errorf("login unavailable")
				}
				d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`)
				if !d.Handled || d.TargetModel != "claude-opus-5-5" {
					t.Fatalf("failed quota read did not keep serving the route: %+v", d)
				}
				synctest.Wait()
				if lists.Load() != 1 || failure == "login" && logins.Load() != 2 {
					t.Fatalf("quota read repeated or skipped: lists=%d logins=%d", lists.Load(), logins.Load())
				}
				if r := state.Build().Sessions["s1"].Route; r == nil || !r.At.Equal(time.Now()) {
					t.Fatalf("failed quota read did not record route activity: %+v", r)
				}
				if d := state.Intercept(core.InterceptInput{Session: "s1", RequestedModel: "claude-fable-5-2", Model: d.TargetModel}); d.Terminate {
					t.Fatalf("kept route stopped the whole-history request: %+v", d)
				}
			})
		})
	}
}

func TestInventoryRecheckCanRequestABoundedQuotaRefresh(t *testing.T) {
	savedState, savedHost, savedPoll := state, callHost, pollTurn
	defer func() { state, callHost, pollTurn = savedState, savedHost, savedPoll }()
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				model := "claude-opus-5-5"
				if provider == "codex" {
					model = "gpt-6-sol"
				}
				state = fallbackState()
				state.SetConfig(core.Config{CrossProvider: "auto", FallbackMap: map[string]string{"claude-fable": provider + ":" + model}})
				state.UpdateInventory([]core.CredInfo{{ID: "a", Provider: "claude"}, {ID: "b", Provider: "claude"}, {ID: "x", Provider: "codex"}})
				if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled || d.TargetModel != model {
					t.Fatalf("initial route = %+v", d)
				}
				time.Sleep(61 * time.Minute)
				for _, id := range []string{"a", "b"} {
					now := time.Now()
					state.MergePoll(id, "claude", []core.Window{
						{Kind: "7d", Remaining: 0.5, ObservedAt: now},
						{Kind: "7d_fable", Remaining: 0, ObservedAt: now},
						{Kind: "7d_opus", Remaining: 0, ObservedAt: now},
					}, true)
				}
				state.MergePoll("x", "codex", []core.Window{{Kind: "7d", Remaining: 0, ObservedAt: time.Now()}}, false)
				files := []pluginapi.HostAuthFileEntry{
					{ID: "a", AuthIndex: "1", Provider: "claude"}, {ID: "b", AuthIndex: "2", Provider: "claude"},
					{ID: "x", AuthIndex: "3", Provider: "codex"}, {ID: "c", AuthIndex: "4", Provider: "claude"},
				}
				if provider == "codex" {
					files = append(files, pluginapi.HostAuthFileEntry{ID: "y", AuthIndex: "5", Provider: "codex"})
				}
				var calls []string
				callHost = func(method string, _ any) (json.RawMessage, error) {
					calls = append(calls, method)
					return json.Marshal(map[string]any{"files": files})
				}
				pollTurn = make(chan struct{}, 1)
				pollTurn <- struct{}{}
				defer func() { <-pollTurn }()
				started := time.Now()
				d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`)
				if !d.Handled || d.Target != provider || d.TargetModel != model || time.Since(started) != 2*time.Second {
					t.Fatalf("route after inventory added an unread account = %+v, elapsed %s", d, time.Since(started))
				}
				synctest.Wait()
				if len(calls) != 1 || calls[0] != pluginabi.MethodHostAuthList {
					t.Fatalf("host calls = %v, want one inventory recheck", calls)
				}
				if r := state.Build().Sessions["s1"].Route; r == nil || r.Model != model || !r.At.Equal(time.Now()) {
					t.Fatalf("unconfirmed route did not stay active: %+v", r)
				}
				if d := state.Intercept(core.InterceptInput{Session: "s1", RequestedModel: "claude-fable-5-2", Model: d.TargetModel}); d.Terminate {
					t.Fatalf("whole-history request was stopped: %+v", d)
				}
				started = time.Now()
				if d := fableRoute(t, `{"tools":[{"name":"Bash"}]}`); !d.Handled || time.Since(started) != 0 || len(calls) != 1 {
					t.Fatalf("ordinary routed request repeated a read: %+v, calls %v", d, calls)
				}
			})
		})
	}
}
