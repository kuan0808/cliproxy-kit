package core

import (
	"fmt"
	"strings"
	"time"
)

// contextFamilies are the context windows of the model families the proxy serves, from its catalogs
// (internal/registry/models: models.json for Claude, codex_client_models.json for Codex): a family's
// later versions and effort variants keep its size.
var contextFamilies = []struct {
	prefix string
	tokens int
}{
	{"claude-opus-5", 1000000},
	{"claude-sonnet-5", 1000000},
	{"claude-fable-5", 1000000},
	{"claude-haiku-4-5", 200000},
	{"gpt-", 272000},
}

// outputReserveTokens keeps room for the answer when a request does not say how long it may be.
const outputReserveTokens = 32000

// attachmentTokens is what an image or a document counts for: its encoded bytes are not text.
const attachmentTokens = 1600

// ProviderOfModel guesses the provider that serves a model id.
func ProviderOfModel(model string) string {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "claude"):
		return "claude"
	case strings.HasPrefix(m, "gpt-") || strings.Contains(m, "codex"):
		return "codex"
	}
	return ""
}

// RouteInput is the part of a model-route request the core needs.
type RouteInput struct {
	Session        string // Claude Code's own session id
	RequestedModel string
	BodyBytes      int // the request's size, its attachments' encoded data left out
	Attachments    int // images and documents it carries
	MaxOutput      int // the answer it allows (max_tokens); 0 when it does not say
	Available      []string
	InventoryRead  string
	QuotaRead      string
	// Turn marks a turn of the main conversation: it offers tools or continues a thread, and comes from no subagent.
	// Only a turn says what the conversation asks for and whether it still fits a route.
	Turn bool
}

// RouteDecision sends a request to another model when Handled. Recheck asks for a fresh host
// account list before establishing, ending or replacing an automatic route. Refresh asks for
// quota to be read before deciding whether an idle automatic route can end.
type RouteDecision struct {
	Handled  bool
	Provider string
	Model    string
	Reason   string
	Recheck  bool
	Refresh  bool
}

// inventoryFresh is how old the host's account list may be when a takeover acts on it: an account
// added or enabled since is not in it.
const inventoryFresh = 30 * time.Second

// Route decides whether a request runs another model than the one it asks for: a route the band
// set first, then the fallback map, by itself, when the model asked for is used up on every
// account. That needs fresh data showing every account of its provider unable to serve it, and a
// request that fits the model it goes to.
func (s *State) Route(in RouteInput) RouteDecision {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.lastActivity = now
	from := ProviderOfModel(in.RequestedModel)
	if in.Session == "" || from == "" {
		return RouteDecision{}
	}
	root := rootFromRaw(in.Session)
	sess := s.sessionLocked(root, now)
	if in.Turn && sess.RequestedModel != in.RequestedModel {
		sess.RequestedModel = in.RequestedModel
		s.dirty = true
	}
	available := map[string]bool{}
	for _, p := range in.Available {
		available[strings.ToLower(p)] = true
	}

	r, routed := s.routes[root]
	// A model's route stands in for that model alone: the session's other requests run as asked.
	if routed && r.From != "" && r.From != modelKey(in.RequestedModel) {
		routed = false
	}
	// An automatic route is decided again when going back costs nothing (what it stood in for can
	// serve, and the session has rested past its cache), or when its own target has run out.
	if routed && r.Auto && in.Turn && in.InventoryRead != "failed" && in.QuotaRead != "failed" {
		rested := now.Sub(r.At) >= cacheGone
		health := s.healthLocked(from, in.RequestedModel, now)
		free := rested && health == "healthy"
		if free || s.healthLocked(r.Provider, r.Model, now) == "exhausted" {
			if now.Sub(s.inventoryAt) > inventoryFresh {
				if in.InventoryRead == "" {
					return RouteDecision{Recheck: true}
				}
			} else {
				delete(s.routes, root)
				s.dirty = true
				routed = false
			}
		} else if rested && health == "unknown" && in.QuotaRead == "" {
			return RouteDecision{Refresh: true}
		}
	}
	// An established route that cannot run is not handled here: the router cannot fail a
	// request, so Intercept stops it instead of letting it fall back to the original model.
	if routed {
		r.At = now
		s.routes[root] = r
		s.dirty = true
		if r.Provider == from && strings.EqualFold(r.Model, in.RequestedModel) {
			return RouteDecision{}
		}
		note := ""
		if !available[r.Provider] {
			note = r.Provider + " has no account on the proxy"
		} else {
			note = s.fitsLocked(r.Model, needOf(sess, in))
		}
		if in.Turn {
			s.noteLocked(sess, note)
		}
		if note != "" {
			return RouteDecision{}
		}
		return RouteDecision{Handled: true, Provider: r.Provider, Model: r.Model, Reason: "session routed to " + r.Model}
	}

	// Without a route, the note says why the fallback could not run; each turn of the conversation
	// decides it afresh, so it clears once the reason is gone.
	to, note := Route{}, ""
	if s.healthLocked(from, in.RequestedModel, now) == "exhausted" {
		to, note = s.fallbackLocked(from, in.RequestedModel, available, now, true)
		if to.Model != "" {
			if note = s.fitsLocked(to.Model, needOf(sess, in)); note != "" {
				to = Route{}
			}
		}
	}
	if to.Model == "" || !in.Turn {
		if in.Turn {
			s.noteLocked(sess, note)
		}
		return RouteDecision{}
	}
	if now.Sub(s.inventoryAt) > inventoryFresh {
		return RouteDecision{Recheck: in.InventoryRead == ""}
	}
	to.At, to.Auto = now, true
	s.routes[root] = to
	s.noteLocked(sess, "")
	s.dirty = true
	return RouteDecision{Handled: true, Provider: to.Provider, Model: to.Model, Reason: modelKey(in.RequestedModel) + " used up; automatic fallback"}
}

