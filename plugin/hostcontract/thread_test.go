package hostcontract

// A Claude message thread through the plugin itself. From CLIProxyAPI 8.0.68 the proxy sends a
// request that continues a thread (`thread.type: continue`) only to the account that answered the
// message it continues, and offers the pick that account alone: a move quota-pilot made since
// would be undone, or the request would fail when that account cannot serve. So quota-pilot answers
// such a continuation `400 thread_unsupported_request` once the session should run elsewhere, and
// Claude Code sends the turn again without the thread, which goes where quota-pilot chooses.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// turn sends one streaming main turn of the session, with `thread` as the request's message thread
// ("" for none), and returns the status, the body and the id of the message it answered with.
func turn(t *testing.T, session, thread string) (int, string, string) {
	t.Helper()
	return turnWithIdentity(t, http.Header{"X-Claude-Code-Session-Id": {session}}, nil, thread)
}

func turnWithIdentity(t *testing.T, headers http.Header, metadata map[string]any, thread string) (int, string, string) {
	t.Helper()
	extra := ""
	if thread != "" {
		extra = `,"thread":` + thread
	}
	if metadata != nil {
		raw, err := json.Marshal(metadata)
		if err != nil {
			t.Fatal(err)
		}
		extra += `,"metadata":` + string(raw)
	}
	body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}],`+
		`"tools":[{"name":"Read","description":"Reads a file","input_schema":{"type":"object"}}]%s}`, model, extra)
	req, _ := http.NewRequest(http.MethodPost, proxy.url+"/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("Content-Type", "application/json")
	for key, values := range headers {
		req.Header[key] = values
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	id := ""
	if m := regexp.MustCompile(`"id":"(msg_[^"]+)"`).FindStringSubmatch(string(out)); m != nil {
		id = m[1]
	}
	return resp.StatusCode, string(out), id
}

func continuing(id string) string {
	return fmt.Sprintf(`{"type":"continue","previous_message_id":%q}`, id)
}

// threadUnsupported reports whether a response is the 400 that makes Claude Code send the turn
// again without its thread.
func threadUnsupported(status int, body string) bool {
	var doc struct {
		Error struct {
			Details struct {
				ErrorCode string `json:"error_code"`
			} `json:"details"`
		} `json:"error"`
	}
	return status == http.StatusBadRequest && json.Unmarshal([]byte(body), &doc) == nil &&
		doc.Error.Details.ErrorCode == "thread_unsupported_request"
}

