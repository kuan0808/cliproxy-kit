// quota-pilot is a CLIProxyAPI plugin: it chooses the account for each Claude Code session by
// quota and reset time, keeps sessions on their account, optionally moves a session to another
// provider, and publishes its state for the Claude Code band and the management panel.
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

static const cliproxy_host_api* stored_host;

static void store_host_api(const cliproxy_host_api* host) {
	stored_host = host;
}

static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	if (stored_host == NULL || stored_host->call == NULL) {
		return 1;
	}
	return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}

static void free_host_buffer(void* ptr, size_t len) {
	if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) {
		stored_host->free_buffer(ptr, len);
	}
}
*/
import "C"

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/kuan0808/cliproxy-kit/plugin/core"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"github.com/tidwall/gjson"
	"gopkg.in/yaml.v3"
)

// version is set by release builds (-ldflags "-X main.version=1.2.3"); a source build says dev.
var version = "dev"

var (
	state      = core.New(newBootID(), nil)
	hostClosed atomic.Bool
	// lifeMu serializes starting and stopping the background loops, so a reconfigure that
	// arrives during a shutdown never starts loops the shutdown does not wait for.
	lifeMu sync.Mutex
	loops  *loopSet
	loaded sync.Once
)

type loopSet struct {
	cancel context.CancelFunc
	done   sync.WaitGroup
}

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	C.store_host_api(host)
	hostClosed.Store(false)
	plugin.abi_version = C.uint32_t(pluginabi.ABIVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}
	var requestBytes []byte
	if request != nil && requestLen > 0 {
		requestBytes = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	raw, errHandle := handleMethod(C.GoString(method), requestBytes)
	if errHandle != nil {
		state.NoteError(C.GoString(method) + ": " + errHandle.Error())
		writeResponse(response, errorEnvelope("plugin_error", errHandle.Error()))
		return 1
	}
	writeResponse(response, raw)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	stopLoops()
	hostClosed.Store(true)
}

func handleMethod(method string, request []byte) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		if errConfigure := configure(request); errConfigure != nil {
			return nil, errConfigure
		}
		startLoops()
		return okEnvelope(registration())
	case pluginabi.MethodPluginQuiesce, pluginabi.MethodPluginShutdown:
		stopLoops()
		return okEnvelope(map[string]any{})
	case pluginabi.MethodSchedulerPick:
		return pick(request)
	case pluginabi.MethodUsageHandle:
		return usage(request)
	case pluginabi.MethodModelRoute:
		return route(request)
	case pluginabi.MethodRequestInterceptBefore:
		return intercept(request)
	case pluginabi.MethodRequestInterceptAfter:
		return interceptAfter(request)
	case pluginabi.MethodManagementRegister:
		return okEnvelope(map[string]any{
			"routes": []map[string]string{
				{"Method": http.MethodGet, "Path": "/quota-pilot/snapshot"},
				{"Method": http.MethodGet, "Path": "/quota-pilot/usage"},
				{"Method": http.MethodGet, "Path": "/quota-pilot/usage/session"},
				{"Method": http.MethodPost, "Path": "/quota-pilot/refresh"},
			},
			"resources": []map[string]string{
				{"Path": "/band", "Description": "Snapshot for quota-band on another device; needs a band token"},
				pageResource,
			},
		})
	case pluginabi.MethodManagementHandle:
		return managementResponse(request)
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

type pluginConfig struct {
	CrossProvider          string            `yaml:"cross_provider"`
	FallbackMap            map[string]string `yaml:"fallback_map"`
	MinFiveHourLeftPercent float64           `yaml:"min_five_hour_left_percent"`
	IdlePollMinutes        int               `yaml:"idle_poll_minutes"`
	ContextLengths         map[string]int    `yaml:"context_lengths"`
	BandTokens             []string          `yaml:"band_tokens"`
}

func configure(raw []byte) error {
	var req struct {
		ConfigYAML []byte `json:"config_yaml"`
	}
	if len(raw) > 0 {
		if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
			return errUnmarshal
		}
	}
	var cfg pluginConfig
	if len(req.ConfigYAML) > 0 {
		if errDecode := yaml.Unmarshal(req.ConfigYAML, &cfg); errDecode != nil {
			return fmt.Errorf("decode config: %w", errDecode)
		}
	}
	state.SetConfig(core.Config{
		CrossProvider:          cfg.CrossProvider,
		FallbackMap:            cfg.FallbackMap,
		MinFiveHourLeftPercent: cfg.MinFiveHourLeftPercent,
		IdlePollMinutes:        cfg.IdlePollMinutes,
		ContextLengths:         cfg.ContextLengths,
		BandTokens:             cfg.BandTokens,
	})
	return nil
}

