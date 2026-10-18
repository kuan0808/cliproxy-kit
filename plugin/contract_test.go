package main

// The proxy contract: what CLIProxyAPI does around an attempt that failed and a pick quota-pilot
// declines, which the retry rule relies on (docs/adr/0003), and the proxy verdicts quota-pilot
// ports (core/faults.go). The proxy's own account manager and API handlers run in-process: stub
// executors serve three Claude accounts, A, B and C, and two Codex accounts, X and Y, and stub
// hooks stand where quota-pilot's scheduler, interceptor and router plug in. A proxy update that
// changes any of this fails here before it breaks a retry. contract_service_test.go runs the whole
// proxy, with its real executors, against a stub upstream.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	cliusage "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const (
	contractModel      = "claude-opus-5-5"
	contractOtherModel = "claude-sonnet-5-5"
	contractCodexModel = "gpt-6.1-sol"
	declineReason      = "quota-pilot: retrying A"
)

// upstreamFailure is an attempt's failure as an executor reports it: a status, the error body,
// a Retry-After when the upstream sent one, and whether it limits the whole credential (as an
// Anthropic unified rate-limit rejection does).
type upstreamFailure struct {
	status     int
	body       string
	retryAfter *time.Duration
	scoped     bool
}

func (e *upstreamFailure) Error() string {
	if e.body != "" {
		return e.body
	}
	return fmt.Sprintf("upstream returned %d", e.status)
}
func (e *upstreamFailure) StatusCode() int            { return e.status }
func (e *upstreamFailure) RetryAfter() *time.Duration { return e.retryAfter }
func (e *upstreamFailure) IsCredentialScoped() bool   { return e.scoped }

func status(code int) *upstreamFailure { return &upstreamFailure{status: code} }

// Failures an attempt can end with that carry no status.
var (
	errEOF      = fmt.Errorf("read upstream: %w", io.EOF)
	errReset    = fmt.Errorf("read upstream: %w", syscall.ECONNRESET)
	errDeadline = fmt.Errorf("upstream: %w", context.DeadlineExceeded)
)

// attempt is how one attempt on an account ends: after `after`, with `err`, or answering when err
// is nil.
type attempt struct {
	after time.Duration
	err   error
}

func failing(errs ...error) []attempt {
	out := make([]attempt, 0, len(errs))
	for _, err := range errs {
		out = append(out, attempt{err: err})
	}
	return out
}

// executorCall is what an attempt carried: the account, the model the executor ran and the
// client's model, which its usage record names as Alias.
type executorCall struct {
	auth, model, alias string
}

// stubExecutor answers each attempt from a script per account, then answers once it is spent; a
// stream's first chunk comes `firstChunkAfter` after the stream opened. Each attempt publishes a
// bare usage record to `usage`, which fills in its trace id from the context as for a real
// executor's record (usage/manager.go:400; the executors' reporter reads the same, usage_helpers.go:112).
type stubExecutor struct {
	provider        string
	firstChunkAfter time.Duration
	usage           *cliusage.Manager
	// observed, when set, hears of each attempt as quota-pilot's usage plugin would.
	observed func(auth string, failed bool)
	mu       sync.Mutex
	script   map[string][]attempt
	calls    []executorCall
}

func (e *stubExecutor) Identifier() string { return e.provider }

func (e *stubExecutor) next(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request) error {
	e.mu.Lock()
	alias := cliusage.RequestedModelAliasFromContext(ctx)
	e.calls = append(e.calls, executorCall{auth: auth.ID, model: req.Model, alias: alias})
	var a attempt
	if left := e.script[auth.ID]; len(left) > 0 {
		a, e.script[auth.ID] = left[0], left[1:]
	}
	e.mu.Unlock()
	if a.after > 0 {
		time.Sleep(a.after)
	}
	if a.err != nil {
		cliproxyexecutor.MarkUpstreamAttempt(ctx)
	}
	if e.usage != nil {
		e.usage.Publish(ctx, cliusage.Record{Provider: e.provider, AuthID: auth.ID, Model: req.Model, Alias: alias, Failed: a.err != nil})
	}
	if e.observed != nil {
		e.observed(auth.ID, a.err != nil)
	}
	return a.err
}

func (e *stubExecutor) Execute(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, _ cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	if err := e.next(ctx, auth, req); err != nil {
		return cliproxyexecutor.Response{}, err
	}
	return cliproxyexecutor.Response{Payload: []byte(`{"ok":"` + auth.ID + `"}`)}, nil
}

func (e *stubExecutor) ExecuteStream(ctx context.Context, auth *coreauth.Auth, req cliproxyexecutor.Request, _ cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if err := e.next(ctx, auth, req); err != nil {
		return nil, err
	}
	chunks := make(chan cliproxyexecutor.StreamChunk, 1)
	go func() {
		defer close(chunks)
		time.Sleep(e.firstChunkAfter)
		chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("event: message_start\ndata: {\"type\":\"message_start\",\"by\":\"" + auth.ID + "\"}\n\n")}
	}()
	return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
}

func (e *stubExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	return auth, nil
}

func (e *stubExecutor) CountTokens(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, errors.New("not counted")
}

func (e *stubExecutor) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("no http")
}

func (e *stubExecutor) attempts() []executorCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]executorCall(nil), e.calls...)
}

func (e *stubExecutor) accounts() []string {
	var out []string
	for _, c := range e.attempts() {
		out = append(out, c.auth)
	}
	return out
}

