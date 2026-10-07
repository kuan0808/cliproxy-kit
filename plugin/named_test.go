package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// acceptKey has the proxy accept key for a request, as its band then reads with it.
func acceptKey(key string) {
	state.Observe(core.Usage{ClientKey: key, RequestedAt: time.Now()})
}

// resetNamed forgets what is held in memory, as a restart does; the file stays as the store loop
// last wrote it (see saveNamed).
func resetNamed() {
	namedMu.Lock()
	defer namedMu.Unlock()
	named, namedDirty = nil, false
}

// band asks for the band's snapshot as the band on another device does, saying what it knows of
// its session in headers, each value escaped as encodeURIComponent does.
func band(t *testing.T, token string, q url.Values) int {
	t.Helper()
	h := http.Header{"Authorization": {"Bearer " + token}, "X-Forwarded-For": {"100.64.0.9"}}
	for k, name := range map[string]string{"session": "X-Band-Session", "title": "X-Band-Title", "cwd": "X-Band-Cwd", "root": "X-Band-Root", "repo": "X-Band-Repo"} {
		if v := q.Get(k); v != "" {
			h.Set(name, strings.ReplaceAll(url.QueryEscape(v), "+", "%20"))
		}
	}
	request, _ := json.Marshal(map[string]any{
		"Method": http.MethodGet, "Path": "/v0/resource/plugins/quota-pilot/band", "Headers": h,
	})
	out, errHandle := handleMethod(pluginabi.MethodManagementHandle, request)
	if errHandle != nil {
		t.Fatal(errHandle)
	}
	var reply struct{ Result struct{ StatusCode int } }
	if errDecode := json.Unmarshal(out, &reply); errDecode != nil {
		t.Fatal(errDecode)
	}
	return reply.Result.StatusCode
}

// A session on another device has its transcript and folders there: the band there tells the
// report its title and where it runs, so it shows by name in its project, marked as elsewhere.
func TestTheBandOnAnotherDeviceNamesItsSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	acceptKey("sk-device")

	id := "0b1c2d3e-0000-4000-8000-000000000001"
	q := url.Values{"session": {id}, "title": {"Fix the login page\x07"}, "cwd": {"/Users/me/dev/app/web"}, "root": {"/Users/me/dev/app"}}
	if code := band(t, "sk-device", q); code != http.StatusOK {
		t.Fatalf("band = %d", code)
	}
	info := sessionMeta(id)
	if info.Title != "Fix the login page" || info.Project != "app" || info.Path != "/Users/me/dev/app" || !info.Repo || info.Origin != "" || !info.Remote {
		t.Fatalf("remote session = %+v", info)
	}
	// A read that says less, as one before the band has read the title, keeps what is known.
	band(t, "sk-device", url.Values{"session": {id}, "cwd": {"/Users/me/dev/app/web"}, "root": {"/Users/me/dev/app"}})
	if info := sessionMeta(id); info.Title != "Fix the login page" || info.Path != "/Users/me/dev/app" {
		t.Fatalf("a read without a title = %+v", info)
	}
	// Kept across restarts.
	saveNamed()
	resetNamed()
	if info := sessionMeta(id); info.Title != "Fix the login page" {
		t.Fatalf("after a restart = %+v", info)
	}

	// Outside a repository the folder it runs in is its project.
	other := "0b1c2d3e-0000-4000-8000-000000000002"
	band(t, "sk-device", url.Values{"session": {other}, "title": {"Notes"}, "cwd": {"/Users/me/notes"}})
	if info := sessionMeta(other); info.Project != "notes" || info.Repo {
		t.Fatalf("outside a repository = %+v", info)
	}

	// Only a band key may name sessions, and only with what a session and a folder can be.
	stranger := "0b1c2d3e-0000-4000-8000-000000000003"
	if code := band(t, "sk-wrong", url.Values{"session": {stranger}, "title": {"x"}, "cwd": {"/x"}}); code != http.StatusUnauthorized {
		t.Fatalf("a wrong key = %d", code)
	}
	band(t, "sk-device", url.Values{"session": {"../../etc"}, "title": {"x"}, "cwd": {"/x"}})
	band(t, "sk-device", url.Values{"session": {stranger}, "title": {strings.Repeat("t", 500)}, "cwd": {"relative/path"}})
	if info := sessionMeta(stranger); info.Path != "" || len([]rune(info.Title)) > 200 {
		t.Fatalf("a bad report = %+v", info)
	}
	if _, ok := namedMeta("../../etc"); ok {
		t.Fatalf("a bad session id was kept")
	}

	// Windows folders, a drive's or a share's, are read with forward slashes.
	win := "0b1c2d3e-0000-4000-8000-000000000004"
	band(t, "sk-device", url.Values{"session": {win}, "cwd": {`C:\work\app\web`}, "root": {`C:\work\app`}})
	if info := sessionMeta(win); info.Path != "C:/work/app" || info.Project != "app" {
		t.Fatalf("a Windows folder = %+v", info)
	}
	unc := "0b1c2d3e-0000-4000-8000-000000000005"
	band(t, "sk-device", url.Values{"session": {unc}, "cwd": {`\\server\share\notes`}})
	if info := sessionMeta(unc); info.Path != "//server/share/notes" || info.Project != "notes" {
		t.Fatalf("a share = %+v", info)
	}
}