func registration() map[string]any {
	return map[string]any{
		"schema_version": pluginabi.SchemaVersion,
		"metadata": pluginapi.Metadata{
			Name:             "Quota Pilot",
			Version:          version,
			Author:           "kuan0808",
			GitHubRepository: "https://github.com/kuan0808/cliproxy-kit",
			Logo:             logo,
			// Descriptions are shown as written in the management panel, which has no translations
			// for plugin fields, so each is in English, then Chinese; no quotes, apostrophes,
			// ampersands or angle brackets, which the panel would show escaped.
			ConfigFields: []pluginapi.ConfigField{
				{Name: "cross_provider", Type: pluginapi.ConfigFieldTypeEnum, EnumValues: []string{"off", "auto"},
					Description: "Moving sessions to another provider. off: only by hand, with switch on the band. auto: when every account of a provider is used up, its Claude Code sessions go to the model fallback_map names. / 自動切換供應商。off：只在 band 上手動切換。auto：某個供應商的帳號全部用完時，自動把 Claude Code 的 session 改送到 fallback_map 指定的模型。"},
				{Name: "fallback_map", Type: pluginapi.ConfigFieldTypeObject,
					Description: "The model each provider moves to, as provider: provider:model, for example claude: codex:gpt-6.1-sol. Used by switch and by auto. / 各供應商改用的模型，寫成 供應商: 供應商:模型，例如 claude: codex:gpt-6.1-sol。手動和自動切換都用這個設定。"},
				{Name: "min_five_hour_left_percent", Type: pluginapi.ConfigFieldTypeNumber,
					Description: "A new session is not given an account with less than this percent of its 5-hour quota left, unless that window resets within 30 minutes. Default 25. / 新的 session 不會分到 5 小時額度剩不到這個百分比的帳號，除非它 30 分鐘內就重置。預設 25。"},
				{Name: "idle_poll_minutes", Type: pluginapi.ConfigFieldTypeInteger,
					Description: "How often the quota of every account is read, in minutes. Default 10. / 多久讀一次各帳號的額度，單位分鐘。預設 10。"},
				{Name: "context_lengths", Type: pluginapi.ConfigFieldTypeObject,
					Description: "Context window per model, to tell whether a conversation fits another model. Empty uses the built-in table. / 各模型的 context 大小，用來判斷對話能不能改送到另一個模型。不填就用內建表。"},
				{Name: "band_tokens", Type: pluginapi.ConfigFieldTypeArray,
					Description: "Client keys with which Claude Code on other devices may read the quota for its band. / 允許其他裝置上的 Claude Code 讀取額度資料的 client key 清單。"},
			},
		},
		"capabilities": map[string]any{
			"scheduler":                   true,
			"scheduler_across_priorities": true,
			"usage_plugin":                true,
			"model_router":                true,
			"request_interceptor":         true,
			"management_api":              true,
		},
	}
}

func pick(raw []byte) (out []byte, err error) {
	var req pluginapi.SchedulerPickRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	cands := make([]core.Candidate, 0, len(req.Candidates))
	for _, c := range req.Candidates {
		cands = append(cands, core.Candidate{ID: c.ID, Provider: c.Provider})
	}
	canonical, _ := req.Options.Metadata["canonical_session_id"].(string)
	parent, _ := req.Options.Metadata["parent_session_id"].(string)
	defer func() {
		// A failed decision still answers with a candidate, so the session is never handed
		// back to the native selector mid-way.
		if r := recover(); r != nil {
			state.NoteError(fmt.Sprintf("pick panic: %v", r))
			if id := core.FallbackPick(cands); id != "" && canonical != "" {
				out, err = okEnvelope(pluginapi.SchedulerPickResponse{AuthID: id, Handled: true})
				return
			}
			out, err = okEnvelope(pluginapi.SchedulerPickResponse{Handled: false})
		}
	}()
	result := state.Pick(core.PickInput{
		Provider: req.Provider, Providers: req.Providers, Model: req.Model,
		Canonical: canonical, Parent: parent, Candidates: cands,
	})
	if !result.Handled {
		return okEnvelope(pluginapi.SchedulerPickResponse{Handled: false})
	}
	return okEnvelope(pluginapi.SchedulerPickResponse{AuthID: result.AuthID, Handled: true})
}

func usage(raw []byte) ([]byte, error) {
	var r pluginapi.UsageRecord
	if errUnmarshal := json.Unmarshal(raw, &r); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	state.Observe(core.Usage{
		Provider: strings.ToLower(r.Provider), Model: r.Model, SessionID: r.SessionID, ParentID: r.ParentSessionID,
		TraceID: r.TraceID, AuthID: r.AuthID, AuthIndex: r.AuthIndex, Failed: r.Failed, StatusCode: r.Failure.StatusCode,
		RequestedAt: r.RequestedAt, Input: r.Detail.InputTokens, Output: r.Detail.OutputTokens,
		CacheRead: r.Detail.CacheReadTokens, CacheCreation: r.Detail.CacheCreationTokens,
		ResponseHeader: r.ResponseHeaders, TierAsked: tierOf(r.ServiceTier), TierServed: servedTier(r),
	})
	return okEnvelope(map[string]any{})
}

