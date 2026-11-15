package hostcontract

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// The pool through the proxy's own plugin host: the registry quota-pilot reads is the one the
// proxy's selector tests. The accounts added here register model names of their own, so the
// other tests' requests for their model never reach them; each is disabled and its names
// unregistered when its test ends. Every figure is made up.

// pool asks for the pool with the client key, as quota-pool does.
func pool(t *testing.T, query url.Values) (int, core.Pool) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, proxy.url+"/v0/resource/plugins/quota-pilot/pool?"+query.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+clientKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var doc core.Pool
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, &doc); err != nil {
			t.Fatalf("pool answer = %s", body)
		}
	}
	return resp.StatusCode, doc
}

// addAccount holds a runtime-only credential named name at the stub, of the provider, with the
// model names registered for it, under prefix when one is given.
func addAccount(t *testing.T, name, provider, prefix string, names ...string) *coreauth.Auth {
	t.Helper()
	ctx := context.Background()
	auth := &coreauth.Auth{ID: provider + ":apikey:pool-" + name, Provider: provider, Label: provider + "-apikey", Prefix: prefix,
		Status: coreauth.StatusActive, Attributes: map[string]string{"api_key": "sk-made-up-" + name, "auth_kind": "apikey",
			"base_url": proxyUpstream() + "/" + name, "runtime_only": "true"}}
	if _, err := proxy.manager.Register(ctx, auth); err != nil {
		t.Fatal(err)
	}
	models := make([]*cliproxy.ModelInfo, 0, len(names))
	for _, n := range names {
		models = append(models, &cliproxy.ModelInfo{ID: n})
	}
	cliproxy.GlobalModelRegistry().RegisterClient(auth.ID, provider, models)
	// quota-pilot takes a reading only for an account its ledger holds, which it learns from the
	// host's list: a /pool call reads that list now, as the poll loop would later.
	pool(t, nil)
	t.Cleanup(func() {
		cliproxy.GlobalModelRegistry().UnregisterClient(auth.ID)
		if held, ok := proxy.manager.GetByID(auth.ID); ok {
			held.Disabled = true
			_, _ = proxy.manager.Update(ctx, held)
		}
		pool(t, nil) // quota-pilot reads the account list again, and lets the account go
	})
	return auth
}

// proxyUpstream is the stub's address, as the accounts of the proxy point at it.
func proxyUpstream() string {
	auth, _ := proxy.manager.GetByID(idOf("A"))
	return strings.TrimSuffix(auth.Attributes["base_url"], "/A")
}

// withHeaders answers as the stub does, with the provider's quota headers: each window kind's part
// used, resetting in three days.
func withHeaders(used map[string]float64) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		reset := fmt.Sprint(time.Now().Add(72 * time.Hour).Unix())
		for token, u := range used {
			w.Header().Set("anthropic-ratelimit-unified-"+token+"-utilization", fmt.Sprint(u))
			w.Header().Set("anthropic-ratelimit-unified-"+token+"-reset", reset)
		}
		answer(w, "msg_pool")
	}
}

// send makes one request for name through the proxy, which the stub answers as account, and
// waits until quota-pilot has the 7d reading it brought for the credential authID.
func send(t *testing.T, name, account, authID string) {
	t.Helper()
	body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, name)
	req, _ := http.NewRequest(http.MethodPost, proxy.url+"/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if got := proxy.upstream.take(); len(got) != 1 || got[0] != account {
		t.Fatalf("a request for %s went to %v, want %s", name, got, account)
	}
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		_, doc := pool(t, nil)
		for _, a := range doc.Accounts {
			for _, w := range a.Windows {
				if a.ID == opaqueID(authID) && w.Kind == "7d" {
					return
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the reading %s brought did not arrive: %+v", account, doc.Accounts)
		}
	}
}

// opaqueID is the id quota-pilot gives a credential outside the proxy.
func opaqueID(authID string) string {
	sum := sha256.Sum256([]byte(authID))
	return hex.EncodeToString(sum[:8])
}

func rowFor(t *testing.T, m core.PoolModel, authID string) core.PoolRow {
	t.Helper()
	for _, r := range m.Rows {
		if r.Account == opaqueID(authID) {
			return r
		}
	}
	t.Fatalf("no row for %s in %+v", authID, m.Rows)
	return core.PoolRow{}
}