// stubScheduler stands where quota-pilot's scheduler plugs in: it answers each pick with `answer`
// and keeps every pick request, so a test can see what the manager offered.
type stubScheduler struct {
	mu     sync.Mutex
	picks  []pluginapi.SchedulerPickRequest
	answer func(pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse
}

func (s *stubScheduler) PickAuth(_ context.Context, req pluginapi.SchedulerPickRequest) (pluginapi.SchedulerPickResponse, bool, error) {
	s.mu.Lock()
	s.picks = append(s.picks, req)
	answer := s.answer
	s.mu.Unlock()
	resp := answer(req)
	return resp, resp.Handled, nil
}

func (s *stubScheduler) requests() []pluginapi.SchedulerPickRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]pluginapi.SchedulerPickRequest(nil), s.picks...)
}

// offers lists, for each pick so far, the accounts it offered, as "ABC".
func (s *stubScheduler) offers() []string {
	var out []string
	for _, req := range s.requests() {
		out = append(out, offeredIDs(req))
	}
	return out
}

func offeredIDs(req pluginapi.SchedulerPickRequest) string {
	ids := make([]string, 0, len(req.Candidates))
	for _, c := range req.Candidates {
		ids = append(ids, c.ID)
	}
	sort.Strings(ids)
	return strings.Join(ids, "")
}

// pickA answers A whenever it is offered, else the first account offered.
func pickA(req pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
	if strings.Contains(offeredIDs(req), "A") {
		return pluginapi.SchedulerPickResponse{AuthID: "A", Handled: true}
	}
	return pluginapi.SchedulerPickResponse{AuthID: req.Candidates[0].ID, Handled: true}
}

// declineWithoutA answers A, as for a session bound to A, and declines every pick that does not
// offer A, as the retry rule does.
func declineWithoutA(req pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
	if strings.Contains(offeredIDs(req), "A") {
		return pluginapi.SchedulerPickResponse{AuthID: "A", Handled: true}
	}
	return pluginapi.SchedulerPickResponse{Handled: true, Reject: true, RejectReason: declineReason}
}

// stubHooks stands where quota-pilot's interceptor and model router plug in: it keeps what each
// request showed Intercept, changes nothing, and routes as `route` says.
type stubHooks struct {
	mu          sync.Mutex
	intercepted []pluginapi.RequestInterceptRequest
	route       *pluginapi.ModelRouteResponse
}

func (h *stubHooks) InterceptRequestBeforeAuth(_ context.Context, req pluginapi.RequestInterceptRequest) pluginapi.RequestInterceptResponse {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.intercepted = append(h.intercepted, req)
	return pluginapi.RequestInterceptResponse{}
}

func (h *stubHooks) InterceptRequestAfterAuth(context.Context, pluginapi.RequestInterceptRequest) pluginapi.RequestInterceptResponse {
	return pluginapi.RequestInterceptResponse{}
}

func (h *stubHooks) InterceptResponse(context.Context, pluginapi.ResponseInterceptRequest) pluginapi.ResponseInterceptResponse {
	return pluginapi.ResponseInterceptResponse{}
}

func (h *stubHooks) InterceptStreamChunk(context.Context, pluginapi.StreamChunkInterceptRequest) pluginapi.StreamChunkInterceptResponse {
	return pluginapi.StreamChunkInterceptResponse{}
}

func (h *stubHooks) HasModelRouters() bool { return h.route != nil }

func (h *stubHooks) RouteModel(context.Context, pluginapi.ModelRouteRequest) (pluginapi.ModelRouteResponse, bool) {
	if h.route == nil {
		return pluginapi.ModelRouteResponse{}, false
	}
	return *h.route, true
}

func (h *stubHooks) requests() []pluginapi.RequestInterceptRequest {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]pluginapi.RequestInterceptRequest(nil), h.intercepted...)
}

