package hostcontract

// The retry rule (docs/adr/0003) through the plugin itself: quota-pilot is built as the library the
// proxy loads and loaded by CLIProxyAPI's own plugin host, in front of the proxy's real Claude
// handler and executor; three Claude API-key accounts, A, B and C, point at a stub upstream on a
// loopback port. No account, key or proxy of anyone's is reached: the keys are made up, the
// accounts carry no login, so the plugin reads no quota, and its files go to a temporary HOME.
//
// QUOTA_PILOT_LIBRARY=<file> runs the same tests on a library built elsewhere, such as a release's.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"gopkg.in/yaml.v3"
)

const (
	clientKey = "host-contract-client-key"
	model     = "claude-opus-5-5"
)

// upstream serves each account at its own path prefix: the next reply scripted for it, else a
// whole, quick answer. It keeps the account of every attempt, in order.
type upstream struct {
	mu       sync.Mutex
	script   map[string][]func(http.ResponseWriter)
	attempts []string
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	account := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]
	u.mu.Lock()
	u.attempts = append(u.attempts, account)
	reply := answer
	if left := u.script[account]; len(left) > 0 {
		reply, u.script[account] = left[0], left[1:]
	}
	u.mu.Unlock()
	reply(w)
}

// fail scripts the account's next attempt.
func (u *upstream) fail(account string, reply func(http.ResponseWriter)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.script[account] = append(u.script[account], reply)
}

// take returns the attempts since the last take.
func (u *upstream) take() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := u.attempts
	u.attempts = nil
	return out
}

func answer(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, e := range []string{
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"` + model + `","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
		`{"type":"message_stop"}`,
	} {
		var kind struct{ Type string }
		_ = json.Unmarshal([]byte(e), &kind)
		_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind.Type, e)
	}
}

// dropped ends the connection with no byte, as a lost upstream connection does.
func dropped(http.ResponseWriter) { panic(http.ErrAbortHandler) }

// proxy is this package's one proxy: the service's usage queue is process-wide and a stopped
// service stops it for good, so every test shares it.
var proxy struct {
	url      string
	manager  *coreauth.Manager
	upstream *upstream
	names    map[string]string // auth id to account name
}

func TestMain(m *testing.M) {
	code, err := run(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "host contract:", err)
		os.Exit(1)
	}
	os.Exit(code)
}

func run(m *testing.M) (int, error) {
	dir, err := os.MkdirTemp("", "quota-pilot-host-contract-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)
	// The plugin keeps its files under $HOME/.cache/cliproxy-kit; its runtime reads the environment
	// when the host loads it, after this.
	if err := os.Setenv("HOME", filepath.Join(dir, "home")); err != nil {
		return 0, err
	}
	ext := "so"
	if runtime.GOOS == "darwin" {
		ext = "dylib"
	}
	lib := filepath.Join(dir, "plugins", runtime.GOOS, runtime.GOARCH, "quota-pilot-v0.0.1."+ext)
	if err := os.MkdirAll(filepath.Dir(lib), 0o700); err != nil {
		return 0, err
	}
	if prebuilt := os.Getenv("QUOTA_PILOT_LIBRARY"); prebuilt != "" {
		raw, err := os.ReadFile(prebuilt)
		if err != nil {
			return 0, err
		}
		if err := os.WriteFile(lib, raw, 0o600); err != nil {
			return 0, err
		}
	} else {
		build := exec.Command("go", "build", "-buildmode=c-shared", "-o", lib, ".")
		build.Dir = ".."
		if out, err := build.CombinedOutput(); err != nil {
			return 0, fmt.Errorf("build the plugin: %v\n%s", err, out)
		}
	}

	u := &upstream{script: map[string][]func(http.ResponseWriter){}}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	server := &http.Server{Handler: u}
	go server.Serve(listener)
	defer server.Close()

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	none := filepath.Join(dir, "none.json")
	raw, err := yaml.Marshal(map[string]any{
		"host":     "127.0.0.1",
		"port":     port,
		"auth-dir": filepath.Join(dir, "auths"),
		"api-keys": []string{clientKey},
		// The proxy's defaults, written out.
		"request-retry":         3,
		"max-retry-credentials": 0,
		"max-retry-interval":    30,
		"plugins": map[string]any{"enabled": true, "dir": filepath.Join(dir, "plugins"),
			"configs": map[string]any{"quota-pilot": map[string]any{"enabled": true,
				"store": map[string]any{"id": "quota-pilot", "version": "0.0.1"}}}},
		// The model catalogs from a file that does not exist: the proxy keeps its built-in ones and
		// never fetches them over the network.
		"models": map[string]string{"catalog": none, "codex-catalog": none, "devin-catalog": none},
		// One account makes the proxy bind its Claude executor; it never serves.
		"claude-api-key": []map[string]any{{"api-key": "sk-seed", "base-url": "http://127.0.0.1:9/seed"}},
	})
	if err != nil {
		return 0, err
	}
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return 0, err
	}
	var cfg sdkconfig.Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return 0, err
	}
	manager := coreauth.NewManager(nil, nil, nil)
	started := make(chan struct{})
	svc, err := cliproxy.NewBuilder().WithConfig(&cfg).WithConfigPath(path).WithCoreAuthManager(manager).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { close(started) }}).
		WithWatcherFactory(func(string, string, func(*sdkconfig.Config)) (*cliproxy.WatcherWrapper, error) {
			return &cliproxy.WatcherWrapper{}, nil
		}).Build()
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = svc.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		return 0, errors.New("the proxy did not start")
	}
	for _, auth := range manager.List() {
		auth.Disabled = true
		if _, err := manager.Update(ctx, auth); err != nil {
			return 0, err
		}
	}
	proxy.url, proxy.manager, proxy.upstream, proxy.names = fmt.Sprintf("http://127.0.0.1:%d", port), manager, u, map[string]string{}
	registry := cliproxy.GlobalModelRegistry()
	for _, name := range []string{"A", "B", "C"} {
		// An API-key account as the proxy builds one from its config (synthesizer: api_key,
		// base_url), listed to plugins as a file is, so quota-pilot holds it.
		auth := &coreauth.Auth{ID: "claude:apikey:host-contract-" + name, Provider: "claude", Label: "claude-apikey",
			Status: coreauth.StatusActive, Attributes: map[string]string{"api_key": "sk-made-up-" + name, "auth_kind": "apikey",
				"base_url": "http://" + listener.Addr().String() + "/" + name, "runtime_only": "true"}}
		if _, err := manager.Register(ctx, auth); err != nil {
			return 0, err
		}
		registry.RegisterClient(auth.ID, "claude", []*cliproxy.ModelInfo{{ID: model}})
		proxy.names[auth.ID] = name
	}
	if err := waitForPlugin(); err != nil {
		return 0, err
	}
	return m.Run(), nil
}

