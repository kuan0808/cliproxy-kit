package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

// codexHook asks what a Codex hook shows, as the README's hook command does.
func codexHook(t *testing.T, key, session, event string) string {
	t.Helper()
	request, _ := json.Marshal(map[string]any{
		"Method": http.MethodGet, "Path": "/v0/resource/plugins/quota-pilot/codex",
		"Headers": http.Header{"Authorization": {"Bearer " + key}, "X-Codex-Session": {session}},
		"Query":   url.Values{"event": {event}},
	})
	out, errHandle := handleMethod(pluginabi.MethodManagementHandle, request)
	if errHandle != nil {
		t.Fatal(errHandle)
	}
	var reply struct {
		Result struct {
			StatusCode int
			Body       []byte
		}
	}
	var hook struct {
		SystemMessage string `json:"systemMessage"`
	}
	if json.Unmarshal(out, &reply) != nil || reply.Result.StatusCode != http.StatusOK || json.Unmarshal(reply.Result.Body, &hook) != nil {
		t.Fatalf("hook answer = %s", out)
	}
	return hook.SystemMessage
}

// A Codex session is told at its start where it runs and how much is used, and after a turn only
// what changed in a way that matters: a window past 80%, used up, or another account.
func TestACodexHookTellsWhatMatters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// A proxy of its own: another test's keyless request would let every key in.
	saved := state
	state = core.New(newBootID(), nil)
	defer func() { state = saved }()
	key, session := "sk-codex", "019f4a1d-0000-7000-8000-0000000000f1"
	codexTold.Lock()
	delete(codexTold.sessions, "codex:"+session)
	codexTold.Unlock()
	if got := codexHook(t, key, session, "SessionStart"); !strings.Contains(got, "once this key has sent a request") {
		t.Fatalf("an unknown key at the start = %q", got)
	}
	if got := codexHook(t, key, session, "Stop"); got != "" {
		t.Fatalf("an unknown key after a turn = %q", got)
	}
	now := time.Now()
	state.UpdateInventory([]core.CredInfo{
		{ID: "codex-alex.json", Provider: "codex", Email: "alex@example.com"},
		{ID: "codex-blair.json", Provider: "codex", Email: "blair@example.com"},
	})
	quota := func(id string, five, weekly float64) {
		state.MergeWindows(id, "codex", []core.Window{
			{Kind: core.KindFiveHour, Remaining: five, ResetAt: now.Add(2 * time.Hour), ObservedAt: time.Now()},
			{Kind: core.KindWeekly, Remaining: weekly, ResetAt: now.Add(3*24*time.Hour + 4*time.Hour + 30*time.Second), ObservedAt: time.Now()},
		})
	}
	quota("codex-alex.json", 0.9, 0.5)
	quota("codex-blair.json", 0.9, 0.6)
	// The session's first request makes its key one the proxy accepted.
	ran := func(id string) {
		state.Observe(core.Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "codex:" + session, AuthID: id, RequestedAt: time.Now(), Output: 10, ClientKey: key})
	}
	ran("codex-alex.json")
	// Its first turn tells what the start could not, while its key was new.
	if got := codexHook(t, key, session, "Stop"); !strings.HasPrefix(got, "quota-pilot: on a••• · 5-hour 10% used") {
		t.Fatalf("the first turn of a new key = %q", got)
	}
	// Another key may not speak for a session this key started; a session not seen yet gets the
	// account a new one would.
	acceptKey("sk-other")
	if got := codexHook(t, "sk-other", session, "SessionStart"); got != "" {
		t.Fatalf("another key's hook = %q", got)
	}
	if got := codexHook(t, "sk-other", "019f4a1d-0000-7000-8000-0000000000f2", "SessionStart"); !strings.HasPrefix(got, "quota-pilot: expected on a•••") ||
		!strings.Contains(got, "weekly 50% used, resets in 3d 4h") {
		t.Fatalf("a new session = %q", got)
	}
	if got := codexHook(t, key, session, "SessionStart"); !strings.HasPrefix(got, "quota-pilot: on a••• · 5-hour 10% used") {
		t.Fatalf("a resumed session = %q", got)
	}
	if got := codexHook(t, key, session, "Stop"); got != "" {
		t.Fatalf("a turn that changed nothing = %q", got)
	}
	quota("codex-alex.json", 0.15, 0.5)
	if got := codexHook(t, key, session, "Stop"); got != "quota-pilot: a••• has used 85% of its 5-hour quota, resets in 2h" {
		t.Fatalf("past 80%% = %q", got)
	}
	// Another window past the mark is told too, the first still past it.
	quota("codex-alex.json", 0.15, 0.15)
	if got := codexHook(t, key, session, "Stop"); got != "quota-pilot: a••• has used 85% of its weekly quota, resets in 3d 4h" {
		t.Fatalf("a second window past 80%% = %q", got)
	}
	if got := codexHook(t, key, session, "Stop"); got != "" {
		t.Fatalf("told again = %q", got)
	}
	quota("codex-alex.json", 0.15, 0)
	if got := codexHook(t, key, session, "Stop"); !strings.HasPrefix(got, "quota-pilot: a••• has used up its weekly quota") {
		t.Fatalf("used up = %q", got)
	}
	// It answers until it refuses; the turn then goes to the other account, as the proxy picks it.
	state.Observe(core.Usage{Provider: "codex", Model: "gpt-6-sol", SessionID: "codex:" + session, AuthID: "codex-alex.json",
		RequestedAt: time.Now(), Failed: true, StatusCode: http.StatusTooManyRequests, ClientKey: key})
	pick := state.Pick(core.PickInput{Provider: "codex", Model: "gpt-6-sol", Canonical: "codex:" + session, Candidates: []core.Candidate{
		{ID: "codex-alex.json", Provider: "codex"}, {ID: "codex-blair.json", Provider: "codex"},
	}})
	ran(pick.AuthID)
	if got := codexHook(t, key, session, "Stop"); !strings.HasPrefix(got, "quota-pilot: moved to b•••") {
		t.Fatalf("moved = %q", got)
	}
}