// A band on another device switches its own session with a read of /band: by the opaque id its
// snapshot gives the account, acknowledged in the snapshot that read returns. A command for
// another session, or from another key that knows this session's id, is not taken.
func TestABandOnAnotherDeviceSwitchesItsSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	acceptKey("sk-stranger")
	state.UpdateInventory([]core.CredInfo{{ID: "claude-a.json", Provider: "claude"}, {ID: "claude-b.json", Provider: "claude"}})
	read := func(key string, command map[string]any) core.Snapshot {
		h := http.Header{"Authorization": {"Bearer " + key}, "X-Band-Session": {"s9"}}
		if command != nil {
			raw, _ := json.Marshal(command)
			h.Set("X-Band-Command", strings.ReplaceAll(url.QueryEscape(string(raw)), "+", "%20"))
		}
		request, _ := json.Marshal(map[string]any{"Method": http.MethodGet, "Path": "/v0/resource/plugins/quota-pilot/band", "Headers": h})
		out, errHandle := handleMethod(pluginabi.MethodManagementHandle, request)
		if errHandle != nil {
			t.Fatal(errHandle)
		}
		var reply struct{ Result struct{ Body []byte } }
		var snap core.Snapshot
		if json.Unmarshal(out, &reply) != nil || json.Unmarshal(reply.Result.Body, &snap) != nil {
			t.Fatalf("band answer = %s", out)
		}
		return snap
	}
	state.Observe(core.Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s9", AuthID: "claude-a.json", RequestedAt: time.Now(), Output: 10, ClientKey: "sk-device"})
	before := read("sk-device", nil)
	target := "" // the other account, by the opaque id the band sees
	for _, c := range before.Providers["claude"].Credentials {
		if c.ID != before.Sessions["s9"].AuthID {
			target = c.ID
		}
	}
	boot := before.BootID
	read("sk-device", map[string]any{"command_id": "c-other", "session": "s8", "boot_id": boot, "action": "switch", "auth_id": target})
	read("sk-stranger", map[string]any{"command_id": "c-stranger", "session": "s9", "boot_id": boot, "action": "switch", "auth_id": target})
	read("sk-device", map[string]any{"command_id": "c-unknown", "session": "s9", "boot_id": boot, "action": "switch", "auth_id": "claude-b.json"})
	snap := read("sk-device", map[string]any{"command_id": "c1", "session": "s9", "boot_id": boot, "action": "switch", "auth_id": target})
	status := map[string]string{}
	for _, a := range snap.Acks {
		status[a.CommandID] = a.Status
	}
	// The real id of an account is no name for it from a band: only the opaque one is.
	if want := map[string]string{"c-stranger": "rejected", "c-unknown": "rejected", "c1": "applied"}; fmt.Sprint(status) != fmt.Sprint(want) {
		t.Fatalf("acks = %+v", snap.Acks)
	}
	if got := snap.Sessions["s9"]; got == nil || got.AuthID != target || !got.Switched {
		t.Fatalf("session after the switch = %+v", got)
	}
}