// tierOf is a service tier as the log keeps it.
func tierOf(tier string) string {
	return strings.ToLower(strings.TrimSpace(tier))
}

// servedTier is the tier the provider reported serving a request at, "" when it does not say. The
// ChatGPT backend that answers a Codex account signed in with ChatGPT, at its default address, names
// "default" whatever tier served it (Fast runs half again as fast and still reads "default"), so it
// says none.
func servedTier(r pluginapi.UsageRecord) string {
	chatgpt := r.BaseURL == "" || strings.Contains(r.BaseURL, "chatgpt.com")
	if strings.EqualFold(r.Provider, "codex") && r.AuthType == "oauth" && chatgpt {
		return ""
	}
	return tierOf(r.ResponseServiceTier)
}

// askedTier is the speed a request asks for: Claude's fast mode as "fast", else its service tier
// (Codex sends Fast as "priority"), "auto" when it names none, as the host does.
func askedTier(format string, body []byte) string {
	if format == "claude" && tierOf(gjson.GetBytes(body, "speed").String()) == "fast" {
		return "fast"
	}
	if tier := tierOf(gjson.GetBytes(body, "service_tier").String()); tier != "" {
		return tier
	}
	return "auto"
}

// fromAnotherDevice tells whether a request reached the proxy from another device. A reverse proxy
// in front of it (Tailscale Serve) appends the client's address to X-Forwarded-For, so the last
// entry is the one a client cannot forge; a client on this machine has one of its own addresses.
// A container on this machine reaching the port directly is not told apart.
func fromAnotherDevice(headers http.Header) bool {
	forwarded := headers.Values("X-Forwarded-For")
	if len(forwarded) == 0 {
		return false
	}
	list := strings.Split(forwarded[len(forwarded)-1], ",")
	ip := net.ParseIP(strings.TrimSpace(list[len(list)-1]))
	return ip != nil && !ip.IsLoopback() && !ownAddress(ip)
}

// ownAddresses are this machine's addresses, read again at most once a minute: a VPN can change
// them.
var ownAddresses struct {
	sync.Mutex
	at   time.Time
	list []net.IP
}

func ownAddress(ip net.IP) bool {
	ownAddresses.Lock()
	defer ownAddresses.Unlock()
	if time.Since(ownAddresses.at) > time.Minute {
		ownAddresses.at, ownAddresses.list = time.Now(), nil
		if addrs, err := net.InterfaceAddrs(); err == nil {
			for _, a := range addrs {
				if n, ok := a.(*net.IPNet); ok {
					ownAddresses.list = append(ownAddresses.list, n.IP)
				}
			}
		}
	}
	for _, own := range ownAddresses.list {
		if own.Equal(ip) {
			return true
		}
	}
	return false
}

func route(raw []byte) ([]byte, error) {
	var req pluginapi.ModelRouteRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	attachments, encoded := attachmentsOf(req.Body)
	in := core.RouteInput{
		Session:        strings.TrimSpace(req.Headers.Get("X-Claude-Code-Session-Id")),
		RequestedModel: req.RequestedModel,
		BodyBytes:      len(req.Body) - encoded,
		Attachments:    attachments,
		MaxOutput:      int(gjson.GetBytes(req.Body, "max_tokens").Int()),
		Available:      req.AvailableProviders,
		Turn:           conversationTurn(req.Body),
	}
	d := state.Route(in)
	if d.Recheck {
		// A takeover acts on every account being used up: on the host's list as it is now.
		if infos, ok := readInventory(); ok && len(infos) > 0 {
			state.UpdateInventory(infos)
			d = state.Route(in)
		}
	}
	if !d.Handled {
		return okEnvelope(pluginapi.ModelRouteResponse{Handled: false})
	}
	return okEnvelope(pluginapi.ModelRouteResponse{
		Handled: true, TargetKind: pluginapi.ModelRouteTargetProvider,
		Target: d.Provider, TargetModel: d.Model, Reason: d.Reason,
	})
}

// attachmentsOf counts the images and documents a Claude request carries, in its messages and in
// the tool results within them, and the bytes their encoded data takes, which is not text.
func attachmentsOf(body []byte) (count, encoded int) {
	var walk func(parts gjson.Result)
	walk = func(parts gjson.Result) {
		parts.ForEach(func(_, part gjson.Result) bool {
			if data := part.Get("source.data"); part.Get("source.type").String() == "base64" && data.Exists() {
				count++
				encoded += len(data.Raw)
			}
			if inner := part.Get("content"); inner.IsArray() {
				walk(inner)
			}
			return true
		})
	}
	gjson.GetBytes(body, "messages").ForEach(func(_, m gjson.Result) bool {
		walk(m.Get("content"))
		return true
	})
	return count, encoded
}

// conversationTurn reports whether a request is a turn of the main conversation: Claude Code
// offers tools on every turn, and a subagent names itself in the request's metadata.
func conversationTurn(body []byte) bool {
	if len(gjson.GetBytes(body, "tools").Array()) == 0 {
		return false
	}
	return !fromSubagent(body)
}