type contractSetup struct {
	retry, maxCredentials int
	script                map[string][]attempt
	answer                func(pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse
	settingsA             map[string]any // account A's own settings, such as a request_retry override
	aliases               map[string][]sdkconfig.OAuthModelAlias
	firstChunkAfter       time.Duration
	records               bool // publish each attempt's usage record to `records`
}

// contractProxy is the proxy's account manager and API handlers with the stubs in place.
type contractProxy struct {
	manager   *coreauth.Manager
	claude    *stubExecutor
	codex     *stubExecutor
	scheduler *stubScheduler
	hooks     *stubHooks
	messages  *claude.ClaudeCodeAPIHandler
	responses *openai.OpenAIResponsesAPIHandler
	records   chan cliusage.Record
}

type usageRecorder chan cliusage.Record

func (r usageRecorder) HandleUsage(_ context.Context, record cliusage.Record) { r <- record }

// record returns the next usage record the stub executors published.
func (p *contractProxy) record(t *testing.T) cliusage.Record {
	t.Helper()
	select {
	case r := <-p.records:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("no usage record")
		return cliusage.Record{}
	}
}

func newContractProxy(t *testing.T, s contractSetup) *contractProxy {
	t.Helper()
	ctx := context.Background()
	m := coreauth.NewManager(nil, nil, nil)
	m.SetRetryConfig(s.retry, 30*time.Second, s.maxCredentials)
	if s.script == nil {
		s.script = map[string][]attempt{}
	}
	if s.answer == nil {
		s.answer = pickA
	}
	p := &contractProxy{
		manager:   m,
		claude:    &stubExecutor{provider: "claude", script: s.script, firstChunkAfter: s.firstChunkAfter},
		codex:     &stubExecutor{provider: "codex", script: s.script},
		scheduler: &stubScheduler{answer: s.answer},
		hooks:     &stubHooks{},
	}
	if s.records {
		p.records = make(chan cliusage.Record, 16)
		queue := cliusage.NewManager(16)
		queue.Register(usageRecorder(p.records))
		queue.Start(ctx)
		t.Cleanup(queue.Stop)
		p.claude.usage, p.codex.usage = queue, queue
	}
	m.RegisterExecutor(p.claude)
	m.RegisterExecutor(p.codex)
	m.SetPluginScheduler(p.scheduler)
	if s.aliases != nil {
		m.SetOAuthModelAlias(s.aliases)
	}
	registry := cliproxy.GlobalModelRegistry()
	accounts := []struct {
		id, provider string
		models       []string
	}{
		{"A", "claude", []string{contractModel, contractOtherModel, "team-opus"}},
		{"B", "claude", []string{contractModel, contractOtherModel, "team-opus"}},
		{"C", "claude", []string{contractModel, contractOtherModel, "team-opus"}},
		{"X", "codex", []string{contractCodexModel}},
		{"Y", "codex", []string{contractCodexModel}},
	}
	for _, a := range accounts {
		auth := &coreauth.Auth{ID: a.id, Provider: a.provider, Status: coreauth.StatusActive}
		if a.id == "A" {
			auth.Metadata = s.settingsA
		}
		if _, err := m.Register(ctx, auth); err != nil {
			t.Fatal(err)
		}
		var infos []*cliproxy.ModelInfo
		for _, model := range a.models {
			infos = append(infos, &cliproxy.ModelInfo{ID: model})
		}
		registry.RegisterClient(a.id, a.provider, infos)
	}
	t.Cleanup(func() {
		for _, a := range accounts {
			registry.UnregisterClient(a.id)
		}
	})
	base := handlers.NewBaseAPIHandlers(&sdkconfig.SDKConfig{}, m)
	base.SetPluginHost(p.hooks)
	base.SetModelRouterHost(p.hooks)
	p.messages = claude.NewClaudeCodeAPIHandler(base)
	p.responses = openai.NewOpenAIResponsesAPIHandler(base)
	return p
}

// send posts one Claude Code request for the model and returns what the client got.
func (p *contractProxy) send(model string) *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, model)
	return serve(p.messages.ClaudeMessages, "/v1/messages", body)
}

// compact posts one Codex compact request.
func (p *contractProxy) compact() *httptest.ResponseRecorder {
	body := fmt.Sprintf(`{"model":%q,"input":"hi"}`, contractCodexModel)
	return serve(p.responses.Compact, "/v1/responses/compact", body)
}

var traces atomic.Int64

func serve(handler gin.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	// The trace id, as the server's request-id middleware sets it (internal/logging/requestid.go:16).
	c.Set("__request_id__", fmt.Sprintf("trace-%d", traces.Add(1)))
	c.Request = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Set("X-Claude-Code-Session-Id", "s1")
	handler(c)
	return w
}

// nextOffer sends a request for the model and returns what its first pick offered.
func (p *contractProxy) nextOffer(model string) string {
	before := len(p.scheduler.requests())
	p.send(model)
	return offeredIDs(p.scheduler.requests()[before])
}

// cooldowns returns the proxy's view of the account's cooldowns, keyed by model ("" for the whole
// account), each with its reason.
func (p *contractProxy) cooldowns(id string) map[string]coreauth.CooldownView {
	auth, _ := p.manager.GetByID(id)
	out := map[string]coreauth.CooldownView{}
	for _, v := range coreauth.CooldownSnapshotForAuth(auth, time.Now()) {
		out[v.ModelKey] = v
	}
	return out
}

func TestAContractRequestIsServedByThePickedAccount(t *testing.T) {
	p := newContractProxy(t, contractSetup{retry: 3})
	w := p.send(contractModel)
	if w.Code != http.StatusOK || w.Body.String() != `{"ok":"A"}` || len(p.scheduler.offers()) != 1 {
		t.Fatalf("got %d %s, picks %v", w.Code, w.Body, p.scheduler.offers())
	}
}

// classCase is one failure on A's first attempt, with the session bound to A: the picks that
// follow (each the accounts it offered) and what reaches the client.
type classCase struct {
	name   string
	fails  error
	offers []string
	status int
}

// runClassCases fails A's first attempt (or its first `failuresOnA` attempts) with each case's
// failure while the scheduler declines every pick without A.
func runClassCases(t *testing.T, s contractSetup, failuresOnA int, cases []classCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := s
			s.answer = declineWithoutA
			s.script = map[string][]attempt{"A": failing(slices.Repeat([]error{c.fails}, failuresOnA)...)}
			p := newContractProxy(t, s)
			w := p.send(contractModel)
			if got := p.scheduler.offers(); !slices.Equal(got, c.offers) {
				t.Errorf("picks offered %v, want %v", got, c.offers)
			}
			if w.Code != c.status {
				t.Errorf("client got %d, want %d", w.Code, c.status)
			}
			body := w.Body.String()
			if c.status == http.StatusOK {
				if body != `{"ok":"A"}` {
					t.Errorf("client got %s, want A's answer", body)
				}
				return
			}
			if !strings.Contains(body, c.fails.Error()) || strings.Contains(body, declineReason) {
				t.Errorf("client got %s, want A's failure %q", body, c.fails.Error())
			}
		})
	}
}