// A Codex session has no transcript the proxy can read: its first request says where it runs and
// what it asked, past what Codex adds, and the session is placed like a local one.
func TestACodexSessionIsNamedByItsFirstRequest(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	repo := filepath.Join(t.TempDir(), "web-app")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	os.MkdirAll(filepath.Join(repo, "src"), 0o700)
	text := func(role, s string) map[string]any {
		return map[string]any{"type": "message", "role": role, "content": []map[string]string{{"type": "input_text", "text": s}}}
	}
	first := map[string]any{"model": "gpt-6.1-sol", "input": []any{
		text("developer", "<permissions instructions>\nread-only</permissions instructions>"),
		text("user", "# AGENTS.md instructions\n\n<INSTRUCTIONS>be brief</INSTRUCTIONS>"),
		text("user", "<environment_context>\n  <cwd>"+filepath.Join(repo, "src")+"</cwd>\n  <shell>zsh</shell>\n</environment_context>"),
		text("user", "Add a dark mode toggle\nwith details"),
	}}
	intercept := func(body map[string]any) {
		raw, _ := json.Marshal(body)
		// The host names the session once the account is chosen, so the plugin reads it then.
		request, _ := json.Marshal(pluginapi.RequestInterceptRequest{
			SourceFormat: "openai-response",
			Headers:      http.Header{"Originator": {"codex_exec"}},
			Body:         raw,
			Metadata:     map[string]any{"canonical_session_id": "codex:019f4a1d-9846-7cf3-a482-6dc4bb298d59"},
		})
		if _, errHandle := handleMethod(pluginabi.MethodRequestInterceptAfter, request); errHandle != nil {
			t.Fatal(errHandle)
		}
	}
	intercept(first)
	id := "codex:019f4a1d-9846-7cf3-a482-6dc4bb298d59"
	info := sessionMeta(id)
	if info.Title != "Add a dark mode toggle" || info.Origin != "codex_exec" || info.Project != "web-app" || !info.Repo {
		t.Fatalf("codex session = %+v", info)
	}
	// Later requests carry the same; one that says otherwise does not rename it.
	intercept(map[string]any{"input": []any{text("user", "<environment_context><cwd>/elsewhere</cwd></environment_context>"), text("user", "and the footer")}})
	if info := sessionMeta(id); info.Title != "Add a dark mode toggle" || info.Project != "web-app" {
		t.Fatalf("after a later request = %+v", info)
	}
	// A Claude Code request names nothing: its transcript does.
	intercept(map[string]any{"messages": []any{map[string]string{"role": "user", "content": "hi"}}})

	// A folder on a share or on Windows is kept as said and never looked up (a share's lookup would
	// reach over the network): its project is its folder.
	for i, c := range []struct{ cwd, path string }{
		{`\\server\share\app`, "//server/share/app"}, {"//server/share/app", "//server/share/app"}, {`C:\work\app`, "C:/work/app"},
	} {
		other := fmt.Sprintf("codex:019f4a1d-0000-7000-8000-00000000000%d", i)
		noteRequestSession(other, "openai-response", http.Header{}, mustJSON(t, map[string]any{"input": []any{
			text("user", "<environment_context><cwd>"+c.cwd+"</cwd></environment_context>"), text("user", "Tidy up"),
		}}), time.Now())
		if info := sessionMeta(other); info.Path != c.path || info.Project != "app" || info.Repo || info.Title != "Tidy up" {
			t.Fatalf("a session in %s = %+v", c.cwd, info)
		}
	}
}

// A Codex session on another device runs in its folders, not this machine's: one with the same path
// here is not looked up, and the session shows as elsewhere.
func TestACodexSessionFromAnotherDeviceIsNotLookedUpHere(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	repo := filepath.Join(t.TempDir(), "web-app")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	os.MkdirAll(filepath.Join(repo, "src"), 0o700)
	id := "codex:019f4a1d-0000-7000-8000-0000000000c1"
	body := mustJSON(t, map[string]any{"input": []any{
		map[string]any{"role": "user", "content": "<environment_context><cwd>" + filepath.Join(repo, "src") + "</cwd></environment_context>"},
		map[string]any{"role": "user", "content": "Fix the tests"},
	}})
	noteRequestSession(id, "openai-response", http.Header{"X-Forwarded-For": {"100.64.0.9"}}, body, time.Now())
	if info := sessionMeta(id); !info.Remote || info.Repo || info.Project != "src" {
		t.Fatalf("a session on another device = %+v", info)
	}
}

