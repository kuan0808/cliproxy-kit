package core

import (
	"encoding/json"
	"strings"

	"github.com/tidwall/gjson"
)

// The proxy's own verdicts on a failed attempt, ported: a usage record carries only the attempt's
// status and its error body, never what CLIProxyAPI concluded from them. Each function follows the
// rule of the same name in CLIProxyAPI v8 (sdk/cliproxy/auth/conductor_cooldown.go and
// internal/clienterror), and the proxy contract test checks the two agree on one corpus.

// RequestFault reports whether the proxy reads a failure as the request's own fault: it stops the
// request with no failover and leaves the account alone (isRequestInvalidError). A model the account
// cannot serve, a refused grant and a Cloudflare challenge are not request faults.
func RequestFault(status int, body string) bool {
	if CloudflareChallenge(status, body) || InvalidGrant(status, body) || ModelUnsupported(status, body) {
		return false
	}
	if status == 402 || status == 429 {
		return false
	}
	if status == 401 && bodyFieldIs(body, "type", "authentication_error") {
		return false
	}
	if claudeThreadNotFound(status, body) {
		return true
	}
	if bodyFieldIs(body, "code", "model_not_found", "model_not_found_error") {
		return false
	}
	if requestFaultBody(body) || itemNotPersisted(body) {
		return true
	}
	switch status {
	case 400, 409, 413, 422:
		return true
	}
	return false
}

// ModelUnsupported reports whether the proxy reads a failure as the account not serving the model:
// it cools that model on the account, not the account (isModelSupportError, which the proxy calls
// without the requested model, so a not-found type beside a message naming the model is not one).
func ModelUnsupported(status int, body string) bool {
	if structuredModelNotFound(body) {
		return true
	}
	if status != 400 && status != 404 && status != 422 {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(body))
	for _, pattern := range [...]string{
		"model_not_supported", "requested model is not supported", "requested model is unsupported",
		"requested model is unavailable", "model is not supported", "model not supported",
		"unsupported model", "model unavailable", "not available for your plan", "not available for your account",
	} {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// InvalidGrant reports whether the proxy reads a failure as a refused sign-in grant: an
// `invalid_grant` on a 400 or 401, or with no status at all (isInvalidGrantError).
func InvalidGrant(status int, body string) bool {
	if !strings.Contains(strings.ToLower(body), "invalid_grant") {
		return false
	}
	return status == 400 || status == 401 || status == 0
}

// CloudflareChallenge reports whether a failure is a Cloudflare challenge page, which the proxy
// never reads as a request fault; a 5xx is the origin's failure instead (isCloudflareChallengeError).
func CloudflareChallenge(status int, body string) bool {
	if status >= 500 {
		return false
	}
	lower := strings.ToLower(strings.TrimSpace(body))
	return strings.Contains(lower, "challenge-platform") || strings.Contains(lower, "cf-mitigated") ||
		strings.Contains(lower, "cloudflare challenge") ||
		(strings.Contains(lower, "just a moment") && strings.Contains(lower, "cloudflare"))
}

// bodyFieldIs reports whether a JSON body's `error.<name>`, `<name>`, `response.error.<name>` or
// `body.error.<name>` is one of the values, compared lower-cased.
func bodyFieldIs(body, name string, values ...string) bool {
	body = strings.TrimSpace(body)
	if body == "" || !json.Valid([]byte(body)) {
		return false
	}
	for _, path := range []string{"error." + name, name, "response.error." + name, "body.error." + name} {
		v := strings.ToLower(strings.TrimSpace(gjson.Get(body, path).String()))
		for _, want := range values {
			if v == want {
				return true
			}
		}
	}
	return false
}

func requestFaultBody(body string) bool {
	return bodyFieldIs(body, "code", "cyber_policy", "context_length_exceeded", "message_too_big",
		"string_above_max_length", "invalid_prompt", "invalid_value", "unsupported_value",
		"invalid_request_error", "previous_response_not_found") ||
		bodyFieldIs(body, "type", "invalid_request", "invalid_request_error", "bad_request_error", "invalid_prompt")
}

func itemNotPersisted(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "item with id") && strings.Contains(lower, "not found") &&
		strings.Contains(lower, "items are not persisted when `store` is set to false")
}

func claudeThreadNotFound(status int, body string) bool {
	body = strings.TrimSpace(body)
	if status != 404 || body == "" || !json.Valid([]byte(body)) {
		return false
	}
	message := strings.ToLower(gjson.Get(body, "error.message").String())
	return strings.EqualFold(strings.TrimSpace(gjson.Get(body, "error.type").String()), "not_found_error") &&
		strings.Contains(message, "thread state") && strings.Contains(message, "previous_message_id")
}

// structuredModelNotFound follows isStructuredModelNotFoundError: a JSON body that names a
// model-not-found code, type or message anywhere.
func structuredModelNotFound(body string) bool {
	var payload any
	if json.Unmarshal([]byte(strings.TrimSpace(body)), &payload) != nil {
		return false
	}
	return containsModelNotFound(payload)
}

func containsModelNotFound(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok {
				switch strings.ToLower(strings.TrimSpace(key)) {
				case "code", "type":
					if modelNotFoundIdentifier(text) {
						return true
					}
				case "error", "message", "detail", "error_description", "title":
					if modelNotFoundMessage(text) {
						return true
					}
				}
			}
			switch item.(type) {
			case map[string]any, []any:
				if containsModelNotFound(item) {
					return true
				}
			}
		}
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok && modelNotFoundMessage(text) {
				return true
			}
			if containsModelNotFound(item) {
				return true
			}
		}
	}
	return false
}

