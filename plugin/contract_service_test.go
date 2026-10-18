package main

// The proxy contract, through the whole proxy: CLIProxyAPI's service runs in-process on a loopback
// port with its real Claude and Codex executors, three Claude API-key accounts (A, B, C) and one
// Codex account (X) pointing at a stub upstream on another loopback port, no plugins, and a temporary
// config and auth folder. Stub hooks stand where quota-pilot's scheduler and usage plugin plug in.
// Waits are scaled down from the spec's (a 45 s stream is 1.5 s here): what is pinned is which
// timings a record carries, not how long they are.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

const contractKey = "contract-client-key"

// upstreamReply answers one attempt on an account at the stub upstream.
type upstreamReply func(w http.ResponseWriter, r *http.Request)

// stubUpstream serves each account at its own path prefix, from a script per account, and answers
// once the script is spent.
type stubUpstream struct {
	mu     sync.Mutex
	script map[string][]upstreamReply
}

func (u *stubUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	account := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]
	u.mu.Lock()
	var reply upstreamReply = answer
	if left := u.script[account]; len(left) > 0 {
		reply, u.script[account] = left[0], left[1:]
	}
	u.mu.Unlock()
	reply(w, r)
}

func sse(w http.ResponseWriter, events ...string) {
	for _, e := range events {
		_, _ = fmt.Fprint(w, e)
	}
	w.(http.Flusher).Flush()
}

func streamHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
}

const (
	claudeStart = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"" + contractModel + "\",\"content\":[],\"usage\":{\"input_tokens\":1200,\"cache_read_input_tokens\":800,\"cache_creation_input_tokens\":300,\"output_tokens\":1}}}\n\n"
	claudeText  = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n"
	claudeEnd   = "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	codexText   = "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"delta\":\"hi\"}\n\n"
	codexEnd    = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n"
)

// answer is a whole, quick answer in the request's own format.
func answer(w http.ResponseWriter, r *http.Request) {
	streamHeaders(w)
	if strings.HasSuffix(r.URL.Path, "/responses") {
		sse(w, codexText, codexEnd)
		return
	}
	sse(w, claudeStart, claudeText, claudeEnd)
}

// dropped ends the connection with no further byte, as a lost upstream connection does.
func dropped(after time.Duration) upstreamReply {
	return func(http.ResponseWriter, *http.Request) {
		time.Sleep(after)
		panic(http.ErrAbortHandler)
	}
}

func silentThen504(after time.Duration) upstreamReply {
	return func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(after)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGatewayTimeout)
		_, _ = fmt.Fprint(w, `{"type":"error","error":{"type":"api_error","message":"upstream timed out"}}`)
	}
}

// brokenStream opens the stream with `events` at once, text from `text`, and drops it at `drop`.
func brokenStream(start string, text time.Duration, more string, drop time.Duration) upstreamReply {
	return func(w http.ResponseWriter, _ *http.Request) {
		begun := time.Now()
		streamHeaders(w)
		if start != "" {
			sse(w, start)
		}
		time.Sleep(text)
		sse(w, more)
		time.Sleep(drop - time.Since(begun))
		panic(http.ErrAbortHandler)
	}
}

// heldUntilGone answers nothing (or opens the stream first) until the client goes away.
func heldUntilGone(start string) upstreamReply {
	return func(w http.ResponseWriter, r *http.Request) {
		if start != "" {
			streamHeaders(w)
			sse(w, start)
		}
		<-r.Context().Done()
	}
}

func unifiedRejection(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Anthropic-Ratelimit-Unified-Status", "rejected")
	w.Header().Set("Anthropic-Ratelimit-Unified-5h-Status", "rejected")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = fmt.Fprint(w, `{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}`)
}

// recorder is the usage plugin, registered once: the proxy's usage queue is global, and stopping
// a service stops it for good (service_lifecycle.go:369), so every test shares one proxy.
type recorder struct {
	mu      sync.Mutex
	records []cliusage.Record
	busy    atomic.Int32
	overlap atomic.Bool
}

func (r *recorder) HandleUsage(_ context.Context, record cliusage.Record) {
	if r.busy.Add(1) > 1 {
		r.overlap.Store(true)
	}
	defer r.busy.Add(-1)
	time.Sleep(5 * time.Millisecond) // a slow plugin, so two records at once would overlap
	r.mu.Lock()
	r.records = append(r.records, record)
	r.mu.Unlock()
}

