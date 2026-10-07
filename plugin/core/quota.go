package core

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Window kinds shared by every provider. Model-scoped weekly buckets use "7d_<family>".
const (
	KindFiveHour = "5h"
	KindWeekly   = "7d"
)

// Window is one quota window of one credential.
type Window struct {
	Kind       string    `json:"kind"`
	Remaining  float64   `json:"remaining"` // 0..1
	ResetAt    time.Time `json:"reset_at"`
	ObservedAt time.Time `json:"observed_at"`
	Source     string    `json:"source"` // "header" or "poll"
}

// windowLabel is the human label shown by the band and the panel.
func windowLabel(kind string) string {
	switch kind {
	case KindFiveHour:
		return "5-hour"
	case KindWeekly:
		return "Weekly"
	}
	if family, ok := strings.CutPrefix(kind, "7d_"); ok {
		return "Weekly " + titleCase(family)
	}
	return kind
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// ModelBucket maps a Claude model id to its model-scoped weekly bucket, or "" when none applies.
func ModelBucket(model string) string {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return "7d_opus"
	case strings.Contains(m, "sonnet"):
		return "7d_sonnet"
	case strings.Contains(m, "fable"):
		return "7d_fable"
	}
	return ""
}

// claudeHeaderKind maps the window token in anthropic-ratelimit-unified-<token>-* headers.
func claudeHeaderKind(token string) string {
	switch token {
	case "5h":
		return KindFiveHour
	case "7d":
		return KindWeekly
	case "7d_opus", "7d_sonnet", "7d_fable":
		return token
	}
	return ""
}

// claudePollKind maps the keys of the Claude OAuth usage endpoint body.
// claudePollKinds are the window kinds a Claude usage reading can name.
var claudePollKinds = []string{KindFiveHour, KindWeekly, "7d_opus", "7d_sonnet", "7d_fable"}

func claudePollKind(key string) string {
	switch key {
	case "five_hour":
		return KindFiveHour
	case "seven_day":
		return KindWeekly
	case "seven_day_opus":
		return "7d_opus"
	case "seven_day_sonnet":
		return "7d_sonnet"
	case "iguana_necktie":
		return "7d_fable"
	}
	return ""
}

// Supported reports whether quota-pilot reads a provider's quota, and so chooses its accounts.
// Other providers' requests are left to CLIProxyAPI's own routing and logged with their tokens.
func Supported(provider string) bool {
	return provider == "claude" || provider == "codex"
}

// WindowsFromHeaders reads quota windows from upstream response headers.
func WindowsFromHeaders(provider string, headers http.Header, now time.Time) []Window {
	switch provider {
	case "claude":
		return claudeHeaderWindows(headers, now)
	case "codex":
		return codexHeaderWindows(headers, now)
	}
	return nil
}

func claudeHeaderWindows(headers http.Header, now time.Time) []Window {
	type partial struct {
		util, reset float64
		hasUtil     bool
		hasReset    bool
		rejected    bool
	}
	parts := map[string]*partial{}
	for name, values := range headers {
		if len(values) == 0 {
			continue
		}
		rest, ok := strings.CutPrefix(strings.ToLower(name), "anthropic-ratelimit-unified-")
		if !ok {
			continue
		}
		value := strings.TrimSpace(values[len(values)-1])
		for _, suffix := range []string{"-utilization", "-reset", "-status"} {
			token, okSuffix := strings.CutSuffix(rest, suffix)
			if !okSuffix {
				continue
			}
			kind := claudeHeaderKind(token)
			if kind == "" {
				continue
			}
			p := parts[kind]
			if p == nil {
				p = &partial{}
				parts[kind] = p
			}
			switch suffix {
			case "-utilization":
				if f, err := strconv.ParseFloat(value, 64); err == nil {
					p.util, p.hasUtil = f, true
				}
			case "-reset":
				if f, err := strconv.ParseFloat(value, 64); err == nil {
					p.reset, p.hasReset = f, true
				}
			case "-status":
				p.rejected = value == "rejected"
			}
		}
	}
	var out []Window
	for kind, p := range parts {
		if !p.hasUtil && !p.rejected {
			continue
		}
		remaining := clamp01(1 - p.util)
		if p.rejected {
			remaining = 0
		}
		w := Window{Kind: kind, Remaining: remaining, ObservedAt: now, Source: "header"}
		if p.hasReset {
			w.ResetAt = time.Unix(int64(p.reset), 0).UTC()
		}
		out = append(out, w)
	}
	return out
}

