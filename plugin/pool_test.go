package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// Every figure and token here is made up.

// poolHost answers quota-pilot's host calls for a few accounts: the list, the registry, each login,
// and each usage answer, counting the usage reads of each account.
type poolHost struct {
	mu    sync.Mutex
	files []pluginapi.HostAuthFileEntry
	usage map[string]func() (int, string) // by account id: the status and body of its usage answer
	reads map[string]int
}

func (h *poolHost) call(method string, payload any) (json.RawMessage, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch method {
	case pluginabi.MethodHostAuthList:
		return json.Marshal(map[string]any{"files": h.files})
	case pluginabi.MethodHostAuthModels:
		var answer pluginapi.HostAuthModelsResponse
		for _, f := range h.files {
			answer.Credentials = append(answer.Credentials, pluginapi.HostAuthModels{ID: f.ID, AuthIndex: f.AuthIndex, Provider: f.Provider, Models: []string{"claude-opus-5-5", "gpt-6-sol"}})
		}
		return json.Marshal(answer)
	case pluginabi.MethodHostAuthGet:
		index := payload.(pluginapi.HostAuthGetRequest).AuthIndex
		return json.Marshal(pluginapi.HostAuthGetResponse{AuthIndex: index, JSON: json.RawMessage(`{"access_token":"made-up-` + index + `"}`)})
	case pluginabi.MethodHostHTTPOperationOpen:
		return json.RawMessage(`{"operation_id":"op"}`), nil
	case pluginabi.MethodHostHTTPDo:
		do := payload.(map[string]any)
		if !strings.Contains(do["url"].(string), "/usage") {
			return json.Marshal(pluginapi.HTTPResponse{StatusCode: http.StatusNotFound})
		}
		index := strings.TrimPrefix(do["headers"].(map[string][]string)["Authorization"][0], "Bearer made-up-")
		for _, f := range h.files {
			if f.AuthIndex == index {
				h.reads[f.ID]++
				status, body := h.usage[f.ID]()
				return json.Marshal(pluginapi.HTTPResponse{StatusCode: status, Body: []byte(body)})
			}
		}
	}
	return json.RawMessage(`{}`), nil
}

// usageOK is a usage answer the poll accepts, its weekly window resetting days out; codex adds a
// credit object.
func usageOK(provider, credits string) func() (int, string) {
	return usageResetting(provider, credits, 5*24*time.Hour)
}

func usageResetting(provider, credits string, weekly time.Duration) func() (int, string) {
	return func() (int, string) {
		reset := time.Now().Add(weekly).Unix()
		if provider == "codex" {
			return http.StatusOK, fmt.Sprintf(`{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":18000,"reset_at":%d},"secondary_window":{"used_percent":30,"limit_window_seconds":604800,"reset_at":%d}}%s}`,
				time.Now().Add(time.Hour).Unix(), reset, credits)
		}
		return http.StatusOK, fmt.Sprintf(`{"five_hour":{"utilization":10,"resets_at":%q},"seven_day":{"utilization":30,"resets_at":%q}}`,
			time.Now().Add(time.Hour).UTC().Format(time.RFC3339), time.Unix(reset, 0).UTC().Format(time.RFC3339))
	}
}

// withPoolHost runs f in a bubble of its own time, with a fresh state, the given accounts on a
// fake host, and the poll's memory cleared; it puts all back after.
func withPoolHost(t *testing.T, f func(t *testing.T, h *poolHost)) {
	savedState, savedHost, savedPoll := state, callHost, pollTurn
	savedPolled, savedPlan, savedEmpty, savedPoolRead := polledAt, planReadAt, emptiedSince, poolReadAt
	defer func() {
		state, callHost, pollTurn = savedState, savedHost, savedPoll
		polledAt, planReadAt, emptiedSince, poolReadAt = savedPolled, savedPlan, savedEmpty, savedPoolRead
	}()
	synctest.Test(t, func(t *testing.T) {
		state = core.New("pool-test", nil)
		pollTurn = make(chan struct{}, 1)
		polledAt, planReadAt, emptiedSince, poolReadAt = map[string]time.Time{}, map[string]time.Time{}, time.Time{}, time.Time{}
		h := &poolHost{
			files: []pluginapi.HostAuthFileEntry{
				{ID: "claude-a.json", AuthIndex: "1", Provider: "claude", Email: "ada@example.com"},
				{ID: "codex-x.json", AuthIndex: "2", Provider: "codex", Email: "xia@example.com"},
			},
			usage: map[string]func() (int, string){"claude-a.json": usageResetting("claude", "", 3*time.Minute), "codex-x.json": usageOK("codex", `,"credits":{"balance":"2500.25","unlimited":false}`)},
			reads: map[string]int{},
		}
		callHost = h.call
		f(t, h)
	})
}

