package core

import (
	"fmt"
	"strings"
	"time"
)

// defaultContextLengths come from the server's model catalog (internal/registry/models).
var defaultContextLengths = map[string]int{
	"claude-opus-5-5":           1000000,
	"claude-sonnet-5-5":         1000000,
	"claude-haiku-4-5-20251001": 200000,
	"gpt-6-sol":                 272000,
	"gpt-6-luna":                272000,
	"gpt-6-astra":               272000,
	"gpt-6.1-sol":               272000,
	"gpt-5.5":                   272000,
}

// outputReserveTokens keeps room for the answer when checking whether a request fits.
const outputReserveTokens = 32000

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
	BodyBytes      int
	Available      []string
	// Turn marks a turn of the main conversation: it offers tools and comes from no subagent.
	// Only a turn says what the conversation asks for and whether it still fits a route.
	Turn bool
}

// RouteDecision sends a request to another provider when Handled.
type RouteDecision struct {
	Handled  bool
	Provider string
	Model    string
	Reason   string
}

// Route decides cross-provider routing: a band override first, then the opt-in automatic
// takeover. Automatic takeover needs fresh data showing every credential of the requested
// provider unable to serve, and a request that fits the target model.
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

	// An established route that cannot run is not handled here: the router cannot fail a
	// request, so Intercept stops it instead of letting it fall back to the original provider.
	if r, ok := s.routes[root]; ok {
		r.At = now
		s.routes[root] = r
		if r.Provider == from && strings.EqualFold(r.Model, in.RequestedModel) {
			return RouteDecision{}
		}
		note := ""
		if !available[r.Provider] {
			note = r.Provider + " has no account on the proxy"
		} else {
			note = s.fitsLocked(r.Model, in.BodyBytes)
		}
		if in.Turn {
			s.noteLocked(sess, note)
		}
		if note != "" {
			return RouteDecision{}
		}
		return RouteDecision{Handled: true, Provider: r.Provider, Model: r.Model, Reason: "session routed to " + r.Provider}
	}

	// Without a route, the note says why the automatic takeover could not run; each turn of the
	// conversation decides it afresh, so it clears once the reason is gone.
	if s.cfg.CrossProvider != "auto" || s.healthLocked(from, in.RequestedModel, now) != "exhausted" {
		if in.Turn {
			s.noteLocked(sess, "")
		}
		return RouteDecision{}
	}
	provider, model, ok := strings.Cut(s.cfg.FallbackMap[from], ":")
	provider = strings.ToLower(strings.TrimSpace(provider))
	note := ""
	switch {
	case !ok || model == "" || provider == from:
		note = from + " is used up and no fallback is configured"
	case !available[provider]:
		note = from + " is used up and its fallback " + provider + " has no account on the proxy"
	case s.healthLocked(provider, model, now) == "exhausted":
		note = from + " and " + provider + " are both used up"
	default:
		note = s.fitsLocked(model, in.BodyBytes)
	}
	if note != "" || !in.Turn {
		if in.Turn {
			s.noteLocked(sess, note)
		}
		return RouteDecision{}
	}
	s.routes[root] = Route{Provider: provider, Model: model, At: now, Auto: true}
	s.noteLocked(sess, "")
	s.dirty = true
	return RouteDecision{Handled: true, Provider: provider, Model: model, Reason: from + " used up; automatic takeover"}
}

func (s *State) noteLocked(sess *session, note string) {
	if sess.RouteNote != note {
		sess.RouteNote = note
		s.dirty = true
	}
}

// fitsLocked returns "" when a request of bodyBytes fits the model, otherwise the reason.
// Bytes divided by three over-estimates tokens for English and code, which is the safe side.
func (s *State) fitsLocked(model string, bodyBytes int) string {
	limit := s.contextLengthLocked(model)
	if limit == 0 {
		return "context size of " + model + " unknown; hand off first"
	}
	if bodyBytes/3+outputReserveTokens > limit {
		return "conversation too long for " + model + "; compact or hand off first"
	}
	return ""
}

func (s *State) contextLengthLocked(model string) int {
	if n := s.cfg.ContextLengths[model]; n > 0 {
		return n
	}
	return defaultContextLengths[model]
}

// InterceptInput is the part of a request about to run upstream that the core needs.
type InterceptInput struct {
	Session        string // Claude Code's own session id
	TraceID        string // id of the inbound HTTP request, shared with its usage records
	Model          string // the model about to run, after any route
	RequestedModel string // the model the client asked for
	Thread         string // the request's message-thread type, "" when it carries none
	Tools          int    // tools the request offers the model
}

// trace is what Intercept saw of an inbound request.
type trace struct {
	At     time.Time
	Thread bool // carried a message thread
	// Side marks a request without tools: a permission check, a title or a summary sent beside
	// the conversation, often on a smaller model. Conversation turns always offer tools.
	Side bool
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

// Intercept runs after the route decision and before credential selection. A session routed to
// another provider must send its whole history, because that provider cannot continue an
// Anthropic message thread; and a routed request that could not be sent there is stopped
// rather than quietly served by the original provider.
func (s *State) Intercept(in InterceptInput) InterceptDecision {
	s.mu.Lock()
	defer s.mu.Unlock()
	if in.Session == "" {
		return InterceptDecision{}
	}
	now := s.now()
	root := rootFromRaw(in.Session)
	from := ProviderOfModel(in.RequestedModel)
	if r, ok := s.routes[root]; ok && from != "" && !(r.Provider == from && strings.EqualFold(r.Model, in.RequestedModel)) {
		if in.Thread != "" && r.Provider != from {
			return InterceptDecision{Terminate: true, ErrorCode: threadUnsupported,
				Message: "message threads are off while this session runs on " + r.Provider}
		}
		// The router did not send it there (the conversation does not fit, or the provider has no
		// account): stopped, rather than served by the original model unasked.
		sent := ProviderOfModel(in.Model) == r.Provider && (r.Provider != from || strings.EqualFold(in.Model, r.Model))
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
	if in.TraceID != "" {
		s.traces[in.TraceID] = trace{At: now, Thread: in.Thread != "", Side: in.Tools == 0}
	}
	return InterceptDecision{}
}
