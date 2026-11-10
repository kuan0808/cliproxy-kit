package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"testing/synctest"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
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
		RequestedModel: "claude-fable-5-2", AvailableProviders: []string{"claude"},
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

func TestIdleRouteRefreshHasABoundedDeadline(t *testing.T) {
	saved := state
	savedPoll := pollTurn
	defer func() { state, pollTurn = saved, savedPoll }()
	synctest.Test(t, func(t *testing.T) {
		pollTurn = make(chan struct{}, 1)
		state = fallbackState()
		if d := fableRoute(t, `{"thread":{"type":"continue"}}`); !d.Handled {
			t.Fatalf("initial route = %+v", d)
		}
		at := state.Build().Sessions["s1"].Route.At
		time.Sleep(61 * time.Minute)
		pollTurn <- struct{}{}
		defer func() { <-pollTurn }()
		for range 2 {
			started := time.Now()
			d := fableRoute(t, `{"thread":{"type":"continue"}}`)
			if !d.Handled || d.TargetModel != "claude-opus-5-5" || time.Since(started) != 2*time.Second {
				t.Fatalf("refresh deadline: route %+v, elapsed %s", d, time.Since(started))
			}
			synctest.Wait()
			if r := state.Build().Sessions["s1"].Route; r == nil || !r.At.Equal(at) {
				t.Fatalf("timed-out refresh consumed the idle interval: %+v", r)
			}
		}
		for _, id := range []string{"a", "b"} {
			now := time.Now()
			state.MergePoll(id, "claude", []core.Window{
				{Kind: "7d", Remaining: 0.5, ResetAt: now.Add(7 * 24 * time.Hour), ObservedAt: now},
				{Kind: "7d_fable", Remaining: 1, ResetAt: now.Add(7 * 24 * time.Hour), ObservedAt: now},
			}, true)
		}
		started := time.Now()
		if d := fableRoute(t, `{"thread":{"type":"continue"}}`); d.Handled || time.Since(started) != 0 {
			t.Fatalf("recovered source did not return without polling: %+v", d)
		}
	})
}