// poolGet asks for /pool with the query given and the key, "" for none, and answers the status
// and the body.
func poolGet(t *testing.T, key string, query url.Values) (int, []byte) {
	t.Helper()
	h := http.Header{}
	if key != "" {
		h.Set("Authorization", "Bearer "+key)
	}
	return resourceGet(t, "/v0/resource/plugins/quota-pilot/pool", h, query)
}

func resourceGet(t *testing.T, path string, h http.Header, query url.Values) (int, []byte) {
	t.Helper()
	request, _ := json.Marshal(map[string]any{"Method": http.MethodGet, "Path": path, "Headers": h, "Query": query})
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
	if errDecode := json.Unmarshal(out, &reply); errDecode != nil {
		t.Fatal(errDecode)
	}
	return reply.Result.StatusCode, reply.Result.Body
}

func poolDoc(t *testing.T, body []byte) core.Pool {
	t.Helper()
	var doc core.Pool
	if errDecode := json.Unmarshal(body, &doc); errDecode != nil || doc.SchemaVersion != 1 {
		t.Fatalf("pool answer = %s", body)
	}
	return doc
}

// The pool answers only a client key the proxy accepted in the last week, as the band does, and
// then carries a Codex account's credits with their balance.
func TestPoolNeedsAnAcceptedClientKey(t *testing.T) {
	withPoolHost(t, func(t *testing.T, h *poolHost) {
		if status, body := poolGet(t, "sk-made-up", nil); status != http.StatusUnauthorized || !strings.Contains(string(body), "accepted in the last week") {
			t.Fatalf("unknown key = %d %s", status, body)
		}
		acceptKey("sk-made-up")
		status, body := poolGet(t, "sk-made-up", url.Values{"model": {"gpt-6-sol"}, "floor": {"15"}})
		if status != http.StatusOK {
			t.Fatalf("accepted key = %d %s", status, body)
		}
		doc := poolDoc(t, body)
		var codex *core.PoolCredits
		for _, a := range doc.Accounts {
			if a.Provider == "codex" {
				codex = a.Credits
			}
			if strings.Contains(string(body), "@example.com") || strings.Contains(string(body), ".json") {
				t.Fatalf("the pool names an email or a file: %s", body)
			}
		}
		if codex == nil || codex.State != "some" || *codex.Balance != 2500.25 || *codex.Stale {
			t.Fatalf("codex credits = %+v", codex)
		}
		if doc.QuotaPilot != version || len(doc.Errors) != 0 || len(doc.Models) != 1 || *doc.Models[0].Verdict != "enough" {
			t.Fatalf("pool = %s", body)
		}
		if status, _ := poolGet(t, "", nil); status != http.StatusUnauthorized {
			t.Fatalf("no key on a proxy that asks for keys = %d", status)
		}
	})
	// A proxy without api-keys lets every caller in once it has served a keyless request.
	withPoolHost(t, func(t *testing.T, h *poolHost) {
		state.Observe(core.Usage{Provider: "claude", Model: "claude-opus-5-5", SessionID: "claude:s1", AuthID: "claude-a.json", RequestedAt: time.Now()})
		if status, body := poolGet(t, "", nil); status != http.StatusOK {
			t.Fatalf("keyless proxy = %d %s", status, body)
		}
	})
}

// floor is one unsigned decimal number from 0 to 100, given once, and only beside a model.
func TestPoolRejectsAFloorOfAnyOtherForm(t *testing.T) {
	withPoolHost(t, func(t *testing.T, h *poolHost) {
		acceptKey("sk-made-up")
		model := []string{"claude-opus-5-5"}
		for _, bad := range []url.Values{
			{"model": model, "floor": {""}}, {"model": model, "floor": {"-1"}}, {"model": model, "floor": {"+5"}},
			{"model": model, "floor": {"1e1"}}, {"model": model, "floor": {"NaN"}}, {"model": model, "floor": {"Inf"}},
			{"model": model, "floor": {"100.5"}}, {"model": model, "floor": {"101"}}, {"model": model, "floor": {" 5"}},
			{"model": model, "floor": {".5"}}, {"model": model, "floor": {"5."}}, {"model": model, "floor": {"0x10"}},
			{"model": model, "floor": {"15", "15"}}, {"floor": {"15"}},
		} {
			if status, body := poolGet(t, "sk-made-up", bad); status != http.StatusBadRequest || !strings.HasPrefix(string(body), `{"error":`) {
				t.Fatalf("%v = %d %s", bad, status, body)
			}
		}
		for _, good := range []string{"0", "15", "15.5", "100", "100.00"} {
			if status, body := poolGet(t, "sk-made-up", url.Values{"model": model, "floor": {good}}); status != http.StatusOK {
				t.Fatalf("floor %s = %d %s", good, status, body)
			}
		}
		if reads := h.reads["claude-a.json"]; reads != 1 {
			t.Fatalf("a rejected call read the providers, or a call read twice in a minute: %d reads", reads)
		}
	})
}