// The proxy's request-retry rounds retry a connection error and 408, 429, 500, 502, 503 and 504.
// After a connection error A is offered again at once, so the retry stays inside the request; after
// a status that cools A the round runs without it and the declined pick hands the failure back.
func TestADeclineAfterAFailureWithThreeRetryRounds(t *testing.T) {
	ra := 120 * time.Second
	runClassCases(t, contractSetup{retry: 3}, 1, []classCase{
		{"a dropped connection is retried on A in the next round", errEOF, []string{"ABC", "BC", "ABC"}, 200},
		{"a reset connection is retried on A in the next round", errReset, []string{"ABC", "BC", "ABC"}, 200},
		{"a bare deadline goes back to the client with no further round", errDeadline, []string{"ABC", "BC"}, 504},
		{"a 408 cools A and goes back to the client after a round without it", status(408), []string{"ABC", "BC", "BC"}, 408},
		{"a 429 cools A and goes back to the client after a round without it", status(429), []string{"ABC", "BC", "BC"}, 429},
		{"a 500 cools A and goes back to the client after a round without it", status(500), []string{"ABC", "BC", "BC"}, 500},
		{"a 502 cools A and goes back to the client after a round without it", status(502), []string{"ABC", "BC", "BC"}, 502},
		{"a 503 cools A and goes back to the client after a round without it", status(503), []string{"ABC", "BC", "BC"}, 503},
		{"a 503 with Retry-After goes back to the client after a round without A", &upstreamFailure{status: 503, retryAfter: &ra}, []string{"ABC", "BC", "BC"}, 503},
		{"a 504 cools A and goes back to the client after a round without it", status(504), []string{"ABC", "BC", "BC"}, 504},
		{"a 520 goes back to the client with no further round", status(520), []string{"ABC", "BC"}, 520},
		{"a 529 goes back to the client with no further round", status(529), []string{"ABC", "BC"}, 529},
		{"a 418 goes back to the client with no further round", status(418), []string{"ABC", "BC"}, 418},
	})
}

func TestADeclineAfterAFailureWithNoRetryRounds(t *testing.T) {
	runClassCases(t, contractSetup{retry: 0}, 1, []classCase{
		{"a dropped connection goes back to the client", errEOF, []string{"ABC", "BC"}, 500},
		{"a reset connection goes back to the client", errReset, []string{"ABC", "BC"}, 500},
		{"a bare deadline goes back to the client", errDeadline, []string{"ABC", "BC"}, 504},
		{"a 408 goes back to the client", status(408), []string{"ABC", "BC"}, 408},
		{"a 429 goes back to the client", status(429), []string{"ABC", "BC"}, 429},
		{"a 500 goes back to the client", status(500), []string{"ABC", "BC"}, 500},
		{"a 502 goes back to the client", status(502), []string{"ABC", "BC"}, 502},
		{"a 503 goes back to the client", status(503), []string{"ABC", "BC"}, 503},
		{"a 504 goes back to the client", status(504), []string{"ABC", "BC"}, 504},
		{"a 520 goes back to the client", status(520), []string{"ABC", "BC"}, 520},
		{"a 529 goes back to the client", status(529), []string{"ABC", "BC"}, 529},
		{"a 418 goes back to the client", status(418), []string{"ABC", "BC"}, 418},
	})
}

// An account's own request_retry of 0 keeps the proxy's rounds, but A is left out of them.
func TestADeclineAfterAFailureWhenAccountAOverridesRetryToZero(t *testing.T) {
	setup := contractSetup{retry: 3, settingsA: map[string]any{"request_retry": 0}}
	runClassCases(t, setup, 1, []classCase{
		{"a dropped connection goes back to the client after a round without A", errEOF, []string{"ABC", "BC", "BC"}, 500},
		{"a reset connection goes back to the client after a round without A", errReset, []string{"ABC", "BC", "BC"}, 500},
		{"a bare deadline goes back to the client with no further round", errDeadline, []string{"ABC", "BC"}, 504},
		{"a 408 goes back to the client after a round without A", status(408), []string{"ABC", "BC", "BC"}, 408},
		{"a 429 goes back to the client after a round without A", status(429), []string{"ABC", "BC", "BC"}, 429},
		{"a 500 goes back to the client after a round without A", status(500), []string{"ABC", "BC", "BC"}, 500},
		{"a 502 goes back to the client after a round without A", status(502), []string{"ABC", "BC", "BC"}, 502},
		{"a 503 goes back to the client after a round without A", status(503), []string{"ABC", "BC", "BC"}, 503},
		{"a 504 goes back to the client after a round without A", status(504), []string{"ABC", "BC", "BC"}, 504},
		{"a 520 goes back to the client with no further round", status(520), []string{"ABC", "BC"}, 520},
		{"a 529 goes back to the client with no further round", status(529), []string{"ABC", "BC"}, 529},
		{"a 418 goes back to the client with no further round", status(418), []string{"ABC", "BC"}, 418},
	})
}

// With one retry round, a second failure on A has no round left.
func TestADeclineAfterAFailureWhenTheRoundsAreSpent(t *testing.T) {
	runClassCases(t, contractSetup{retry: 1}, 2, []classCase{
		{"a dropped connection on the last round goes back to the client", errEOF, []string{"ABC", "BC", "ABC", "BC"}, 500},
		{"a reset connection on the last round goes back to the client", errReset, []string{"ABC", "BC", "ABC", "BC"}, 500},
		{"a bare deadline goes back to the client", errDeadline, []string{"ABC", "BC"}, 504},
		{"a 503 goes back to the client after the last round without A", status(503), []string{"ABC", "BC", "BC"}, 503},
		{"a 529 goes back to the client", status(529), []string{"ABC", "BC"}, 529},
	})
}