// What a session said lasts as long as it runs: each request notes it is still seen, written at
// most hourly, though the session is named already.
func TestARunningCodexSessionKeepsItsName(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	id := "codex:019f4a1d-0000-7000-8000-0000000000d1"
	body := mustJSON(t, map[string]any{"input": []any{
		map[string]any{"role": "user", "content": "<environment_context><cwd>/srv/app</cwd></environment_context>"},
		map[string]any{"role": "user", "content": "Fix the tests"},
	}})
	start := time.Now()
	noteRequestSession(id, "openai-response", http.Header{}, body, start)
	noteRequestSession(id, "openai-response", http.Header{}, body, start.Add(time.Minute))
	if at := namedKnown(id).At; at != start.UnixMilli() {
		t.Fatalf("noted again within the hour: at = %d, want %d", at, start.UnixMilli())
	}
	later := start.Add(2 * time.Hour)
	noteRequestSession(id, "openai-response", http.Header{}, body, later)
	if got := namedKnown(id); got.At != later.UnixMilli() || got.Asked != "Fix the tests" {
		t.Fatalf("a session still running = %+v", got)
	}
}

// A Claude Code session is named from its requests too, from whatever machine it runs on: the
// folder in its system prompt, its first message past what Claude Code adds, and how it was run.
// A subagent's task or a side request (no tools) names nothing.
func TestAClaudeCodeSessionIsNamedByItsRequests(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	body := func(first string, tools int) map[string]any {
		return map[string]any{
			"system":   []map[string]string{{"type": "text", "text": "You are Claude Code."}, {"type": "text", "text": "# Environment\n - Primary working directory: /home/me/dev/web-app\n - Platform: linux"}},
			"messages": []any{map[string]any{"role": "user", "content": []map[string]string{{"type": "text", "text": "<system-reminder>notes</system-reminder>"}, {"type": "text", "text": first}}}},
			"tools":    make([]map[string]string, tools),
		}
	}
	intercept := func(id, canonical, ua string, b map[string]any) {
		raw, _ := json.Marshal(b)
		request, _ := json.Marshal(pluginapi.RequestInterceptRequest{
			SourceFormat: "claude",
			Headers:      http.Header{"X-Claude-Code-Session-Id": {id}, "User-Agent": {ua}, "X-Forwarded-For": {"100.64.0.9"}},
			Body:         raw,
			Metadata:     map[string]any{"canonical_session_id": canonical},
		})
		if _, errHandle := handleMethod(pluginabi.MethodRequestInterceptAfter, request); errHandle != nil {
			t.Fatal(errHandle)
		}
	}
	id := "6d046b54-c7fe-46a0-bea9-fa5a79155701"
	intercept(id, "claude:"+id+":agent:a1", "claude-cli/2.1.288 (external, cli)", body("Review the diff", 5))
	intercept(id, "claude:"+id, "claude-cli/2.1.288 (external, cli)", body("Write a title for this", 0))
	if got := namedKnown(id); got.Asked != "" {
		t.Fatalf("a subagent or side request named the session: %+v", got)
	}
	intercept(id, "claude:"+id, "claude-cli/2.1.288 (external, cli)", body("Add rate limiting\nto the API", 20))
	if info := sessionMeta(id); info.Title != "Add rate limiting" || info.Project != "web-app" || !info.Remote || info.Origin != "" {
		t.Fatalf("claude code session = %+v", info)
	}
	sdk := "6d046b54-c7fe-46a0-bea9-fa5a79155702"
	intercept(sdk, "claude:"+sdk, "claude-cli/2.1.288 (external, sdk-py)", body("Summarize the logs", 3))
	if info := sessionMeta(sdk); info.Origin != "sdk-py" {
		t.Fatalf("a program's run = %+v", info)
	}
}

// A first request in string form names its session too; a later one adds a folder still missing
// but keeps the first request's title.
func TestACodexSessionKeepsItsFirstTitle(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	id := "codex:019f4a1d-0000-7000-8000-0000000000b1"
	user := func(s string) map[string]any { return map[string]any{"role": "user", "content": s} }
	noteRequestSession(id, "openai-response", http.Header{}, mustJSON(t, map[string]any{"input": []any{user("Fix the login page")}}), time.Now())
	noteRequestSession(id, "openai-response", http.Header{}, mustJSON(t, map[string]any{"input": []any{
		user("<environment_context><cwd>/srv/app</cwd></environment_context>"), user("Change the footer"),
	}}), time.Now())
	if s := namedKnown(id); s.Asked != "Fix the login page" || s.Cwd != "/srv/app" {
		t.Fatalf("named = %+v", s)
	}
}

