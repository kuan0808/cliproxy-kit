package core

import (
	"fmt"
	"time"
)

// An account that keeps failing rests (docs/architecture.md, "When an account fails"): quota-pilot
// ranks it after every account that can serve and is not resting, and moves the sessions bound to it
// at their next turn. Only the failures the proxy holds no account back for count; it cools the
// account itself after the others. A rest never changes the proxy's own state, and lives in memory.
const (
	// momentWindow: failures that end this close to a moment's first failure are that moment, as
	// requests that hung from different times and failed together, or several sessions at once.
	momentWindow = 10 * time.Second
	// pairWindow: a second moment this soon after the first, with no success between, starts a rest.
	pairWindow = 15 * time.Minute
	// firstRest is the first rest; each rest after a failed trial doubles it, up to longestRest.
	firstRest   = 5 * time.Minute
	longestRest = time.Hour
)

// health is an account's failure moments since its last success, and its rest.
type health struct {
	momentAt time.Time // when the current moment's first failure ended
	moments  int       // failure moments since the last success
	kind     string    // the kind of those moments' failures, "" once they differ
	status   int
	waitMs   int64
	level    int       // rests since the last success: the next is firstRest doubled level times
	until    time.Time // the current or last rest's end
}

// restCounts tells whether a failure kind counts toward rest: the failures the proxy cools no account
// for, or only briefly.
func restCounts(kind string) bool {
	switch kind {
	case FailHang, FailConnection, FailTimeout, FailOverloaded, FailServer:
		return true
	}
	return false
}

func restLength(level int) time.Duration {
	if level > 4 {
		return longestRest
	}
	return min(longestRest, firstRest<<(level-1))
}

// failed notes a counting failure that ended at end: a moment of its own unless it ended within
// momentWindow of the current moment's first failure. A second moment within pairWindow rests the
// account; on trial, after a rest and before any success, one moment rests it again at once, for
// twice as long.
func (h *health) failed(kind string, status int, wait time.Duration, end time.Time) {
	if !h.momentAt.IsZero() && end.Sub(h.momentAt).Abs() <= momentWindow {
		return
	}
	previous := h.momentAt
	h.momentAt = end
	if h.resting(end) {
		return // a request already running when the rest began
	}
	h.moments++
	switch {
	case h.moments == 1:
		h.kind = kind
	case h.kind != kind:
		h.kind = ""
	}
	h.status, h.waitMs = status, wait.Milliseconds()
	switch {
	case h.level > 0:
		h.level++
		h.until = end.Add(restLength(h.level))
	case h.moments >= 2 && !previous.IsZero() && end.Sub(previous) <= pairWindow:
		h.level = 1
		h.until = end.Add(firstRest)
	}
}

// succeeded ends a rest or a trial, and starts the count over.
func (h *health) succeeded() { *h = health{} }

func (h *health) resting(now time.Time) bool { return h.level > 0 && now.Before(h.until) }

func (h *health) trial(now time.Time) bool { return h.level > 0 && !now.Before(h.until) }

func (h *health) reason() string { return fmt.Sprintf("resting after %d failures", h.moments) }

// cause is a rest move's cause: the failures that led to it, their kind when they agree, and when the
// rest ends.
func (h *health) cause() *Cause {
	return &Cause{Kind: h.kind, Status: h.status, WaitMs: h.waitMs, Count: h.moments, Until: h.until}
}

// RestView is an account's rest as the snapshot shows it.
type RestView struct {
	Until    time.Time `json:"until"`
	Moments  int       `json:"moments"`
	LastKind string    `json:"last_kind,omitempty"`
	Trial    bool      `json:"trial,omitempty"`
}

func (h *health) view(now time.Time) *RestView {
	if h.level == 0 {
		return nil
	}
	return &RestView{Until: h.until, Moments: h.moments, LastKind: h.kind, Trial: h.trial(now)}
}