// fromSubagent reads the fields the proxy's session.ClaudeMetadataIdentities reads for a parent
// or an agent: in the JSON form of metadata.user_id, or beside the legacy form.
func fromSubagent(body []byte) bool {
	meta := gjson.GetBytes(body, "metadata")
	fields := []string{"agent_id", "subagent_id", "parent_session_id", "parent_agent_id", "parent_id"}
	if user := strings.TrimSpace(meta.Get("user_id").String()); strings.HasPrefix(user, "{") {
		meta = gjson.Parse(user)
	}
	for _, f := range fields {
		if v := strings.TrimSpace(meta.Get(f).String()); v != "" && v != "main" {
			return true
		}
	}
	return false
}

// intercept runs before credential selection: it stops what must not reach an upstream (a
// thread continuation on a session routed to another provider, a routed request that could not
// be sent there) and marks requests that carry a message thread for the usage record.
func intercept(raw []byte) ([]byte, error) {
	var req pluginapi.RequestInterceptRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	d := state.Intercept(core.InterceptInput{
		Session:        sessionOf(req.Headers, req.Metadata),
		TraceID:        req.TraceID,
		Format:         req.SourceFormat,
		Model:          req.Model,
		RequestedModel: req.RequestedModel,
		Thread:         gjson.GetBytes(req.Body, "thread.type").String(),
		Tools:          len(gjson.GetBytes(req.Body, "tools").Array()),
		Tier:           askedTier(req.SourceFormat, req.Body),
		Remote:         fromAnotherDevice(req.Headers),
	})
	if !d.Terminate {
		return okEnvelope(pluginapi.RequestInterceptResponse{})
	}
	detail := map[string]any{"type": "invalid_request_error", "message": d.Message}
	if d.ErrorCode != "" {
		detail["details"] = map[string]any{"error_code": d.ErrorCode}
	}
	body, errMarshal := json.Marshal(map[string]any{"type": "error", "error": detail})
	if errMarshal != nil {
		return nil, errMarshal
	}
	return okEnvelope(pluginapi.RequestInterceptResponse{
		Terminate:       true,
		StatusCode:      http.StatusBadRequest,
		ResponseHeaders: http.Header{"Content-Type": {"application/json"}},
		ResponseBody:    body,
	})
}

// sessionOf returns Claude Code's own session id: its header, else the host's canonical id.
// interceptAfter runs once the account is chosen, when the host has named the request's session:
// a session a client runs over the Responses API, as Codex does, is named by what it sends.
func interceptAfter(raw []byte) ([]byte, error) {
	var req pluginapi.RequestInterceptRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	if req.SourceFormat == "openai-response" {
		noteRequestSession(sessionOf(req.Headers, req.Metadata), req.Headers, req.Body, time.Now())
	}
	return okEnvelope(pluginapi.RequestInterceptResponse{})
}

func sessionOf(headers http.Header, metadata map[string]any) string {
	if id := strings.TrimSpace(headers.Get("X-Claude-Code-Session-Id")); id != "" {
		return id
	}
	canonical, _ := metadata["canonical_session_id"].(string)
	parent, _ := metadata["parent_session_id"].(string)
	if canonical == "" {
		return ""
	}
	return core.RawSession(core.RootSession(canonical, parent))
}

// managementResponse serves the full snapshot on the management route (management key checked
// by the host) and the email-free band snapshot on the resource route, which the host does not
// authenticate, so this handler checks a band token itself.
func managementResponse(raw []byte) ([]byte, error) {
	var req pluginapi.ManagementRequest
	if len(raw) > 0 {
		if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
			return nil, errUnmarshal
		}
	}
	if strings.HasSuffix(req.Path, "/refresh") && req.Method == http.MethodPost {
		return refreshResponse()
	}
	if strings.HasSuffix(req.Path, "/usage/session") {
		return usageSessionResponse(req.Query)
	}
	if strings.HasSuffix(req.Path, "/usage") {
		return usageResponse(req.Query)
	}
	if strings.HasSuffix(req.Path, pageResource["Path"]) {
		return pageResponse()
	}
	var doc any
	if strings.HasSuffix(req.Path, "/band") {
		token, _ := strings.CutPrefix(req.Headers.Get("Authorization"), "Bearer ")
		if !state.BandTokenAllowed(strings.TrimSpace(token)) {
			return httpResponse(http.StatusUnauthorized, []byte(`{"error":"band token required"}`))
		}
		// The band on another device says what its session is, which only that device knows.
		noteBandSession(req.Headers, time.Now())
		doc = state.BuildForBand(headerText(req.Headers, "X-Band-Session"))
	} else {
		doc = state.Build()
	}
	body, errMarshal := json.Marshal(doc)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return httpResponse(http.StatusOK, body)
}