// switchTo sends the band's switch of the session to the account, as the band sends it with a read
// of its snapshot; the band names an account by the id the snapshot gives it.
func switchTo(t *testing.T, session, name string) {
	t.Helper()
	snap, err := band(session)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(idOf(name)))
	cmd, _ := json.Marshal(map[string]any{"command_id": "switch-" + session, "session": session, "boot_id": snap.BootID,
		"created_at": time.Now().UTC().Format(time.RFC3339Nano), "action": "switch", "auth_id": hex.EncodeToString(sum[:8])})
	req, _ := http.NewRequest(http.MethodGet, proxy.url+"/v0/resource/plugins/quota-pilot/band", nil)
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("X-Band-Session", session)
	req.Header.Set("X-Band-Command", string(cmd))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var after struct {
		Acks []struct {
			CommandID string `json:"command_id"`
			Status    string `json:"status"`
		} `json:"acks"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&after)
	if !slices.ContainsFunc(after.Acks, func(a struct {
		CommandID string `json:"command_id"`
		Status    string `json:"status"`
	}) bool {
		return a.CommandID == "switch-"+session && a.Status == "applied"
	}) {
		t.Fatalf("the switch to %s was not applied: %+v", name, after.Acks)
	}
}

func idOf(name string) string {
	for id, n := range proxy.names {
		if n == name {
			return id
		}
	}
	return ""
}

// startThread opens a thread in a new session and returns the session, the account that answered
// it (the one quota-pilot bound the session to) and the id of the message to continue.
func startThread(t *testing.T) (session, bound, message string) {
	t.Helper()
	proxy.manager.SetRetryConfig(3, 30*time.Second, 0)
	session = fmt.Sprintf("00000000-0000-4000-8000-%012d", sessions.Add(1))
	status, body, id := turn(t, session, `{"type":"create"}`)
	attempts := proxy.upstream.take()
	if status != http.StatusOK || id == "" || len(attempts) != 1 {
		t.Fatalf("the thread's first turn: %d %s, attempts %v", status, body, attempts)
	}
	waitForUsage(t, session)
	return session, attempts[0], id
}

func TestAContinuationOfAThreadOnTheBoundAccountRunsThere(t *testing.T) {
	session, bound, id := startThread(t)
	status, body, next := turn(t, session, continuing(id))
	if attempts := proxy.upstream.take(); status != http.StatusOK || next == "" || !slices.Equal(attempts, []string{bound}) {
		t.Fatalf("continuation: %d %s, attempts %v, want %s's answer", status, body, attempts, bound)
	}
}

func TestAfterTheUsersSwitchAContinuationIsSentAgainWithoutItsThread(t *testing.T) {
	session, bound, id := startThread(t)
	other := "B"
	if bound == "B" {
		other = "C"
	}
	switchTo(t, session, other)
	status, body, _ := turn(t, session, continuing(id))
	if attempts := proxy.upstream.take(); !threadUnsupported(status, body) || len(attempts) != 0 {
		t.Fatalf("continuation after the switch: %d %s, attempts %v; want 400 thread_unsupported_request before any attempt", status, body, attempts)
	}
	// Claude Code sends the turn again without the thread: it goes to the account switched to.
	status, body, _ = turn(t, session, "")
	if attempts := proxy.upstream.take(); status != http.StatusOK || !slices.Equal(attempts, []string{other}) {
		t.Fatalf("the turn sent again: %d %s, attempts %v, want %s", status, body, attempts, other)
	}
}

func TestAfterTheBoundAccountFailsAContinuationIsSentAgainWithoutItsThread(t *testing.T) {
	session, bound, id := startThread(t)
	// A 529 cools the account for a minute, and the proxy runs no further round for it.
	proxy.upstream.fail(bound, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(529)
		_, _ = fmt.Fprint(w, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)
	})
	status, body, _ := turn(t, session, continuing(id))
	if attempts := proxy.upstream.take(); status != 529 || !slices.Equal(attempts, []string{bound}) {
		t.Fatalf("the continuation that failed: %d %s, attempts %v", status, body, attempts)
	}
	waitForUsage(t, session)
	status, body, _ = turn(t, session, continuing(id))
	if attempts := proxy.upstream.take(); !threadUnsupported(status, body) || len(attempts) != 0 {
		t.Fatalf("Claude Code's next try of the continuation: %d %s, attempts %v; want 400 thread_unsupported_request", status, body, attempts)
	}
	status, body, _ = turn(t, session, "")
	if attempts := proxy.upstream.take(); status != http.StatusOK || len(attempts) != 1 || attempts[0] == bound {
		t.Fatalf("the turn sent again: %d %s, attempts %v, want another account than %s", status, body, attempts, bound)
	}
}

func TestAChildContinuationChecksItsOwnBindingBeforeAuth(t *testing.T) {
	session, bound, _ := startThread(t)
	headers := http.Header{"X-Claude-Code-Session-Id": {session}, "X-Claude-Code-Agent-Id": {"child"},
		"X-Claude-Code-Parent-Agent-Id": {"parent"}}
	status, body, child := turnWithIdentity(t, headers, nil, `{"type":"create"}`)
	if attempts := proxy.upstream.take(); status != http.StatusOK || child == "" || !slices.Equal(attempts, []string{bound}) {
		t.Fatalf("child thread: %d %s, attempts %v, want %s", status, body, attempts, bound)
	}
	waitForUsage(t, session)
	other := "B"
	if bound == other {
		other = "C"
	}
	switchTo(t, session, other)
	status, body, parent := turn(t, session, `{"type":"create"}`)
	if attempts := proxy.upstream.take(); status != http.StatusOK || parent == "" || !slices.Equal(attempts, []string{other}) {
		t.Fatalf("parent's new thread: %d %s, attempts %v, want %s", status, body, attempts, other)
	}
	waitForUsage(t, session)
	proxy.upstream.fail(bound, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(529)
		_, _ = fmt.Fprint(w, `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)
	})
	status, body, _ = turnWithIdentity(t, headers, nil, continuing(child))
	if attempts := proxy.upstream.take(); status != 529 || !slices.Equal(attempts, []string{bound}) {
		t.Fatalf("child's failure: %d %s, attempts %v", status, body, attempts)
	}
	waitForUsage(t, session)
	user, _ := json.Marshal(map[string]string{"session_id": session, "agent_id": "child", "parent_agent_id": "parent"})
	for _, tc := range []struct {
		name     string
		headers  http.Header
		metadata map[string]any
	}{
		{name: "headers", headers: headers},
		{name: "header with body agent", headers: http.Header{"X-Claude-Code-Session-Id": {session}}, metadata: map[string]any{"user_id": string(user)}},
		{name: "JSON user id", metadata: map[string]any{"user_id": string(user)}},
		{name: "legacy user id", metadata: map[string]any{"user_id": "user_test_account_test_session_" + session, "subagent_id": "child", "parent_agent_id": "parent"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body, _ := turnWithIdentity(t, tc.headers, tc.metadata, continuing(child))
			if attempts := proxy.upstream.take(); !threadUnsupported(status, body) || len(attempts) != 0 {
				t.Fatalf("child continuation: %d %s, attempts %v; want 400 thread_unsupported_request before any attempt", status, body, attempts)
			}
		})
	}
	status, body, _ = turn(t, session, continuing(parent))
	if attempts := proxy.upstream.take(); status != http.StatusOK || !slices.Equal(attempts, []string{other}) {
		t.Fatalf("healthy parent continuation: %d %s, attempts %v, want %s", status, body, attempts, other)
	}
	status, body, _ = turnWithIdentity(t, headers, nil, "")
	if attempts := proxy.upstream.take(); status != http.StatusOK || len(attempts) != 1 || attempts[0] == bound {
		t.Fatalf("child replay: %d %s, attempts %v, want another account than %s", status, body, attempts, bound)
	}
}