// With max-retry-credentials 1 a round tries one account, so no pick follows A's failure in it:
// nothing is declined, and the next round decides.
func TestADeclineAfterAFailureWhenTheCredentialCapIsSpent(t *testing.T) {
	runClassCases(t, contractSetup{retry: 3, maxCredentials: 1}, 1, []classCase{
		{"a dropped connection is retried on A in the next round", errEOF, []string{"ABC", "ABC"}, 200},
		{"a reset connection is retried on A in the next round", errReset, []string{"ABC", "ABC"}, 200},
		{"a bare deadline goes back to the client with no further pick", errDeadline, []string{"ABC"}, 504},
		{"a 408 goes back to the client after a round without A", status(408), []string{"ABC", "BC"}, 408},
		{"a 429 goes back to the client after a round without A", status(429), []string{"ABC", "BC"}, 429},
		{"a 500 goes back to the client after a round without A", status(500), []string{"ABC", "BC"}, 500},
		{"a 502 goes back to the client after a round without A", status(502), []string{"ABC", "BC"}, 502},
		{"a 503 goes back to the client after a round without A", status(503), []string{"ABC", "BC"}, 503},
		{"a 504 goes back to the client after a round without A", status(504), []string{"ABC", "BC"}, 504},
		{"a 520 goes back to the client with no further pick", status(520), []string{"ABC"}, 520},
		{"a 529 goes back to the client with no further pick", status(529), []string{"ABC"}, 529},
		{"a 418 goes back to the client with no further pick", status(418), []string{"ABC"}, 418},
	})
}

// Without a decline, as for every failure the retry rule leaves alone, the request moves to
// another account within the same round.
func TestWithoutADeclineAFailureMovesToAnotherAccountAtOnce(t *testing.T) {
	for _, fails := range []error{status(418), status(529), errDeadline} {
		t.Run(fails.Error(), func(t *testing.T) {
			p := newContractProxy(t, contractSetup{retry: 3, script: map[string][]attempt{"A": failing(fails)}})
			w := p.send(contractModel)
			if w.Code != http.StatusOK || w.Body.String() != `{"ok":"B"}` || !slices.Equal(p.scheduler.offers(), []string{"ABC", "BC"}) {
				t.Fatalf("got %d %s, picks %v", w.Code, w.Body, p.scheduler.offers())
			}
		})
	}
}

// Point 1: a decline before any attempt fails the request with the scheduler's reason and a 503.
func TestADeclineOnARequestsFirstPickFailsItWith503AndTheReason(t *testing.T) {
	p := newContractProxy(t, contractSetup{retry: 3, answer: func(pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
		return pluginapi.SchedulerPickResponse{Handled: true, Reject: true, RejectReason: declineReason}
	}})
	w := p.send(contractModel)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), declineReason) || len(p.claude.attempts()) != 0 {
		t.Fatalf("got %d %s, attempts %v", w.Code, w.Body, p.claude.accounts())
	}
}

// Point 2: the pick that follows a failed attempt in the same round names the account just tried;
// the next round's first pick does not. Ticket 04 does not depend on it.
func TestThePickAfterAFailedAttemptNamesTheAccountJustTried(t *testing.T) {
	p := newContractProxy(t, contractSetup{retry: 3, answer: declineWithoutA,
		script: map[string][]attempt{"A": failing(errEOF)}})
	p.send(contractModel)
	picks := p.scheduler.requests()
	if len(picks) != 3 {
		t.Fatalf("picks %v", p.scheduler.offers())
	}
	named := func(req pluginapi.SchedulerPickRequest) any { return req.Options.Metadata["selected_auth_id"] }
	if named(picks[0]) != nil || named(picks[1]) != "A" || named(picks[2]) != nil {
		t.Fatalf("selected_auth_id by pick: %v, %v, %v", named(picks[0]), named(picks[1]), named(picks[2]))
	}
}

// Point 4: a pick carries no request or trace id of the proxy's, so a retry episode is scoped to
// the binding.
func TestAPickCarriesNoRequestOrTraceID(t *testing.T) {
	p := newContractProxy(t, contractSetup{retry: 3})
	p.send(contractModel)
	trace := p.hooks.requests()[0].TraceID
	pick := p.scheduler.requests()[0]
	if trace == "" {
		t.Fatal("Intercept saw no trace id")
	}
	for key, value := range pick.Options.Metadata {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "request_id") || strings.Contains(lower, "trace") || fmt.Sprint(value) == trace {
			t.Errorf("pick metadata %s = %v", key, value)
		}
	}
	// The pick carries the client's own headers as sent, and nothing of the proxy's.
	for key, values := range pick.Options.Headers {
		if slices.Contains(values, trace) || key == "X-Request-Id" {
			t.Errorf("pick header %s = %v", key, values)
		}
	}
}

// verdict is what the proxy concluded from one failure on A, read from what it did.
type verdict struct {
	requestFault bool   // the request failed with no failover and A was left alone
	reason       string // the reason of A's cooldown for the model, "" for none
}

func proxyVerdict(t *testing.T, failure *upstreamFailure, after time.Duration) verdict {
	t.Helper()
	p := newContractProxy(t, contractSetup{retry: 3, script: map[string][]attempt{"A": {{after: after, err: failure}}}})
	p.send(contractModel)
	v := verdict{reason: p.cooldowns("A")[contractModel].Reason}
	v.requestFault = slices.Equal(p.claude.accounts(), []string{"A"}) && len(p.cooldowns("A")) == 0
	return v
}