func httpResponse(status int, body []byte) ([]byte, error) {
	return okEnvelope(map[string]any{
		"StatusCode": status,
		"Headers":    http.Header{"Content-Type": {"application/json"}, "Cache-Control": {"no-store"}},
		"Body":       body,
	})
}

// ---- background loops: quota polling, command intake, snapshot file ----

func startLoops() {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	if loops != nil {
		return
	}
	loaded.Do(loadState)
	ctx, cancel := context.WithCancel(context.Background())
	l := &loopSet{cancel: cancel}
	l.done.Add(3)
	go func() { defer l.done.Done(); pollLoop(ctx) }()
	go func() { defer l.done.Done(); fileLoop(ctx) }()
	go func() { defer l.done.Done(); warmReport(ctx) }()
	loops = l
}

// stopLoops cancels the loops and returns once they, and every host call they made, have ended.
func stopLoops() {
	lifeMu.Lock()
	defer lifeMu.Unlock()
	if loops == nil {
		return
	}
	loops.cancel()
	loops.done.Wait()
	loops = nil
	saveState()
	appendLog(state.TakeLog())
}

// pollLoop polls every account once at start, then every idle_poll_minutes while the proxy
// sees traffic. It pauses when idle because a disabled plugin is never told so.
func pollLoop(ctx context.Context) {
	var last time.Time
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	// The host loads credentials after plugins register; give it a moment.
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}
	for {
		interval := time.Duration(state.Config().IdlePollMinutes) * time.Minute
		if last.IsZero() || (!state.Idle() && time.Since(last) >= interval) {
			if complete, _ := pollOnce(ctx, 0, false); complete {
				last = time.Now()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// One poll at a time, the loop's or one asked for (a refresh waits for a running one only as long as
// its deadline lets it), when each account's quota and Claude plan were last read, and since when
// the host has listed no account.
var (
	pollTurn     = make(chan struct{}, 1)
	polledAt     = map[string]time.Time{}
	planReadAt   = map[string]time.Time{}
	emptiedSince time.Time
)

// pollWorkers is how many accounts are read at once: a refresh of many accounts fits its deadline,
// and no provider is asked for many at a time.
const pollWorkers = 4

// planTTL is how long a Claude plan read is trusted when nothing says it changed.
const planTTL = time.Hour

// planDue tells whether a Claude plan read at readAt is read again now: never read since the proxy
// started, read more than planTTL ago, asked for by a refresh, or a window started over since,
// which a plan change does.
func planDue(readAt, startedOver, now time.Time, asked bool) bool {
	return readAt.IsZero() || now.Sub(readAt) >= planTTL || asked || startedOver.After(readAt)
}

// minRepoll is how soon an account read already is read again when asked: a refresh clicked
// again and again does not press the provider's usage endpoint.
const minRepoll = time.Minute

// due tells whether an account last read at `at` is read again now, given how fresh is enough.
func due(at, now time.Time, fresh time.Duration) bool {
	return at.IsZero() || now.Sub(at) >= fresh
}

// pollOutcome is what reading an account's quota came to: Failure is "" when it was read, else
// "login" (its login could not be read), "refused" (401 or 403), "limited" (429), "http" (another
// status), "network", "unreadable" (an answer that was no usage reading), or "late" (not reached
// before the deadline).
type pollOutcome struct {
	ID      string `json:"account"`
	Label   string `json:"label,omitempty"`
	Failure string `json:"failure,omitempty"`
	Status  int    `json:"status,omitempty"`
}

// refreshResponse reads every account's quota now and writes what it read to the log before it
// answers, so the report asked for next has it. It says how many were read, and which could not be,
// and why.
func refreshResponse() ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	complete, outcomes := pollOnce(ctx, minRepoll, true)
	appendLog(state.TakeLog())
	read, failed := 0, []pollOutcome{}
	for _, o := range outcomes {
		if o.Failure == "" {
			read++
			continue
		}
		if info, ok := state.Account(o.ID); ok {
			o.Label = info.Label
		}
		failed = append(failed, o)
	}
	body, errMarshal := json.Marshal(map[string]any{"read": read, "failed": failed, "complete": complete})
	if errMarshal != nil {
		return nil, errMarshal
	}
	return httpResponse(http.StatusOK, body)
}

// readInventory reads the host's credential list; false when it could not, or listed one
// incompletely.
func readInventory() ([]core.CredInfo, bool) {
	raw, errList := callHost(pluginabi.MethodHostAuthList, map[string]any{})
	if errList != nil {
		state.NoteError("auth list: " + errList.Error())
		return nil, false
	}
	var list struct {
		Files []pluginapi.HostAuthFileEntry `json:"files"`
	}
	if errDecode := json.Unmarshal(raw, &list); errDecode != nil {
		state.NoteError("auth list decode: " + errDecode.Error())
		return nil, false
	}
	infos := make([]core.CredInfo, 0, len(list.Files))
	for _, f := range list.Files {
		provider := strings.ToLower(f.Provider)
		if provider == "" {
			provider = strings.ToLower(f.Type)
		}
		if f.ID == "" || f.AuthIndex == "" {
			return nil, false
		}
		email := f.Email
		if email == "" && strings.Contains(f.Label, "@") {
			email = f.Label
		}
		infos = append(infos, core.CredInfo{ID: f.ID, Index: f.AuthIndex, Provider: provider, Email: email,
			Disabled: f.Disabled, Unavailable: f.Unavailable, NextRetryAfter: f.NextRetryAfter})
	}
	return infos, true
}

// pollOnce reads each account's quota, skipping those read within `fresh`, and reports whether the
// inventory was complete (an incomplete one is retried soon) and what reading each account came to.
// A refresh asks for each Claude plan too, read within `fresh` of the last plan read only once.
func pollOnce(ctx context.Context, fresh time.Duration, asked bool) (complete bool, outcomes []pollOutcome) {
	select {
	case pollTurn <- struct{}{}:
		defer func() { <-pollTurn }()
	case <-ctx.Done():
		return false, nil
	}
	defer func() {
		if r := recover(); r != nil {
			state.NoteError(fmt.Sprintf("poll panic: %v", r))
			complete = false
		}
	}()
	now := time.Now()
	infos, ok := readInventory()
	if !ok {
		return false, nil
	}
	if len(infos) == 0 {
		// The host lists none before it has loaded its credentials. A list empty for a minute is
		// taken as it is, so accounts kept from before a restart that the proxy no longer holds go.
		if emptiedSince.IsZero() {
			emptiedSince = now
		} else if now.Sub(emptiedSince) >= time.Minute {
			state.UpdateInventory(nil)
		}
		return false, nil
	}
	emptiedSince = time.Time{}
	state.UpdateInventory(infos)
	// What was read of an account the host no longer holds goes with it: one added again under the
	// same id is read afresh.
	held := map[string]bool{}
	for _, info := range infos {
		held[info.ID] = true
	}
	for id := range polledAt {
		if !held[id] {
			delete(polledAt, id)
			delete(planReadAt, id)
		}
	}
	var jobs []pollJob
	for _, info := range infos {
		if info.Disabled || !core.Supported(info.Provider) {
			continue
		}
		j := pollJob{info: info, usage: due(polledAt[info.ID], now, fresh), planReadAt: planReadAt[info.ID],
			plan: asked && due(planReadAt[info.ID], now, fresh)}
		if j.usage || info.Provider != "codex" && planDue(j.planReadAt, state.StartedOver(info.ID), now, j.plan) {
			jobs = append(jobs, j)
		}
	}
	// The accounts are read a few at a time; the maps above are written once all are back.
	results := make(chan pollResult, len(jobs))
	turns := make(chan struct{}, pollWorkers)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case turns <- struct{}{}:
				defer func() { <-turns }()
			case <-ctx.Done():
				results <- pollResult{usage: j.usage, outcome: pollOutcome{ID: j.info.ID, Failure: "late"}}
				return
			}
			results <- pollCredential(ctx, j)
		}()
	}
	wg.Wait()
	close(results)
	for r := range results {
		if !r.planAt.IsZero() {
			planReadAt[r.outcome.ID] = r.planAt
		}
		if !r.usage {
			continue
		}
		// A failed read is tried again at the next poll, but a provider that asks to slow down is not.
		if f := r.outcome.Failure; f == "" || f == "limited" {
			polledAt[r.outcome.ID] = r.at
		}
		outcomes = append(outcomes, r.outcome)
	}
	return true, outcomes
}