// fallbackOf is what the fallback map names for a model: the entry of the longest key its id
// starts with, else its provider's. A value is a model, or provider:model.
func (s *State) fallbackOf(source, model string) (provider, target string) {
	id, key := modelKey(model), source
	for k := range s.cfg.FallbackMap {
		if k != "" && strings.HasPrefix(id, k) && (len(k) > len(key) || !strings.HasPrefix(id, key)) {
			key = k
		}
	}
	return fallbackTarget(s.cfg.FallbackMap[key])
}

// fallbackTarget reads a fallback map value: "provider:model", or a model of the provider its id
// names.
func fallbackTarget(value string) (provider, model string) {
	if p, m, ok := strings.Cut(value, ":"); ok {
		return strings.ToLower(strings.TrimSpace(p)), strings.TrimSpace(m)
	}
	return ProviderOfModel(value), strings.TrimSpace(value)
}

// fallbackLocked follows the fallback map from a model that is used up on every account to the
// first model that can serve: what the map names for it, and for that in turn when it is used up
// too. It gives the route to take, or why there is none; neither when an automatic step would cross
// to another provider without cross_provider auto.
func (s *State) fallbackLocked(from, requested string, available map[string]bool, now time.Time, automatic bool) (Route, string) {
	seen := map[string]bool{from + ":" + modelKey(requested): true}
	for source, model := from, requested; ; {
		provider, target := s.fallbackOf(source, model)
		crossing := provider != from
		switch {
		case automatic && crossing && s.cfg.CrossProvider != "auto":
			return Route{}, ""
		case target == "" || provider == "" || seen[provider+":"+modelKey(target)]:
			if model == requested {
				return Route{}, from + " is used up and no fallback is configured"
			}
			return Route{}, from + " is used up, and so is what it falls back to"
		case !available[provider]:
			return Route{}, from + " is used up and its fallback " + provider + " has no account on the proxy"
		}
		seen[provider+":"+modelKey(target)] = true
		if s.healthLocked(provider, target, now) == "exhausted" {
			source, model = provider, target
			continue
		}
		to := Route{Provider: provider, Model: target}
		if !crossing {
			to.From = modelKey(requested) // it stands in for the model asked alone
		}
		return to, ""
	}
}

func (s *State) noteLocked(sess *session, note string) {
	if sess.RouteNote != note {
		sess.RouteNote = note
		s.dirty = true
	}
}

// needOf estimates the tokens a turn needs on another model: the conversation as its last turn read
// it, or the request when that is larger (a turn that continues a thread carries only what is new;
// bytes over three over-estimate text, the safe side), and room for the answer.
func needOf(sess *session, in RouteInput) int {
	last := sess.Last
	need := max(int(last.Input+last.CacheRead+last.CacheCreation+last.Output), in.BodyBytes/3+in.Attachments*attachmentTokens)
	if in.MaxOutput > 0 {
		return need + in.MaxOutput
	}
	return need + outputReserveTokens
}

// fitsLocked returns "" when a turn needing need tokens fits the model, otherwise the reason.
func (s *State) fitsLocked(model string, need int) string {
	limit := s.contextLengthLocked(model)
	if limit == 0 {
		return "context size of " + model + " unknown; hand off first"
	}
	if need > limit {
		return "conversation too long for " + model + "; compact or hand off first"
	}
	return ""
}

// contextLengthLocked is a model's context window: as configured, else its family's. A context or
// thinking suffix ("[1m]", "(high)") names the same model.
func (s *State) contextLengthLocked(model string) int {
	if n := s.cfg.ContextLengths[model]; n > 0 {
		return n
	}
	key := modelKey(model)
	if n := s.cfg.ContextLengths[key]; n > 0 {
		return n
	}
	for _, f := range contextFamilies {
		if strings.HasPrefix(key, f.prefix) {
			return f.tokens
		}
	}
	return 0
}

