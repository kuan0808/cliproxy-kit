package core

import (
	"strings"
	"time"
)

// Failure kinds: what a failed attempt says about its account (docs/architecture.md, "When an
// account fails").
const (
	FailRequest    = "request"    // the request's own fault, or a client cancel: not the account's
	FailModel      = "model"      // the account does not serve the model
	FailQuota      = "quota"      // a 429 while the account is read as used up
	FailSignIn     = "sign-in"    // 401, 402, 403, or a refused grant
	FailHang       = "hang"       // no response in the first 30 s, after waiting 30 s or more
	FailConnection = "connection" // the connection was lost or never made
	FailTimeout    = "timeout"    // 408, 504, 524, or a deadline
	FailOverloaded = "overloaded" // 529, or an overloaded_error body
	FailServer     = "server"     // any other 5xx
	FailRate       = "rate"       // a 429 while the account is not read as used up
	FailOther      = "other"      // any other status
)

// hangAfter is how long an attempt goes without any response before it is a hang: longer than any
// first response Claude or Codex gives a large cold prompt, far shorter than a stuck connection.
const hangAfter = 30 * time.Second

// Attempt is a failed attempt as its usage record tells it, and what the classifier needs besides.
type Attempt struct {
	Status  int
	Body    string        // the error text; read here, never stored
	TTFT    time.Duration // time to the first response, 0 when none came
	Wait    time.Duration // how long the attempt waited
	Compact bool          // a Codex compact request
	UsedUp  bool          // the account is read as used up for the request's model
}

// ClassifyFailure names a failed attempt's kind. The rows are tried in order: what the proxy reads
// as the request's own fault first, then the account's verdicts, then how the attempt ended.
func ClassifyFailure(a Attempt) string {
	signIn := a.Status == 401 || a.Status == 402 || a.Status == 403 || InvalidGrant(a.Status, a.Body)
	switch {
	case a.Status == 499:
		return FailRequest // a client cancel, whatever its wait
	case a.Compact && !signIn && a.Status != 429 && !CloudflareChallenge(a.Status, a.Body):
		// The proxy leaves the account alone after a compact request's failure.
		return FailRequest
	case RequestFault(a.Status, a.Body):
		return FailRequest
	case ModelUnsupported(a.Status, a.Body):
		return FailModel
	case a.Status == 429 && a.UsedUp:
		return FailQuota
	case signIn:
		return FailSignIn
	case a.Wait >= hangAfter && (a.TTFT == 0 || a.TTFT >= hangAfter):
		return FailHang
	case connectionLost(a.Status, a.Body):
		return FailConnection
	case a.Status == 408 || a.Status == 504 || a.Status == 524 || a.Status == 0 && deadline(a.Body):
		return FailTimeout
	case a.Status == 529 || bodyFieldIs(a.Body, "type", "overloaded_error"):
		return FailOverloaded
	case a.Status >= 500 && a.Status <= 599:
		return FailServer
	case a.Status == 429:
		return FailRate
	}
	return FailOther
}

// connectionLost tells a failure that ended at the connection: an error the executor raised with no
// status, or the proxy's own word for a Codex stream that broke before it completed (a 408).
func connectionLost(status int, body string) bool {
	lower := strings.ToLower(body)
	if strings.Contains(lower, "stream disconnected before completion") {
		return true
	}
	if status != 0 {
		return false
	}
	for _, sign := range [...]string{"eof", "connection reset", "connection refused", "broken pipe", "no route to host",
		"network is unreachable", "no such host", "server misbehaving", "tls", "x509", "certificate",
		"connection closed", "use of closed network connection", "http2: "} {
		if strings.Contains(lower, sign) {
			return true
		}
	}
	return false
}

func deadline(body string) bool {
	lower := strings.ToLower(body)
	return strings.Contains(lower, "deadline exceeded") || strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out")
}

// healthFailure tells whether a kind says something about the account itself, so it may be named
// as why a session left it: not the request's fault.
func healthFailure(kind string) bool { return kind != "" && kind != FailRequest }