// pollJob is one account to read: its quota when usage is set, its Claude plan when that is due or
// asked for (plan), given when it was last read.
type pollJob struct {
	info        core.CredInfo
	usage, plan bool
	planReadAt  time.Time
}

// pollResult is what reading one account came to: its quota's outcome when it was read (usage),
// when that was, and when its plan was read, zero when it was not.
type pollResult struct {
	outcome pollOutcome
	usage   bool
	at      time.Time
	planAt  time.Time
}

// accountOf is the provider account a credential logs in to, "" when its login does not say: the
// same account logged in again under a new credential is one account in the report. A Claude
// account's quota is its seat in an organization (a personal one, a Team), so the organization is
// part of it, as the host's own file names keep organizations apart; a Codex account_id is already
// one workspace's.
func accountOf(provider string, file map[string]any) string {
	text := func(key string) string { v, _ := file[key].(string); return strings.TrimSpace(v) }
	switch provider {
	case "claude":
		if account := text("account_uuid"); account != "" {
			return "claude:" + account + "/" + text("organization_uuid")
		}
	case "codex":
		if account := text("account_id"); account != "" {
			return "codex:" + account
		}
	}
	return ""
}

func pollCredential(ctx context.Context, j pollJob) (r pollResult) {
	info := j.info
	r.usage, r.outcome.ID = j.usage, info.ID
	defer func() {
		// A panic here would take the proxy down with it: it is this account's failure instead.
		if p := recover(); p != nil {
			state.NoteError(fmt.Sprintf("poll %s panic: %v", info.Index, p))
			r.outcome.Failure = "unreadable"
		}
	}()
	fail := func(failure string, status int, note string) {
		r.outcome.Failure, r.outcome.Status = failure, status
		state.NoteError(fmt.Sprintf("usage %s %s: %s", info.Provider, info.Index, note))
	}
	raw, errGet := callHost(pluginabi.MethodHostAuthGet, pluginapi.HostAuthGetRequest{AuthIndex: info.Index})
	if errGet != nil {
		fail("login", 0, "auth get: "+errGet.Error())
		return r
	}
	var got pluginapi.HostAuthGetResponse
	var file map[string]any
	if json.Unmarshal(raw, &got) != nil || json.Unmarshal(got.JSON, &file) != nil {
		fail("login", 0, "unreadable login")
		return r
	}
	state.SetIdentity(info.ID, accountOf(info.Provider, file))
	token, _ := file["access_token"].(string)
	if token == "" {
		fail("login", 0, "no access token")
		return r
	}
	headers := map[string][]string{"Authorization": {"Bearer " + token}}
	url := "https://api.anthropic.com/api/oauth/usage"
	if info.Provider == "codex" {
		url = "https://chatgpt.com/backend-api/wham/usage"
		if accountID, ok := file["account_id"].(string); ok && accountID != "" {
			headers["Chatgpt-Account-Id"] = []string{accountID}
		}
	} else {
		headers["anthropic-beta"] = []string{"oauth-2025-04-20"}
		headers["Content-Type"] = []string{"application/json"}
		headers["User-Agent"] = []string{"claude-cli/2.1.288 (external, cli)"}
	}
	if j.usage {
		body, status, errDo := httpGet(ctx, url, headers)
		r.at = time.Now()
		switch {
		case errDo != nil:
			fail("network", 0, errDo.Error())
		case status == http.StatusUnauthorized || status == http.StatusForbidden:
			fail("refused", status, fmt.Sprintf("HTTP %d", status))
		case status == http.StatusTooManyRequests:
			fail("limited", status, "HTTP 429")
		case status != http.StatusOK:
			fail("http", status, fmt.Sprintf("HTTP %d", status))
		default:
			if windows, full := core.WindowsFromUsageBody(info.Provider, body, r.at); full {
				state.MergePoll(info.ID, info.Provider, windows)
				if info.Provider == "codex" {
					state.SetPlan(info.ID, info.Provider, core.CodexPlan(body))
				}
			} else {
				fail("unreadable", 0, "unreadable answer")
			}
		}
	}
	// The Claude plan comes from the profile, read when planDue says, whether or not the usage read
	// worked; the plan kept from before a start shows until then.
	if now := time.Now(); info.Provider != "codex" && planDue(j.planReadAt, state.StartedOver(info.ID), now, j.plan) {
		profile, code, errProfile := httpGet(ctx, "https://api.anthropic.com/api/oauth/profile", headers)
		if errProfile == nil && code == http.StatusOK {
			state.SetPlan(info.ID, info.Provider, core.ClaudePlan(profile))
			r.planAt = now
		}
	}
	return r
}