// sharedProxy is the one proxy the tests share, started by the first test that needs it and
// stopped by TestMain.
var sharedProxy struct {
	once    sync.Once
	url     string
	manager *coreauth.Manager
	usage   *recorder
	stop    func()
	err     error
}

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedProxy.stop != nil {
		sharedProxy.stop()
	}
	os.Exit(code)
}

func startSharedProxy() error {
	dir, err := os.MkdirTemp("", "quota-pilot-contract-")
	if err != nil {
		return err
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	// One account per provider makes the proxy bind its Claude and Codex executors; each test then
	// adds its own accounts and these never serve.
	seed := func(name string) []map[string]any {
		return []map[string]any{{"api-key": "sk-seed", "base-url": "http://127.0.0.1:9/" + name}}
	}
	raw, err := yaml.Marshal(map[string]any{
		"host":               "127.0.0.1",
		"port":               port,
		"auth-dir":           filepath.Join(dir, "auths"),
		"api-keys":           []string{contractKey},
		"max-retry-interval": 30,
		"plugins":            map[string]any{"enabled": false, "dir": filepath.Join(dir, "plugins")},
		// The model catalogs from a file that does not exist: the proxy keeps its built-in ones and
		// never fetches them over the network.
		"models": map[string]string{"catalog": filepath.Join(dir, "none.json"), "codex-catalog": filepath.Join(dir, "none.json"),
			"devin-catalog": filepath.Join(dir, "none.json")},
		"claude-api-key": seed("seed-claude"),
		"codex-api-key":  seed("seed-codex"),
	})
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return err
	}
	var cfg sdkconfig.Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	manager := coreauth.NewManager(nil, nil, nil)
	started := make(chan struct{})
	svc, err := cliproxy.NewBuilder().WithConfig(&cfg).WithConfigPath(path).WithCoreAuthManager(manager).
		WithHooks(cliproxy.Hooks{OnAfterStart: func(*cliproxy.Service) { close(started) }}).
		// No file watcher: its reloads would put the proxy's own plugin host back as the scheduler.
		WithWatcherFactory(func(string, string, func(*sdkconfig.Config)) (*cliproxy.WatcherWrapper, error) {
			return &cliproxy.WatcherWrapper{}, nil
		}).Build()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = svc.Run(ctx)
	}()
	sharedProxy.stop = func() {
		cancel()
		<-done
		os.RemoveAll(dir)
	}
	select {
	case <-started:
	case <-time.After(20 * time.Second):
		return errors.New("the proxy did not start")
	}
	for _, auth := range manager.List() {
		auth.Disabled = true
		if _, err := manager.Update(ctx, auth); err != nil {
			return err
		}
	}
	sharedProxy.url, sharedProxy.manager, sharedProxy.usage = fmt.Sprintf("http://127.0.0.1:%d", port), manager, &recorder{}
	cliusage.RegisterPlugin(sharedProxy.usage)
	return nil
}

// contractService is the shared proxy with this test's accounts, upstream and scheduler.
type contractService struct {
	url       string
	manager   *coreauth.Manager
	scheduler *stubScheduler
	names     map[string]string // auth id to account name
}

var accountSerial atomic.Int64

// startContractService gives the shared proxy fresh accounts A, B and C (Claude) and X (Codex)
// at a new stub upstream, with `retry` request-retry rounds.
func startContractService(t *testing.T, retry int, script map[string][]upstreamReply) *contractService {
	t.Helper()
	sharedProxy.once.Do(func() { sharedProxy.err = startSharedProxy() })
	if sharedProxy.err != nil {
		t.Fatal(sharedProxy.err)
	}
	upstream := &stubUpstream{script: script}
	server := &http.Server{Handler: upstream}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	base := "http://" + listener.Addr().String()

	s := &contractService{url: sharedProxy.url, manager: sharedProxy.manager, names: map[string]string{}}
	s.manager.SetRetryConfig(retry, 30*time.Second, 0)
	registry := cliproxy.GlobalModelRegistry()
	serial := accountSerial.Add(1)
	for _, a := range []struct {
		name, provider string
		models         []string
	}{
		{"A", "claude", []string{contractModel, contractOtherModel}},
		{"B", "claude", []string{contractModel, contractOtherModel}},
		{"C", "claude", []string{contractModel, contractOtherModel}},
		{"X", "codex", []string{contractCodexModel}},
	} {
		// As the proxy builds an API-key account from its config (synthesizer: api_key, base_url).
		auth := &coreauth.Auth{ID: fmt.Sprintf("%s:apikey:contract-%d-%s", a.provider, serial, a.name), Provider: a.provider,
			Label: a.provider + "-apikey", Status: coreauth.StatusActive,
			Attributes: map[string]string{"api_key": "sk-" + a.name, "auth_kind": "apikey", "base_url": base + "/" + a.name}}
		if _, err := s.manager.Register(context.Background(), auth); err != nil {
			t.Fatal(err)
		}
		var infos []*cliproxy.ModelInfo
		for _, model := range a.models {
			infos = append(infos, &cliproxy.ModelInfo{ID: model})
		}
		registry.RegisterClient(auth.ID, a.provider, infos)
		s.names[auth.ID] = a.name
		t.Cleanup(func() {
			registry.UnregisterClient(auth.ID)
			s.manager.Remove(context.Background(), auth.ID)
		})
	}
	s.scheduler = &stubScheduler{answer: s.pickA}
	s.manager.SetPluginScheduler(s.scheduler)
	return s
}