func TestAContinuationOfADisabledThreadIsSentAgainWithoutItsThread(t *testing.T) {
	for authID := range proxy.names {
		proxy.manager.MarkResult(context.Background(), coreauth.Result{AuthID: authID, Provider: "claude", Model: model, Success: true})
	}
	session, bound, id := startThread(t)
	time.Sleep(6 * time.Second)
	auth, ok := proxy.manager.GetByID(idOf(bound))
	if !ok {
		t.Fatalf("thread account %s is missing", bound)
	}
	auth.Disabled = true
	if _, err := proxy.manager.Update(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		auth.Disabled = false
		if _, err := proxy.manager.Update(context.Background(), auth); err != nil {
			t.Error(err)
		}
	})
	status, body, _ := turn(t, session, continuing(id))
	if attempts := proxy.upstream.take(); !threadUnsupported(status, body) || len(attempts) != 0 {
		t.Fatalf("disabled thread continuation: %d %s, attempts %v; want 400 thread_unsupported_request before any attempt", status, body, attempts)
	}
	status, body, _ = turn(t, session, "")
	if attempts := proxy.upstream.take(); status != http.StatusOK || len(attempts) != 1 || attempts[0] == bound {
		t.Fatalf("the turn sent again: %d %s, attempts %v, want another account than %s", status, body, attempts, bound)
	}
	waitForUsage(t, session)
}