// Point 5: quota-pilot's request-fault and invalid_grant ports agree with the proxy on one corpus.
func TestTheRequestFaultAndSignInPortsAgreeWithTheProxy(t *testing.T) {
	cases := []struct {
		name         string
		failure      *upstreamFailure
		after        time.Duration
		requestFault bool
		reason       string
	}{
		{"a generic 400 is the request's fault", &upstreamFailure{status: 400, body: `{"error":{"message":"bad"}}`}, 0, true, ""},
		{"a 409 is the request's fault", status(409), 0, true, ""},
		{"a 413 is the request's fault", status(413), 0, true, ""},
		{"a 422 validation error is the request's fault", &upstreamFailure{status: 422, body: `{"error":{"type":"invalid_request_error","message":"messages: field required"}}`}, 0, true, ""},
		{"a request-fault body is the request's fault", &upstreamFailure{status: 400, body: `{"error":{"code":"context_length_exceeded","message":"too long"}}`}, 0, true, ""},
		{"a response item never stored is the request's fault", &upstreamFailure{status: 404, body: `{"error":{"message":"Item with id 'rs_1' not found. Items are not persisted when ` + "`store`" + ` is set to false."}}`}, 0, true, ""},
		{"a generic 404 cools the model for 12 hours", &upstreamFailure{status: 404, body: `{"error":{"type":"not_found_error","message":"not found"}}`}, 0, false, "not_found"},
		{"an invalid_grant 400 is a sign-in failure", &upstreamFailure{status: 400, body: `{"error":"invalid_grant","error_description":"refresh token revoked"}`}, 0, false, "invalid_grant"},
		{"an invalid_grant with no status is a sign-in failure", &upstreamFailure{body: "token refresh failed: invalid_grant"}, 0, false, "invalid_grant"},
		{"an invalid_grant with no status after 40 s is a sign-in failure", &upstreamFailure{body: "token refresh failed: invalid_grant"}, 40 * time.Second, false, "invalid_grant"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				got := proxyVerdict(t, c.failure, c.after)
				if got.requestFault != c.requestFault || got.reason != c.reason {
					t.Fatalf("proxy: request fault %v, cooldown %q; want %v, %q", got.requestFault, got.reason, c.requestFault, c.reason)
				}
				if port := core.RequestFault(c.failure.status, c.failure.body); port != got.requestFault {
					t.Errorf("RequestFault = %v, the proxy says %v", port, got.requestFault)
				}
				if port := core.InvalidGrant(c.failure.status, c.failure.Error()); port != (got.reason == "invalid_grant") {
					t.Errorf("InvalidGrant = %v, the proxy's cooldown is %q", port, got.reason)
				}
			})
		})
	}
}

// Point 5: quota-pilot's model port agrees with the proxy on whether the account does not serve
// the model, which cools that model and not the account.
func TestTheModelPortAgreesWithTheProxy(t *testing.T) {
	cases := []struct {
		name        string
		failure     *upstreamFailure
		unsupported bool
	}{
		{"a 422 model_not_found", &upstreamFailure{status: 422, body: `{"error":{"code":"model_not_found","message":"The model does not exist"}}`}, true},
		{"a 400 unknown_model", &upstreamFailure{status: 400, body: `{"error":{"code":"unknown_model","message":"Unknown model"}}`}, true},
		{"a 404 model_not_supported", &upstreamFailure{status: 404, body: `{"error":{"message":"model_not_supported"}}`}, true},
		{"a 400 not available for your plan", &upstreamFailure{status: 400, body: `{"error":{"message":"This model is not available for your plan"}}`}, true},
		// The proxy reads failures without the requested model, so this is a generic 404 to it.
		{"a not_found_error naming the model", &upstreamFailure{status: 404, body: `{"type":"error","error":{"type":"not_found_error","message":"model: ` + contractModel + `"}}`}, false},
		{"a 422 validation error not about the model", &upstreamFailure{status: 422, body: `{"error":{"type":"invalid_request_error","message":"max_tokens: must be positive"}}`}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := proxyVerdict(t, c.failure, 0)
			if (got.reason == "model_not_supported") != c.unsupported {
				t.Fatalf("proxy: cooldown %q, request fault %v; want unsupported %v", got.reason, got.requestFault, c.unsupported)
			}
			if port := core.ModelUnsupported(c.failure.status, c.failure.body); port != c.unsupported {
				t.Errorf("ModelUnsupported = %v, the proxy says %v", port, c.unsupported)
			}
		})
	}
}

// Point 6: a pick lists an account for a model only while the proxy would serve that model with
// it, which switch_back relies on.
func TestAPickListsAnAccountOnlyWhileTheProxyWouldServeTheModelWithIt(t *testing.T) {
	ra := 120 * time.Second
	cases := []struct {
		name    string
		fails   error
		model   string        // the model of the pick looked at, after the failure on contractModel
		at      time.Duration // when it is looked at, after the failure
		offered string
	}{
		{"after a 529 A is left out", status(529), contractModel, 59 * time.Second, "BC"},
		{"after a 529 A is listed again once the cooldown ends", status(529), contractModel, 61 * time.Second, "ABC"},
		{"after a 503 with Retry-After 120 A is still left out at 61 s", &upstreamFailure{status: 503, retryAfter: &ra}, contractModel, 61 * time.Second, "BC"},
		{"after a 503 with Retry-After 120 A is listed again at 121 s", &upstreamFailure{status: 503, retryAfter: &ra}, contractModel, 121 * time.Second, "ABC"},
		{"after a 401 A is left out for 30 minutes", status(401), contractModel, 29*time.Minute + 59*time.Second, "BC"},
		{"after a 401 A is listed again after 30 minutes", status(401), contractModel, 30*time.Minute + time.Second, "ABC"},
		{"after a dropped connection A is listed at once", errEOF, contractModel, 0, "ABC"},
		{"after a bare deadline A is listed at once", errDeadline, contractModel, 0, "ABC"},
		{"an account cooling for one model is listed for another", status(529), contractOtherModel, 0, "ABC"},
		{"after a credential-wide 429 A is left out for every model", &upstreamFailure{status: 429, scoped: true}, contractOtherModel, 0, "BC"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				p := newContractProxy(t, contractSetup{retry: 0, script: map[string][]attempt{"A": failing(c.fails)}})
				p.send(contractModel)
				time.Sleep(c.at)
				if got := p.nextOffer(c.model); got != c.offered {
					t.Fatalf("pick for %s offered %s, want %s", c.model, got, c.offered)
				}
			})
		})
	}
}