// What clients can make the store hold is bounded: past the limit the session said least lately goes.
func TestTheNamedStoreIsBounded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	saved := namedLimit
	namedLimit = 2
	defer func() { namedLimit = saved }()
	now := time.Now()
	for i, id := range []string{"codex:a", "codex:b", "codex:c"} {
		noteSession(id, namedSession{Asked: id}, now.Add(time.Duration(i)*time.Minute))
	}
	saveNamed()
	if _, ok := namedMeta("codex:a"); ok {
		t.Fatal("the oldest session was kept past the limit")
	}
	if _, ok := namedMeta("codex:c"); !ok {
		t.Fatal("the newest session is missing")
	}
}

// A session's first request stays the one first said, whatever comes later; its title is the
// current one, from the band or its transcript, and shows over the first request. The bound holds
// for what is loaded from disk too.
func TestNamesKeepTheirFirstRequestAndTheStoreStaysBounded(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	now := time.Now()
	noteSession("codex:x", namedSession{Asked: "First", Origin: "codex_exec"}, now)
	noteSession("codex:x", namedSession{Asked: "Later", Origin: "codex_exec"}, now)
	noteSession("claude-s", namedSession{Asked: "Fix it", Title: "Old name"}, now)
	noteSession("claude-s", namedSession{Title: "Renamed"}, now)
	a, _ := namedMeta("codex:x")
	b, _ := namedMeta("claude-s")
	if a.Title != "First" || b.Title != "Renamed" || namedKnown("claude-s").Asked != "Fix it" {
		t.Fatalf("titles = %q, %q", a.Title, b.Title)
	}

	saved := namedLimit
	defer func() { namedLimit = saved }()
	stored := map[string]namedSession{}
	for i, id := range []string{"codex:1", "codex:2", "codex:3"} {
		stored[id] = namedSession{Asked: id, Origin: "codex_exec", At: now.Add(time.Duration(i) * time.Minute).UnixMilli()}
	}
	os.WriteFile(namedPath(), mustJSON(t, stored), 0o600)
	resetNamed()
	namedLimit = 2
	if _, ok := namedMeta("codex:1"); ok {
		t.Fatal("the oldest of a store past its bound was loaded")
	}
	saveNamed()
	if body, _ := os.ReadFile(namedPath()); strings.Contains(string(body), "codex:1") {
		t.Fatalf("the file kept it: %s", body)
	}
}