// InterceptInput is the part of a request about to run upstream that the core needs.
type InterceptInput struct {
	Session        string // Claude Code's own session id
	Canonical      string // the proxy's id of the request's thread of the session, "" when not known
	TraceID        string // id of the inbound HTTP request, shared with its usage records
	Format         string // the client's protocol: "claude" for Claude Code, "openai-response" for Codex
	Model          string // the model about to run, after any route
	RequestedModel string // the model the client asked for
	Thread         string // the request's message-thread type, "" when it carries none
	Tools          int    // tools the request offers the model
	Tier           string // the speed the request asked for: a service tier, "fast" for Claude's fast mode, "auto" for none
	Remote         bool   // it reached the proxy from another device
	Path           string // the request's path, as the proxy names it in the request's metadata
}

// trace is what Intercept saw of an inbound request, kept for its usage records.
type trace struct {
	// At is when the request reached the proxy, from which the client's wait is measured.
	At time.Time
	// Model is the model it runs, after routing: the one its picks name, by which every per-model
	// state is kept, where its usage records name the model the executor ran.
	Model string
	// Compact marks a Codex compact request, after whose failure the proxy leaves the account alone.
	Compact bool
	// Thread marks a request whose conversation lives on the account that answers: an Anthropic
	// message thread, and every Codex request, which continues its conversation where it ran.
	Thread bool
	// Side marks a Claude Code request without tools beside the conversation: a permission check,
	// a title or a summary, often on a smaller model. Its turns offer tools, except a thread
	// continuation, which inherits them.
	Side   bool
	Tier   string
	Remote bool
}

// InterceptDecision stops a request with an Anthropic-style 400 when Terminate is set.
type InterceptDecision struct {
	Terminate bool
	ErrorCode string // error.details.error_code, read by Claude Code
	Message   string
}

// threadUnsupported is the error code that makes Claude Code resend the turn without a message
// thread and keep the session stateless on that model.
const threadUnsupported = "thread_unsupported_request"

// Intercept runs after the route decision and before credential selection. A request routed to
// another model must send its whole history, because a message thread keeps the model and the
// provider it began on; and a routed request that could not be sent there is stopped rather than
// quietly served by the original model.
func (s *State) Intercept(in InterceptInput) InterceptDecision {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if in.TraceID != "" {
		claude := in.Format == "claude"
		s.traces[in.TraceID] = trace{At: now, Model: in.Model, Compact: strings.HasSuffix(in.Path, "/responses/compact"),
			Thread: in.Thread != "" || !claude, Side: claude && in.Tools == 0 && in.Thread == "", Tier: in.Tier, Remote: in.Remote}
	}
	if in.Session == "" {
		return InterceptDecision{}
	}
	root := rootFromRaw(in.Session)
	from := ProviderOfModel(in.RequestedModel)
	applies := func(r Route) bool { return r.From == "" || r.From == modelKey(in.RequestedModel) }
	if r, ok := s.routes[root]; ok && from != "" && applies(r) && !(r.Provider == from && strings.EqualFold(r.Model, in.RequestedModel)) {
		// A thread keeps one model, on one provider: its continuation cannot run on another.
		if in.Thread != "" {
			return InterceptDecision{Terminate: true, ErrorCode: threadUnsupported,
				Message: "message threads are off while this session runs on " + r.Model}
		}
		// The router did not send it there (the conversation does not fit, or the provider has no
		// account): stopped, rather than served by the original model unasked.
		sent := strings.EqualFold(in.Model, r.Model)
		if !sent {
			note := "the request could not be sent there"
			if sess := s.sessions[root]; sess != nil && sess.RouteNote != "" {
				note = sess.RouteNote
			}
			return InterceptDecision{Terminate: true, Message: fmt.Sprintf(
				"quota-pilot: this session is routed to %s (%s), but %s. Use back to %s in the band to leave the route.",
				r.Provider, r.Model, note, from)}
		}
	}
	// A thread continuation the proxy would hold on the thread's account, where the session should
	// no longer run: Claude Code sends it again without the thread, and the pick decides.
	if in.Format == "claude" && in.Thread == "continue" {
		canonical := in.Canonical
		if canonical == "" {
			canonical = root
		}
		if !s.threadStaysLocked(canonical, root, in.Model, now) {
			return InterceptDecision{Terminate: true, ErrorCode: threadUnsupported,
				Message: "quota-pilot: this session runs on another account now; its message thread stays on the one it left"}
		}
	}
	return InterceptDecision{}
}