// A resource path the plugin does not know answers no snapshot, which holds emails; the
// management route still does.
func TestAnUnknownResourcePathGetsNoSnapshot(t *testing.T) {
	withPoolHost(t, func(t *testing.T, h *poolHost) {
		acceptKey("sk-made-up")
		state.UpdateInventory([]core.CredInfo{{ID: "claude-a.json", Provider: "claude", Email: "ada@example.com"}})
		auth := http.Header{"Authorization": {"Bearer sk-made-up"}}
		for _, path := range []string{"/v0/resource/plugins/quota-pilot/nothing", "/v0/resource/plugins/quota-pilot/pool/more", "/v0/resource/plugins/quota-pilot/"} {
			if status, body := resourceGet(t, path, auth, nil); status != http.StatusNotFound || strings.Contains(string(body), "example.com") {
				t.Fatalf("%s = %d %s", path, status, body)
			}
		}
		if status, body := resourceGet(t, "/v0/management/quota-pilot/snapshot", nil, nil); status != http.StatusOK || !strings.Contains(string(body), "ada@example.com") {
			t.Fatalf("management snapshot = %d %s", status, body)
		}
	})
}

// The resource has the providers read only the accounts that are due, at most once a minute
// however many ask, and says why a read failed.
func TestPoolReadsWhatIsDueAtMostOnceAMinute(t *testing.T) {
	withPoolHost(t, func(t *testing.T, h *poolHost) {
		acceptKey("sk-made-up")
		read := func() core.Pool {
			t.Helper()
			status, body := poolGet(t, "sk-made-up", url.Values{"model": {"claude-opus-5-5"}})
			if status != http.StatusOK {
				t.Fatalf("pool = %d %s", status, body)
			}
			return poolDoc(t, body)
		}
		// After a start every account is due.
		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() { read() })
		}
		wg.Wait()
		if h.reads["claude-a.json"] != 1 || h.reads["codex-x.json"] != 1 {
			t.Fatalf("concurrent calls read %v, want each account once", h.reads)
		}
		// Within the minute nothing is read; after it, an account read within twice the idle
		// interval is skipped.
		time.Sleep(30 * time.Second)
		read()
		time.Sleep(time.Minute)
		read()
		if h.reads["claude-a.json"] != 1 || h.reads["codex-x.json"] != 1 {
			t.Fatalf("accounts read again too soon: %v", h.reads)
		}
		// One whose weekly reset has passed since it was read is read again: claude-a's week, read
		// at the start, resets three minutes in.
		h.usage["claude-a.json"] = usageOK("claude", "")
		time.Sleep(2 * time.Minute)
		read()
		if h.reads["claude-a.json"] != 2 || h.reads["codex-x.json"] != 1 {
			t.Fatalf("after a weekly reset passed: %v", h.reads)
		}
		// A failed read says why, keeps what was read before, and is tried again the next minute,
		// not sooner, however many ask: it is due at every call.
		h.usage["codex-x.json"] = func() (int, string) { return http.StatusUnauthorized, `{"error":"made up"}` }
		time.Sleep(20 * time.Minute)
		for range 8 {
			wg.Go(func() { read() })
		}
		wg.Wait()
		time.Sleep(59 * time.Second)
		doc := read()
		if h.reads["codex-x.json"] != 2 {
			t.Fatalf("a failing account was read more than once a minute: %v", h.reads)
		}
		var codex core.PoolAccount
		for _, a := range doc.Accounts {
			if a.Provider == "codex" {
				codex = a
			}
		}
		if codex.ReadFailure == nil || *codex.ReadFailure != "refused" || codex.Credits.State != "some" || *codex.Credits.Balance != 2500.25 {
			t.Fatalf("failed read = %+v, credits %+v", codex, codex.Credits)
		}
		firstRead := *codex.Credits.ReadAt
		time.Sleep(time.Second)
		read()
		if h.reads["codex-x.json"] != 3 {
			t.Fatalf("a failed account was not tried again the next minute: %v", h.reads)
		}
		// An answer without a rate_limit object is a failed read too; one with it and no credit
		// object is a new reading that says nothing of credits.
		h.usage["codex-x.json"] = func() (int, string) { return http.StatusOK, `{"credits":{"balance":"9","unlimited":false}}` }
		time.Sleep(time.Minute)
		for _, a := range read().Accounts {
			if a.Provider == "codex" && (*a.ReadFailure != "unreadable" || *a.Credits.Balance != 2500.25 || !a.Credits.ReadAt.Equal(firstRead)) {
				t.Fatalf("an answer without rate_limit = %+v, credits %+v", a, a.Credits)
			}
		}
		h.usage["codex-x.json"] = usageOK("codex", "")
		time.Sleep(time.Minute)
		for _, a := range read().Accounts {
			if a.Provider == "codex" && (a.ReadFailure != nil || a.Credits.State != "unknown" || a.Credits.Balance != nil || !a.Credits.ReadAt.Equal(time.Now().UTC())) {
				t.Fatalf("a reading without credits = %+v, credits %+v", a, a.Credits)
			}
		}
	})
}