// waitForPlugin waits until quota-pilot answers its band resource, which it does for a client key
// the proxy accepted: a request with the key comes first.
func waitForPlugin() error {
	defer proxy.upstream.take()
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, model)
		req, _ := http.NewRequest(http.MethodPost, proxy.url+"/v1/messages", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+clientKey)
		req.Header.Set("Content-Type", "application/json")
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
		if _, err := band("probe"); err == nil {
			return nil
		}
	}
	return errors.New("quota-pilot did not answer: the host did not load it")
}

// band reads quota-pilot's snapshot for the session, as the band does.
func band(session string) (map[string]any, error) {
	req, _ := http.NewRequest(http.MethodGet, proxy.url+"/v0/resource/plugins/quota-pilot/band", nil)
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("X-Band-Session", session)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("band: HTTP %d", resp.StatusCode)
	}
	var snap map[string]any
	return snap, json.NewDecoder(resp.Body).Decode(&snap)
}

// post sends one streaming main turn of the Claude Code session (a main turn carries tools) and
// returns what the client got.
func post(t *testing.T, session string) (int, string) {
	t.Helper()
	body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}],`+
		`"tools":[{"name":"Read","description":"Reads a file","input_schema":{"type":"object"}}]}`, model)
	req, _ := http.NewRequest(http.MethodPost, proxy.url+"/v1/messages", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+clientKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Claude-Code-Session-Id", session)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// boundIndex is the proxy's index of the account quota-pilot's band snapshot names for the session:
// the band names accounts by an opaque id, and lists each with the proxy's index.
func boundIndex(t *testing.T, session string) string {
	t.Helper()
	var snap struct {
		Providers map[string]struct {
			Credentials []struct {
				ID        string `json:"id"`
				AuthIndex string `json:"auth_index"`
			} `json:"credentials"`
		} `json:"providers"`
		Sessions map[string]struct {
			AuthID string `json:"auth_id"`
		} `json:"sessions"`
	}
	doc, err := band(session)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(doc)
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatal(err)
	}
	for _, c := range snap.Providers["claude"].Credentials {
		if id := snap.Sessions[session].AuthID; id != "" && c.ID == id {
			return c.AuthIndex
		}
	}
	return ""
}

// proxyIndex is the proxy's index of the account.
func proxyIndex(name string) string {
	for id, n := range proxy.names {
		if n == name {
			auth, _ := proxy.manager.GetByID(id)
			return auth.Index
		}
	}
	return ""
}

var sessions atomic.Int64

// A dropped connection on the account quota-pilot bound the session to is retried there, inside
// the same request, with the proxy's default settings and with max-retry-credentials 1: in the
// first the plugin declines the round's pick of another account and the proxy's next round offers
// the bound one again; in the second no pick follows the failure in its round.
func TestTheBuiltPluginKeepsADroppedConnectionsRetryOnTheBoundAccount(t *testing.T) {
	for _, c := range []struct {
		name           string
		maxCredentials int
	}{
		{"with the proxy's default settings", 0},
		{"with max-retry-credentials 1", 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			proxy.manager.SetRetryConfig(3, 30*time.Second, c.maxCredentials)
			session := fmt.Sprintf("host-contract-%d", sessions.Add(1))
			if status, body := post(t, session); status != http.StatusOK || !strings.Contains(body, "message_stop") {
				t.Fatalf("first request: %d %s", status, body)
			}
			first := proxy.upstream.take()
			if len(first) != 1 {
				t.Fatalf("first request's attempts %v", first)
			}
			bound := first[0]
			if got, want := boundIndex(t, session), proxyIndex(bound); got != want {
				t.Fatalf("quota-pilot bound the session to the account of index %q; %s (index %q) served it", got, bound, want)
			}
			proxy.upstream.fail(bound, dropped)
			status, body := post(t, session)
			if attempts := proxy.upstream.take(); !slices.Equal(attempts, []string{bound, bound}) {
				t.Fatalf("attempts %v, want two on %s", attempts, bound)
			}
			if status != http.StatusOK || !strings.Contains(body, "message_stop") {
				t.Fatalf("the client got %d %s", status, body)
			}
		})
	}
}