// httpGet runs a host HTTP call that is cancelled after 20 seconds or when ctx ends.
func httpGet(ctx context.Context, url string, headers map[string][]string) ([]byte, int, error) {
	raw, errOpen := callHost(pluginabi.MethodHostHTTPOperationOpen, map[string]any{})
	if errOpen != nil {
		return nil, 0, errOpen
	}
	var opened struct {
		OperationID string `json:"operation_id"`
	}
	_ = json.Unmarshal(raw, &opened)
	callCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	done := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		select {
		case <-callCtx.Done():
			_, _ = callHost(pluginabi.MethodHostHTTPCancel, map[string]any{"operation_id": opened.OperationID})
		case <-done:
		}
	}()
	respRaw, errDo := callHost(pluginabi.MethodHostHTTPDo, map[string]any{
		"method": http.MethodGet, "url": url, "headers": headers, "operation_id": opened.OperationID,
	})
	close(done)
	<-watched // no host call outlives this function, so shutdown can wait for all of them
	if errDo != nil {
		return nil, 0, errDo
	}
	var resp pluginapi.HTTPResponse
	if errDecode := json.Unmarshal(respRaw, &resp); errDecode != nil {
		return nil, 0, errDecode
	}
	return resp.Body, resp.StatusCode, nil
}