// What 0.1.6 kept in two files is read into the one store, once: a band's session with its
// current title, from another device; one named by its requests with its first request; where a
// session's folder was placed, kept once the folder is gone, without a transcript to say it. A
// file it cannot read stays.
func TestTheStoreTakesWhat016Kept(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	at := time.Now().UnixMilli()
	os.WriteFile(filepath.Join(usageDir(), "projects.json"), mustJSON(t, map[string]any{
		"local-s": map[string]any{"project": "web-app", "path": "/gone/web-app", "repo": true},
	}), 0o600)
	os.WriteFile(filepath.Join(usageDir(), "named-sessions.json"), []byte(`{"band-s": {"title": "Login revamp", "at":`), 0o600)
	resetNamed()
	if info := sessionMeta("local-s"); info.Project != "web-app" || info.Path != "/gone/web-app" || !info.Repo {
		t.Fatalf("a placed session = %+v", info)
	}
	if _, errStat := os.Stat(filepath.Join(usageDir(), "named-sessions.json")); errStat != nil {
		t.Fatal("a file it could not read was removed")
	}
	// Read whole at a later start, into the store written meanwhile.
	saveNamed()
	os.WriteFile(filepath.Join(usageDir(), "named-sessions.json"), mustJSON(t, map[string]any{
		"band-s":  map[string]any{"title": "Login revamp", "cwd": "/Users/me/dev/app", "root": "/Users/me/dev/app", "origin": "remote", "at": at},
		"codex:c": map[string]any{"title": "Fix the tests", "cwd": "/srv/app", "origin": "codex_exec", "at": at},
		"local-s": map[string]any{"title": "Write the docs", "cwd": "/gone/web-app/docs", "origin": "", "at": at},
	}), 0o600)
	resetNamed()
	// What the old file says of a session the store holds fills in what the store lacks.
	if s := namedKnown("local-s"); s.Asked != "Write the docs" || s.Cwd != "/gone/web-app/docs" || s.Place == nil {
		t.Fatalf("a session the store held = %+v", s)
	}
	if s := namedKnown("band-s"); s.Title != "Login revamp" || !s.Remote || s.Origin != "" {
		t.Fatalf("a band's session = %+v", s)
	}
	if s := namedKnown("codex:c"); s.Title != "" || s.Asked != "Fix the tests" || s.Origin != "codex_exec" {
		t.Fatalf("a session named by its requests = %+v", s)
	}
	if info := sessionMeta("local-s"); info.Project != "web-app" {
		t.Fatalf("what the store held = %+v", info)
	}
	for _, old := range []string{"named-sessions.json", "projects.json"} {
		if _, errStat := os.Stat(filepath.Join(usageDir(), old)); errStat == nil {
			t.Fatalf("%s is still there", old)
		}
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, errMarshal := json.Marshal(v)
	if errMarshal != nil {
		t.Fatal(errMarshal)
	}
	return raw
}

// What another device said is kept as long as the usage log, and no longer, read or not.
func TestAnotherDevicesSessionsLastAsLongAsTheLog(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	now := time.Now()
	noteBandSession(bandValues("0b1c2d3e-0000-4000-8000-0000000000a1", "Old", "/x/old"), now.AddDate(0, -usageMonths, -1))
	noteBandSession(bandValues("0b1c2d3e-0000-4000-8000-0000000000a2", "Recent", "/x/recent"), now.AddDate(0, 0, -40))
	saveNamed()
	resetNamed()
	if _, ok := namedMeta("0b1c2d3e-0000-4000-8000-0000000000a1"); ok {
		t.Fatalf("a session older than the log was kept")
	}
	if info, ok := namedMeta("0b1c2d3e-0000-4000-8000-0000000000a2"); !ok || info.Title != "Recent" {
		t.Fatalf("a 40-day-old session = %+v %v", info, ok)
	}
	// Gone from the file too at the store loop's next pass, though no band has written since.
	saveNamed()
	body, _ := os.ReadFile(namedPath())
	if strings.Contains(string(body), "0b1c2d3e-0000-4000-8000-0000000000a1") || !strings.Contains(string(body), "Recent") {
		t.Fatalf("file after loading = %s", body)
	}
}

func bandValues(id, title, cwd string) http.Header {
	return http.Header{"X-Band-Session": {id}, "X-Band-Title": {url.PathEscape(title)}, "X-Band-Cwd": {url.PathEscape(cwd)}}
}

// A band that names its session's repository root wins over a folder of the same path here: a
// client reaching the proxy directly is not told apart from this machine.
func TestTheBandsRepositoryRootWinsOverAFolderHere(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetNamed()
	dir := filepath.Join(t.TempDir(), "work", "app")
	os.MkdirAll(filepath.Join(dir, "src"), 0o700)
	id := "0b1c2d3e-0000-4000-8000-0000000000c3"
	noteSession(id, namedSession{Title: "Ship it", Cwd: filepath.Join(dir, "src"), Root: dir, Placed: true}, time.Now())
	if info := sessionMeta(id); info.Path != dir || !info.Repo || info.Project != "app" {
		t.Fatalf("a band's repository = %+v", info)
	}
	// Inside a repository of this machine that is not its own, it stays where its band put it.
	os.MkdirAll(filepath.Join(filepath.Dir(dir), ".git"), 0o700)
	if info := sessionMeta(id); info.Path != dir || !info.Repo {
		t.Fatalf("a repository here = %+v", info)
	}
	// A band outside any repository says only its folder: that is where it is, all the same.
	notes := "0b1c2d3e-0000-4000-8000-0000000000c4"
	noteSession(notes, namedSession{Title: "Notes", Cwd: filepath.Join(dir, "src"), Placed: true}, time.Now())
	if info := sessionMeta(notes); info.Path != filepath.Join(dir, "src") || info.Repo {
		t.Fatalf("a band's folder = %+v", info)
	}
	// One whose transcript is here ran here: its folder places it.
	noteSession(id, namedSession{Here: true}, time.Now())
	if info := sessionMeta(id); info.Path != filepath.Dir(dir) || !info.Repo {
		t.Fatalf("a session that ran here = %+v", info)
	}
}