// records returns the first n usage records of this test's accounts.
func (s *contractService) records(t *testing.T, n int) []cliusage.Record {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var got []cliusage.Record
		sharedProxy.usage.mu.Lock()
		for _, r := range sharedProxy.usage.records {
			if _, ours := s.names[r.AuthID]; ours {
				got = append(got, r)
			}
		}
		sharedProxy.usage.mu.Unlock()
		if len(got) >= n {
			return got[:n]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("fewer than %d usage records", n)
	return nil
}

func (s *contractService) id(name string) string {
	for id, n := range s.names {
		if n == name {
			return id
		}
	}
	return ""
}

func (s *contractService) offered(req pluginapi.SchedulerPickRequest) string {
	var names []string
	for _, c := range req.Candidates {
		names = append(names, s.names[c.ID])
	}
	slices.Sort(names)
	return strings.Join(names, "")
}

func (s *contractService) pickA(req pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
	if strings.Contains(s.offered(req), "A") {
		return pluginapi.SchedulerPickResponse{AuthID: s.id("A"), Handled: true}
	}
	return pluginapi.SchedulerPickResponse{AuthID: req.Candidates[0].ID, Handled: true}
}

func (s *contractService) declineWithoutA(req pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
	if strings.Contains(s.offered(req), "A") {
		return pluginapi.SchedulerPickResponse{AuthID: s.id("A"), Handled: true}
	}
	return pluginapi.SchedulerPickResponse{Handled: true, Reject: true, RejectReason: declineReason}
}

// post sends a streaming request as Claude Code (or Codex, for the Codex model) does and reads the
// whole response; cancelAfter, when set, cancels it as a client does.
func (s *contractService) post(t *testing.T, model string, cancelAfter time.Duration) {
	t.Helper()
	path, body := "/v1/messages", fmt.Sprintf(`{"model":%q,"max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, model)
	if model == contractCodexModel {
		path, body = "/v1/responses", fmt.Sprintf(`{"model":%q,"stream":true,"input":"hi"}`, model)
	}
	ctx := context.Background()
	if cancelAfter > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, cancelAfter)
		defer cancel()
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.url+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+contractKey)
	req.Header.Set("X-Claude-Code-Session-Id", "s1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
}

func TestTheProxyServesAContractRequestThroughItsRealExecutor(t *testing.T) {
	s := startContractService(t, 3, nil)
	s.post(t, contractModel, 0)
	r := s.records(t, 1)[0]
	if r.Failed || s.names[r.AuthID] != "A" || r.Detail.InputTokens != 1200 || r.TraceID == "" {
		t.Fatalf("record %+v", r)
	}
}

// Point 3: the records of one request reach the usage plugin in the order they were published, the
// failed attempt before the retry's success, one at a time.
func TestUsageRecordsReachThePluginInOrderOneAtATime(t *testing.T) {
	s := startContractService(t, 3, map[string][]upstreamReply{"A": {dropped(0)}})
	s.scheduler.answer = s.declineWithoutA
	s.post(t, contractModel, 0)
	got := s.records(t, 2)
	if !got[0].Failed || got[1].Failed || s.names[got[0].AuthID] != "A" || s.names[got[1].AuthID] != "A" {
		t.Fatalf("records %+v", got)
	}
	if got[0].TraceID == "" || got[1].TraceID != got[0].TraceID {
		t.Fatalf("traces %q, %q", got[0].TraceID, got[1].TraceID)
	}
	t.Run("one at a time", func(t *testing.T) {
		id := s.id("B")
		for i := range 20 {
			cliusage.PublishRecord(context.Background(), cliusage.Record{AuthID: id, RequestID: fmt.Sprint(i)})
		}
		all := s.records(t, 22)
		for i, r := range all[2:] {
			if r.RequestID != fmt.Sprint(i) {
				t.Fatalf("record %d is %s", i, r.RequestID)
			}
		}
		if sharedProxy.usage.overlap.Load() {
			t.Fatal("the plugin handled two records at once")
		}
	})
}

// Point 6, through the real Claude executor: an Anthropic 429 with a unified rate-limit rejection
// on one model limits the whole credential, so A is absent from every model's picks.
func TestAUnifiedRateLimitRejectionLeavesTheAccountOutForEveryModel(t *testing.T) {
	s := startContractService(t, 0, map[string][]upstreamReply{"A": {unifiedRejection}})
	s.post(t, contractModel, 0)
	before := len(s.scheduler.requests())
	s.post(t, contractOtherModel, 0)
	if got := s.offered(s.scheduler.requests()[before]); got != "BC" {
		t.Fatalf("the next pick for %s offered %s", contractOtherModel, got)
	}
}

// Point 8: what the failure record of a broken stream carries, and that its ttft tells a broken
// answer from a hang.
func TestABrokenStreamsRecordTellsABrokenAnswerFromAHang(t *testing.T) {
	const text, drop = 200 * time.Millisecond, 1500 * time.Millisecond
	cases := []struct {
		name   string
		model  string
		reply  upstreamReply
		status int           // the record's failure status
		tokens int64         // input tokens the record carries
		ttft   time.Duration // 0: absent; else the least it is
		under  time.Duration // the most it is, when present
	}{
		{"a Claude stream dropped after its text keeps the usage seen and an early ttft", contractModel,
			brokenStream(claudeStart, text, claudeText, drop), 0, 1200, 1, drop / 2},
		{"a Codex stream dropped after its text is a 408 with no tokens and an early ttft", contractCodexModel,
			brokenStream("", text, codexText, drop), 408, 0, 1, drop / 2},
		{"a Claude 504 after silence has its ttft at the 504", contractModel, silentThen504(drop), 504, 0, drop, 2 * drop},
		{"a Codex 504 after silence has its ttft at the 504", contractCodexModel, silentThen504(drop), 504, 0, drop, 2 * drop},
		{"a Claude connection dropped after silence has no ttft", contractModel, dropped(drop), 0, 0, 0, 0},
		{"a Codex connection dropped after silence has no ttft", contractCodexModel, dropped(drop), 0, 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			account := "A"
			if c.model == contractCodexModel {
				account = "X"
			}
			s := startContractService(t, 0, map[string][]upstreamReply{account: {c.reply}})
			if account == "A" {
				s.scheduler.answer = s.declineWithoutA
			}
			s.post(t, c.model, 0)
			r := s.records(t, 1)[0]
			if !r.Failed || s.names[r.AuthID] != account || r.Fail.StatusCode != c.status || r.Detail.InputTokens != c.tokens {
				t.Fatalf("record %+v", r)
			}
			if c.tokens > 0 && (r.Detail.CacheReadTokens != 800 || r.Detail.CacheCreationTokens != 300) {
				t.Fatalf("cache tokens %+v", r.Detail)
			}
			if c.ttft == 0 && r.TTFT != 0 || c.ttft > 0 && (r.TTFT < c.ttft || r.TTFT > c.under) {
				t.Fatalf("ttft %v, want %v to %v; latency %v", r.TTFT, c.ttft, c.under, r.Latency)
			}
		})
	}
}

// Point 10: a client cancel during an attempt publishes a failure record with status 499 and its
// wait, with no ttft when nothing came and one when the stream had started.
func TestAClientCancelRecords499WithItsWait(t *testing.T) {
	const wait = 700 * time.Millisecond
	cases := []struct {
		name  string
		reply upstreamReply
		ttft  bool
	}{
		{"a cancel before any byte has no ttft", heldUntilGone(""), false},
		{"a cancel after the stream started has a ttft", heldUntilGone(claudeStart), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := startContractService(t, 3, map[string][]upstreamReply{"A": {c.reply}})
			s.scheduler.answer = s.declineWithoutA
			s.post(t, contractModel, wait)
			r := s.records(t, 1)[0]
			if !r.Failed || r.Fail.StatusCode != 499 || r.Latency < wait-50*time.Millisecond || r.Latency > 3*wait || (r.TTFT > 0) != c.ttft {
				t.Fatalf("record failed %v, status %d, latency %v, ttft %v", r.Failed, r.Fail.StatusCode, r.Latency, r.TTFT)
			}
		})
	}
}