// fileLoop applies band commands and writes the snapshot file.
func fileLoop(ctx context.Context) {
	dir := kitDir()
	commands := filepath.Join(dir, "commands")
	_ = os.MkdirAll(commands, 0o700)
	var lastWrite, lastPrune time.Time
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					state.NoteError(fmt.Sprintf("file loop panic: %v", r))
				}
			}()
			readCommands(commands)
			appendLog(state.TakeLog())
			if time.Since(lastPrune) >= 24*time.Hour {
				pruneLog(time.Now())
				lastPrune = time.Now()
			}
			state.Sweep()
			// The snapshot goes out on a change, at most once a second, and at least every 30 s
			// with traffic or every minute without, so a reader can tell a quiet proxy from a
			// stopped one and sees windows whose reset has passed. Only a write takes the change
			// flag, so a change made right after a write goes out with the next one.
			every := 30 * time.Second
			if state.Idle() {
				every = time.Minute
			}
			since := time.Since(lastWrite)
			due := lastWrite.IsZero() || since >= every
			if since >= time.Second {
				due = state.TakeDirty() || due
			}
			if due {
				if errWrite := writeSnapshot(filepath.Join(dir, "snapshot.json")); errWrite == nil {
					lastWrite = time.Now()
				}
				saveState()
			}
		}()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// readCommands applies the band's commands in the order they were written.
func readCommands(dir string) {
	entries, errRead := os.ReadDir(dir)
	if errRead != nil {
		return
	}
	type pending struct {
		path string
		cmd  core.Command
	}
	var cmds []pending
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, errFile := os.ReadFile(path)
		if errFile != nil {
			continue
		}
		var cmd core.Command
		if json.Unmarshal(raw, &cmd) != nil {
			// The band may still be writing it; give it two seconds before rejecting.
			if info, errStat := e.Info(); errStat == nil && time.Since(info.ModTime()) > 2*time.Second {
				state.RejectUnreadable(e.Name())
				_ = os.Remove(path)
			}
			continue
		}
		cmds = append(cmds, pending{path: path, cmd: cmd})
	}
	sort.SliceStable(cmds, func(i, j int) bool { return cmds[i].cmd.CreatedAt.Before(cmds[j].cmd.CreatedAt) })
	for _, p := range cmds {
		state.Apply(p.cmd)
		_ = os.Remove(p.path)
	}
}

func writeSnapshot(path string) error {
	body, errMarshal := json.MarshalIndent(state.Build(), "", " ")
	if errMarshal != nil {
		return errMarshal
	}
	return writeAtomic(path, body)
}

func writeAtomic(path string, body []byte) error {
	tmp := path + ".tmp"
	if errWrite := os.WriteFile(tmp, body, 0o600); errWrite != nil {
		return errWrite
	}
	return os.Rename(tmp, path)
}

// Bindings and routes are kept across restarts: a restart must not move a session's thread.
func statePath() string { return filepath.Join(kitDir(), "state.json") }

func loadState() {
	raw, errRead := os.ReadFile(statePath())
	if errRead != nil {
		return
	}
	var p core.Persisted
	if errDecode := json.Unmarshal(raw, &p); errDecode != nil {
		state.NoteError("state file unreadable: " + errDecode.Error())
		return
	}
	state.Import(p)
}

func saveState() {
	body, errMarshal := json.Marshal(state.Export())
	if errMarshal != nil {
		return
	}
	if errWrite := writeAtomic(statePath(), body); errWrite != nil {
		state.NoteError("state file: " + errWrite.Error())
	}
}

func kitDir() string {
	home, errHome := os.UserHomeDir()
	if errHome != nil {
		home = os.TempDir()
	}
	dir := filepath.Join(home, ".cache", "cliproxy-kit")
	_ = os.MkdirAll(dir, 0o700)
	return dir
}

func newBootID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- host calls and envelopes ----

func callHost(method string, payload any) (json.RawMessage, error) {
	if hostClosed.Load() {
		return nil, fmt.Errorf("host closed")
	}
	rawPayload, errMarshal := json.Marshal(payload)
	if errMarshal != nil {
		return nil, fmt.Errorf("marshal %s: %w", method, errMarshal)
	}
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var response C.cliproxy_buffer
	var requestPtr *C.uint8_t
	if len(rawPayload) > 0 {
		cPayload := C.CBytes(rawPayload)
		defer C.free(cPayload)
		requestPtr = (*C.uint8_t)(cPayload)
	}
	callCode := C.call_host_api(cMethod, requestPtr, C.size_t(len(rawPayload)), &response)
	var rawResponse []byte
	if response.ptr != nil && response.len > 0 {
		rawResponse = C.GoBytes(response.ptr, C.int(response.len))
	}
	if response.ptr != nil {
		C.free_host_buffer(response.ptr, response.len)
	}
	if len(rawResponse) == 0 {
		return nil, fmt.Errorf("%s returned no response, code=%d", method, int(callCode))
	}
	var env envelope
	if errUnmarshal := json.Unmarshal(rawResponse, &env); errUnmarshal != nil {
		return nil, fmt.Errorf("decode %s envelope: %w", method, errUnmarshal)
	}
	if !env.OK {
		if env.Error != nil {
			return nil, fmt.Errorf("%s: %s", env.Error.Code, env.Error.Message)
		}
		return nil, fmt.Errorf("%s failed", method)
	}
	return env.Result, nil
}

func okEnvelope(v any) ([]byte, error) {
	raw, errMarshal := json.Marshal(v)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}