func said(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// The resource answers a client key, no management key, and its membership comes from the host:
// an account the registry holds no such name for is not_registered, and an account of a provider
// quota-pilot does not read that registers the name keeps the pool from short.
func TestThePoolTakesWhoServesAModelFromTheHost(t *testing.T) {
	status, doc := pool(t, nil)
	if status != http.StatusOK || doc.SchemaVersion != 1 || len(doc.Errors) != 0 {
		t.Fatalf("pool with a client key = %d %+v", status, doc)
	}
	d := addAccount(t, "D", "claude", "", "pool-model-d")
	proxy.upstream.fail("D", withHeaders(map[string]float64{"5h": 0.1, "7d": 0.95}))
	send(t, "pool-model-d", "D", d.ID)
	_, doc = pool(t, url.Values{"model": {"pool-model-d"}, "floor": {"15"}})
	m := doc.Models[0]
	if said(m.Verdict) != "short" || m.Accounts != 1 || m.Read != 1 || *m.BestWeeklyLeft != 5 {
		t.Fatalf("one account at 5 = %s %s %+v", said(m.Verdict), said(m.UnmeasuredBecause), m)
	}
	if r := rowFor(t, m, d.ID); !r.Counts || *r.WeeklyWindow != "7d" {
		t.Fatalf("D = %+v", r)
	}
	if r := rowFor(t, m, idOf("A")); r.Counts || said(r.WhyNot) != "not_registered" {
		t.Fatalf("A, which does not have the model, = %+v", r)
	}

	g := addAccount(t, "G", "gemini", "", "pool-model-d")
	_, doc = pool(t, url.Values{"model": {"pool-model-d"}, "floor": {"15"}})
	m = doc.Models[0]
	if said(m.Verdict) != "unmeasured" || said(m.UnmeasuredBecause) != "unread" || strings.Join(m.Providers, ",") != "claude,gemini" || m.Accounts != 2 {
		t.Fatalf("with an account of another provider = %s %s %+v", said(m.Verdict), said(m.UnmeasuredBecause), m)
	}
	if r := rowFor(t, m, g.ID); !r.Counts || r.WeeklyRead {
		t.Fatalf("G = %+v", r)
	}
}

// A name the host accepts only through its second test, the credential's prefix stripped, is one
// the registry does not hold: the pool says it is not registered, never short.
func TestANameTheHostAcceptsOnlyThroughItsSecondTestIsNotRegistered(t *testing.T) {
	f := addAccount(t, "F", "claude", "team", "pool-model-f")
	if cliproxy.GlobalModelRegistry().ClientSupportsModel(f.ID, "team/pool-model-f") {
		t.Fatal("the registry holds the prefixed name: no second test needed")
	}
	// The selector, given the provider (as a route or a forced provider gives it), takes F for
	// the prefixed name.
	body := []byte(`{"model":"team/pool-model-f","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	result, err := proxy.manager.ExecuteStream(context.Background(), []string{"claude"},
		cliproxyexecutor.Request{Model: "team/pool-model-f", Payload: body, Format: "claude"},
		cliproxyexecutor.Options{Stream: true, OriginalRequest: body, SourceFormat: "claude"})
	if err != nil {
		t.Fatalf("the host refused the prefixed name: %v", err)
	}
	for range result.Chunks {
	}
	if got := proxy.upstream.take(); len(got) != 1 || got[0] != "F" {
		t.Fatalf("the prefixed name went to %v, want F", got)
	}
	_, doc := pool(t, url.Values{"model": {"team/pool-model-f"}, "floor": {"15"}})
	if m := doc.Models[0]; said(m.Verdict) != "unmeasured" || said(m.UnmeasuredBecause) != "name_not_registered" || len(m.Rows) != 0 {
		t.Fatalf("the prefixed name = %s %s %+v", said(m.Verdict), said(m.UnmeasuredBecause), m)
	}
	_, doc = pool(t, url.Values{"model": {"pool-model-f"}})
	if r := rowFor(t, doc.Models[0], f.ID); !r.Counts {
		t.Fatalf("the registered name = %+v", r)
	}
}

// A registered alias whose name does not say its family is judged on the all-models week, as the
// pick judges it, whatever the model's own week says.
func TestAnAliasThatHidesItsFamilyIsJudgedOnTheAllModelsWeek(t *testing.T) {
	e := addAccount(t, "E", "claude", "", "pool-big-alias")
	proxy.upstream.fail("E", withHeaders(map[string]float64{"5h": 0.1, "7d": 0.5, "7d_oi": 1}))
	send(t, "pool-big-alias", "E", e.ID)
	_, doc := pool(t, url.Values{"model": {"pool-big-alias"}, "floor": {"15"}})
	m := doc.Models[0]
	r := rowFor(t, m, e.ID)
	if said(m.Verdict) != "enough" || !r.WeeklyRead || *r.WeeklyWindow != "7d" || *r.WeeklyLeft != 50 {
		t.Fatalf("the alias = %s %+v, row %+v", said(m.Verdict), m, r)
	}
	for _, a := range doc.Accounts {
		for _, w := range a.Windows {
			if a.ID == opaqueID(e.ID) && w.Kind == "7d_fable" && w.Left != 0 {
				t.Fatalf("E's Fable week = %+v", w)
			}
		}
	}
}