// Point 7: Intercept sees the model the pick names, and every usage record of the request carries
// the trace id Intercept saw.
func TestInterceptSeesTheModelThePickNames(t *testing.T) {
	t.Run("for a model alias", func(t *testing.T) {
		p := newContractProxy(t, contractSetup{retry: 3, records: true, answer: declineWithoutA,
			script:  map[string][]attempt{"A": failing(errEOF)},
			aliases: map[string][]sdkconfig.OAuthModelAlias{"claude": {{Name: contractModel, Alias: "team-opus"}}}})
		p.send("team-opus")
		seen, pick := p.hooks.requests()[0], p.scheduler.requests()[0]
		if seen.Model != "team-opus" || pick.Model != seen.Model {
			t.Errorf("Intercept saw %q, the pick names %q", seen.Model, pick.Model)
		}
		for _, r := range []cliusage.Record{p.record(t), p.record(t)} {
			if r.Model != contractModel || r.TraceID != seen.TraceID || r.TraceID == "" {
				t.Errorf("record %s %q with trace %q; Intercept's trace %q", r.AuthID, r.Model, r.TraceID, seen.TraceID)
			}
		}
	})
	t.Run("for a request routed to another provider", func(t *testing.T) {
		p := newContractProxy(t, contractSetup{retry: 3, records: true})
		p.hooks.route = &pluginapi.ModelRouteResponse{Handled: true, TargetKind: pluginapi.ModelRouteTargetProvider,
			Target: "codex", TargetModel: contractCodexModel}
		p.send(contractModel)
		seen, pick := p.hooks.requests()[0], p.scheduler.requests()[0]
		if seen.Model != contractCodexModel || pick.Model != seen.Model {
			t.Errorf("Intercept saw %q, the pick names %q", seen.Model, pick.Model)
		}
		if r := p.record(t); r.Provider != "codex" || r.Alias != contractModel || r.TraceID != seen.TraceID || r.TraceID == "" {
			t.Errorf("record %+v; Intercept's trace %q", r, seen.TraceID)
		}
	})
}

// Point 7: a compact request reaches Intercept with its path in the metadata.
func TestACompactRequestReachesInterceptWithItsPath(t *testing.T) {
	p := newContractProxy(t, contractSetup{retry: 3})
	if w := p.compact(); w.Code != http.StatusOK {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if got := p.hooks.requests()[0].Metadata[cliproxyexecutor.RequestPathMetadataKey]; got != "/v1/responses/compact" {
		t.Fatalf("Intercept saw path %v", got)
	}
}

// Point 7: the manager leaves the account alone after a compact request's generic 404 or 500, but
// not after its 401 or any 429.
func TestACompactFailureLeavesTheAccountAloneOnlyFor404And500(t *testing.T) {
	cases := []struct {
		name    string
		fails   error
		offered string
	}{
		{"a 404 leaves the account alone", status(404), "XY"},
		{"a 500 leaves the account alone", status(500), "XY"},
		{"a 401 cools the account", status(401), "Y"},
		{"a 429 cools the account", status(429), "Y"},
		{"a credential-wide 429 cools the account", &upstreamFailure{status: 429, scoped: true}, "Y"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := newContractProxy(t, contractSetup{retry: 0, script: map[string][]attempt{"X": failing(c.fails)}})
			p.compact()
			before := len(p.scheduler.requests())
			p.compact()
			if got := offeredIDs(p.scheduler.requests()[before]); got != c.offered {
				t.Fatalf("the next compact pick offered %s, want %s", got, c.offered)
			}
		})
	}
}

// Point 9: a hang's retry runs inside the same request: rounds have no elapsed-time cap, so after
// a connection lost 135 s into the attempt a declined pick still leads to a round that offers A.
func TestAHangsRetryRunsInsideTheSameRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		p := newContractProxy(t, contractSetup{retry: 3, answer: declineWithoutA,
			script: map[string][]attempt{"A": {{after: 135 * time.Second, err: errEOF}}}})
		start := time.Now()
		w := p.send(contractModel)
		if w.Code != http.StatusOK || !slices.Equal(p.scheduler.offers(), []string{"ABC", "BC", "ABC"}) {
			t.Fatalf("got %d %s, picks %v", w.Code, w.Body, p.scheduler.offers())
		}
		if elapsed := time.Since(start); elapsed != 135*time.Second {
			t.Fatalf("the retry came %v after the request, want 135s", elapsed)
		}
	})
}