func codexHeaderWindows(headers http.Header, now time.Time) []Window {
	var out []Window
	for _, slot := range []string{"primary", "secondary"} {
		minutes, errMin := strconv.Atoi(strings.TrimSpace(headers.Get("x-codex-" + slot + "-window-minutes")))
		used, errUsed := strconv.ParseFloat(strings.TrimSpace(headers.Get("x-codex-"+slot+"-used-percent")), 64)
		if errMin != nil || errUsed != nil || minutes <= 0 {
			continue
		}
		w := Window{Kind: codexKind(minutes), Remaining: clamp01(1 - used/100), ObservedAt: now, Source: "header"}
		if at, err := strconv.ParseInt(strings.TrimSpace(headers.Get("x-codex-"+slot+"-reset-at")), 10, 64); err == nil && at > 0 {
			w.ResetAt = time.Unix(at, 0).UTC()
		} else if after, err := strconv.ParseInt(strings.TrimSpace(headers.Get("x-codex-"+slot+"-reset-after-seconds")), 10, 64); err == nil && after > 0 {
			// The proxy's WebSocket quota events say only how long is left.
			w.ResetAt = now.Add(time.Duration(after) * time.Second).UTC()
		}
		out = append(out, w)
	}
	return out
}

func codexKind(minutes int) string {
	switch {
	case minutes <= 6*60:
		return KindFiveHour
	default:
		return KindWeekly
	}
}

// WindowsFromUsageBody reads quota windows from a provider usage endpoint response, and whether
// the response was one: a full reading, which names every window the account has.
func WindowsFromUsageBody(provider string, body []byte, now time.Time) ([]Window, bool) {
	var doc map[string]any
	if json.Unmarshal(body, &doc) != nil {
		return nil, false
	}
	var out []Window
	switch provider {
	case "claude":
		// A usage reading names its windows, null for one the account lacks; an answer naming none
		// ({"error": …}, null) says nothing of them.
		named := false
		for key := range doc {
			named = named || claudePollKind(key) != ""
		}
		if !named {
			return nil, false
		}
		for key, raw := range doc {
			kind := claudePollKind(key)
			window, ok := raw.(map[string]any)
			if kind == "" || !ok {
				continue
			}
			util, okUtil := window["utilization"].(float64)
			if !okUtil {
				continue
			}
			w := Window{Kind: kind, Remaining: clamp01(1 - util/100), ObservedAt: now, Source: "poll"}
			if s, okReset := window["resets_at"].(string); okReset {
				if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
					w.ResetAt = t.UTC()
				}
			}
			out = append(out, w)
		}
	case "codex":
		limits, ok := doc["rate_limit"].(map[string]any)
		if !ok {
			return nil, false
		}
		for _, name := range []string{"primary_window", "secondary_window"} {
			window, okWindow := limits[name].(map[string]any)
			if !okWindow {
				continue
			}
			seconds, okSec := window["limit_window_seconds"].(float64)
			used, okUsed := window["used_percent"].(float64)
			if !okSec || !okUsed || seconds <= 0 {
				continue
			}
			w := Window{Kind: codexKind(int(seconds / 60)), Remaining: clamp01(1 - used/100), ObservedAt: now, Source: "poll"}
			if at, okAt := window["reset_at"].(float64); okAt && at > 0 {
				w.ResetAt = time.Unix(int64(at), 0).UTC()
			} else if after, okAfter := window["reset_after_seconds"].(float64); okAfter && after > 0 {
				w.ResetAt = now.Add(time.Duration(after) * time.Second).UTC()
			}
			out = append(out, w)
		}
	default:
		return nil, false
	}
	return out, true
}

func clamp01(f float64) float64 {
	if math.IsNaN(f) {
		return 0
	}
	return math.Max(0, math.Min(1, f))
}

// ClaudePlan names the subscription in an Anthropic OAuth profile response: Team, Max 20x,
// Max 5x, Max, Pro or Free; "" when the response does not say.
func ClaudePlan(body []byte) string {
	var doc struct {
		Account struct {
			HasMax *bool `json:"has_claude_max"`
			HasPro *bool `json:"has_claude_pro"`
		} `json:"account"`
		Organization struct {
			Type   string `json:"organization_type"`
			Status string `json:"subscription_status"`
			Tier   string `json:"rate_limit_tier"`
		} `json:"organization"`
	}
	if json.Unmarshal(body, &doc) != nil {
		return ""
	}
	tier := strings.ToLower(doc.Organization.Tier)
	switch {
	case strings.EqualFold(doc.Organization.Type, "claude_team") && strings.EqualFold(doc.Organization.Status, "active"):
		return "Team"
	case doc.Account.HasMax != nil && *doc.Account.HasMax:
		switch {
		case strings.Contains(tier, "20x"):
			return "Max 20x"
		case strings.Contains(tier, "5x"):
			return "Max 5x"
		}
		return "Max"
	case doc.Account.HasPro != nil && *doc.Account.HasPro:
		return "Pro"
	case doc.Account.HasMax != nil && doc.Account.HasPro != nil:
		return "Free"
	}
	return ""
}

// CodexPlan names the ChatGPT plan in a Codex usage response, with the names the management
// panel uses; "" when the response does not say.
func CodexPlan(body []byte) string {
	var doc struct {
		PlanType string `json:"plan_type"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.PlanType == "" {
		return ""
	}
	switch strings.ToLower(doc.PlanType) {
	case "pro":
		return "Pro 200"
	case "prolite":
		return "Pro 100"
	}
	return titleCase(strings.ToLower(doc.PlanType))
}