func modelNotFoundIdentifier(value string) bool {
	candidate := strings.ToLower(strings.TrimSpace(value))
	if fragment := strings.LastIndex(candidate, "#"); fragment >= 0 && fragment+1 < len(candidate) {
		candidate = candidate[fragment+1:]
	} else {
		if query := strings.Index(candidate, "?"); query >= 0 {
			candidate = candidate[:query]
		}
		candidate = strings.TrimRight(candidate, "/")
		if separator := strings.LastIndexAny(candidate, "/:"); separator >= 0 {
			candidate = candidate[separator+1:]
		}
	}
	switch strings.NewReplacer("-", "_", " ", "_").Replace(candidate) {
	case "model_not_found", "model_not_found_error", "unknown_model", "model_does_not_exist", "model_not_exist":
		return true
	}
	return false
}

// modelNotFoundMessage follows isExplicitModelNotFoundMessage with no requested model: a message
// that names model_not_found or unknown_model, is "no such model" or "unknown model" alone, or says
// the model is missing.
func modelNotFoundMessage(message string) bool {
	lower := strings.Trim(strings.ToLower(strings.TrimSpace(message)), " .!;\t\r\n")
	if lower == "" || strings.Contains(lower, "in request") || strings.Contains(lower, "in body") || strings.Contains(lower, "request body") {
		return false
	}
	normalized := strings.ReplaceAll(lower, "-", "_")
	if strings.Contains(normalized, "model_not_found") || strings.Contains(normalized, "unknown_model") {
		return true
	}
	for _, prefix := range []string{"no such model", "unknown model"} {
		if remainder, ok := afterPrefix(lower, prefix); ok {
			return remainder == ""
		}
	}
	for _, prefix := range []string{"the requested model", "requested model", "the model", "model"} {
		if remainder, ok := afterPrefix(lower, prefix); ok {
			return missingModelPhrase(remainder)
		}
	}
	return false
}

// afterPrefix returns what follows a leading word group and an optional colon, when the text
// starts with it as whole words.
func afterPrefix(lower, prefix string) (string, bool) {
	if lower != prefix && !strings.HasPrefix(lower, prefix+" ") && !strings.HasPrefix(lower, prefix+":") {
		return "", false
	}
	remainder := strings.TrimSpace(strings.TrimPrefix(lower, prefix))
	return strings.TrimSpace(strings.TrimPrefix(remainder, ":")), true
}

func missingModelPhrase(value string) bool {
	switch strings.Trim(value, " .!;\t\r\n") {
	case "not found", "was not found", "could not be found", "does not exist", "doesn't exist", "not exist",
		"is unknown", "does not exist or you do not have access to it":
		return true
	}
	return false
}