// Point 9: the Claude handler writes no response headers before the first chunk, so the client
// sees a hang and its retry as one request.
func TestTheClaudeHandlerWritesNoHeadersBeforeTheFirstChunk(t *testing.T) {
	stream := func(p *contractProxy) (*http.Response, time.Duration) {
		t.Helper()
		gin.SetMode(gin.TestMode)
		engine := gin.New()
		engine.POST("/v1/messages", p.messages.ClaudeMessages)
		server := httptest.NewServer(engine)
		t.Cleanup(server.Close)
		body := fmt.Sprintf(`{"model":%q,"max_tokens":16,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, contractModel)
		start := time.Now()
		resp, err := http.Post(server.URL+"/v1/messages", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp, time.Since(start)
	}
	t.Run("the headers wait for the first chunk", func(t *testing.T) {
		p := newContractProxy(t, contractSetup{retry: 3, firstChunkAfter: 300 * time.Millisecond})
		resp, wait := stream(p)
		if resp.StatusCode != http.StatusOK || wait < 300*time.Millisecond {
			t.Fatalf("headers %d after %v, before the first chunk at 300ms", resp.StatusCode, wait)
		}
	})
	t.Run("a stream lost before its first chunk and retried on A is one response", func(t *testing.T) {
		p := newContractProxy(t, contractSetup{retry: 3, answer: declineWithoutA,
			script: map[string][]attempt{"A": {{after: 200 * time.Millisecond, err: errEOF}}}})
		resp, _ := stream(p)
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `"by":"A"`) || !slices.Equal(p.claude.accounts(), []string{"A", "A"}) {
			t.Fatalf("got %d %s, attempts %v", resp.StatusCode, body, p.claude.accounts())
		}
	})
}

// contractExecute runs a request of Claude Code session s1 through the manager alone.
func contractExecute(m *coreauth.Manager, model string) (cliproxyexecutor.Response, error) {
	opts := cliproxyexecutor.Options{Metadata: map[string]any{"canonical_session_id": "claude:s1"}}
	return m.Execute(context.Background(), []string{"claude"}, cliproxyexecutor.Request{Model: model, Payload: []byte(`{}`)}, opts)
}

// pilotScheduler is quota-pilot's own scheduler in the stub's place: each pick goes through the
// plugin's pick handler, as the host calls it.
type pilotScheduler struct{ stubScheduler }

func (s *pilotScheduler) PickAuth(ctx context.Context, req pluginapi.SchedulerPickRequest) (pluginapi.SchedulerPickResponse, bool, error) {
	s.mu.Lock()
	s.picks = append(s.picks, req)
	s.mu.Unlock()
	// As the host sends it: the metadata's plain values, not its callbacks.
	plain := req
	plain.Options.Metadata = map[string]any{}
	for k, v := range req.Options.Metadata {
		switch v.(type) {
		case string, bool, int, int64, float64:
			plain.Options.Metadata[k] = v
		}
	}
	raw, err := json.Marshal(plain)
	if err != nil {
		return pluginapi.SchedulerPickResponse{}, false, err
	}
	out, err := pick(raw)
	if err != nil {
		return pluginapi.SchedulerPickResponse{}, false, err
	}
	var env struct {
		Result pluginapi.SchedulerPickResponse
	}
	if err := json.Unmarshal(out, &env); err != nil {
		return pluginapi.SchedulerPickResponse{}, false, err
	}
	return env.Result, env.Result.Handled, nil
}

// With quota-pilot's scheduler in the proxy's manager, a dropped connection on the bound account
// is retried there inside the same request: the round's other pick is declined, and the next
// round answers the bound account. Each attempt's record reaches the plugin a moment after the
// attempt ends, as the proxy's usage queue delivers it.
func TestQuotaPilotRetriesADroppedConnectionOnItsAccount(t *testing.T) {
	saved := state
	state = core.New(newBootID(), nil)
	defer func() { state = saved }()
	state.UpdateInventory([]core.CredInfo{{ID: "A", Provider: "claude"}, {ID: "B", Provider: "claude"}, {ID: "C", Provider: "claude"}})
	p := newContractProxy(t, contractSetup{retry: 3, script: map[string][]attempt{"A": {{}, {err: errEOF}}}})
	pilot := &pilotScheduler{}
	p.manager.SetPluginScheduler(pilot)
	var records sync.WaitGroup
	p.claude.observed = func(auth string, failed bool) {
		records.Add(1)
		go func() {
			defer records.Done()
			time.Sleep(20 * time.Millisecond)
			u := core.Usage{Provider: "claude", Model: contractModel, SessionID: "claude:s1", AuthID: auth, RequestedAt: time.Now(), Output: 5}
			if failed {
				u = core.Usage{Provider: "claude", Model: contractModel, SessionID: "claude:s1", AuthID: auth, RequestedAt: time.Now(),
					Failed: true, ErrorText: errEOF.Error(), Latency: time.Millisecond}
			}
			state.Observe(u)
		}()
	}
	if _, err := contractExecute(p.manager, contractModel); err != nil {
		t.Fatal(err)
	}
	records.Wait()
	pilot.picks = nil
	resp, err := contractExecute(p.manager, contractModel)
	records.Wait()
	if err != nil || string(resp.Payload) != `{"ok":"A"}` {
		t.Fatalf("got %s, %v", resp.Payload, err)
	}
	if got := pilot.offers(); !slices.Equal(got, []string{"ABC", "BC", "ABC"}) {
		t.Fatalf("picks offered %v", got)
	}
	if attempts := p.claude.accounts(); !slices.Equal(attempts, []string{"A", "A", "A"}) {
		t.Fatalf("attempts %v", attempts)
	}
}
