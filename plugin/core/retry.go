package core

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Retry on the bound account (docs/adr/0003, docs/architecture.md "When an account fails"): when a
// request fails on its session's bound account, quota-pilot keeps it there for a retry or two by
// declining the proxy's pick of any other account, for the failures something retries: the proxy's
// own next round, or Claude Code. A retry episode belongs to one binding and one model; it also
// owns the takeover boundary and the `hung` mark. Pick and Observe call into it; nothing else does.
const (
	// retriesAfterFailure and retriesAfterHang are an episode's budget: the retries quota-pilot
	// keeps a request on its account for. A hang gets one: a second wait as long costs more than a
	// cold start elsewhere.
	retriesAfterFailure = 2
	retriesAfterHang    = 1
	// retryWindow bounds when a retry may start after the first failure ended: Claude Code's own
	// retries reach about this far, and a longer wait is worse than a cold start.
	retryWindow = 75 * time.Second
	// waitAbove is the last main prompt, in tokens, from which a session waits through the proxy's
	// cooldown of its account: below it a cold start elsewhere costs less than the wait.
	waitAbove = 100_000
	// hangAfter is how long an attempt goes without any response before it is a hang: longer than
	// any first response Claude or Codex gives a large cold prompt, far shorter than a stuck one.
	hangAfter = 30 * time.Second
	// recordWait is how long a pick that does not offer the bound account waits for the record of
	// the attempt it just answered with it: the proxy publishes it before the next attempt, but
	// delivers it a moment later.
	recordWait = 200 * time.Millisecond
	// inventoryAge is how old the host's account list may be while an episode runs: an account
	// removed or disabled ends the episode within seconds, not at its give-up.
	inventoryAge = 5 * time.Second
	// defaultPause is the proxy's own pause after a recoverable failure with no Retry-After
	// (transientErrorCooldown), for the decline's estimate of when the account is offered again.
	defaultPause = time.Minute
)

// EventRetry is a binding event: a retry of an episode ended, worked or failed.
const EventRetry = "retry"

// episodeKey is a binding and a model: what an episode, a boundary and a mark belong to.
type episodeKey struct{ binding, model string }

// episode is the retry rule at work on one binding and model.
type episode struct {
	account   string
	gen       uint64    // the session's generation it began in
	cause     Cause     // the first failure
	firstEnd  time.Time // when the first failure ended
	budget    int
	tries     int
	tryAt     time.Time // when the running try was answered with the account; zero while none runs
	nextTry   time.Time // when the account is likely offered again
	answered  bool      // a retry answered: a time to first response, and not a hang
	retryHung bool
	last      *Cause // the last retry that failed
}

func (e *episode) giveUp() time.Time { return e.firstEnd.Add(retryWindow) }

// RetryView is an episode as the snapshot shows it.
type RetryView struct {
	Account        string    `json:"account"`
	Cause          Cause     `json:"cause"`
	FirstFailureAt time.Time `json:"first_failure_at"`
	Try            int       `json:"try"`
	NextTryAt      time.Time `json:"next_try_at"`
	GiveUpAt       time.Time `json:"give_up_at"`
	TryStartedAt   time.Time `json:"try_started_at,omitzero"`
}

// RetryOutcome is an episode that ended with a success on its account: the session kept it.
type RetryOutcome struct {
	Account   string    `json:"account"`
	Cause     Cause     `json:"cause"`
	Tries     int       `json:"tries"`
	AfterMs   int64     `json:"after_ms"` // from the first failure's end to when the try that worked was sent
	CacheRead int64     `json:"cache_read"`
	At        time.Time `json:"at"`
}

// retryable tells a failure something retries: the proxy's next round or Claude Code. Quota,
// sign-in, model and request failures are not, nor any other status.
func retryable(kind string) bool {
	switch kind {
	case FailHang, FailConnection, FailTimeout, FailOverloaded, FailServer, FailRate:
		return true
	}
	return false
}

// waitsOut tells a failure after which the proxy cools the account, so a retry there waits for the
// pause to end: any with a status. A lost connection and a bare deadline cool nothing, and the
// proxy offers the account again at once.
func waitsOut(status int) bool { return status != 0 }

// claudeCode tells a session of Claude Code: only its retries are pinned (ticket 01), and Codex's
// own are not, so a Codex session is never declined.
func claudeCode(root string) bool { return strings.HasPrefix(root, "claude:") }

// episodeLocked is the live episode of a binding and model, after dropping one that has ended: the
// session moved since it began, its account left, rests, or its budget or time ran out with no try
// running.
func (s *State) episodeLocked(ek episodeKey, root string, b *Binding, now time.Time) *episode {
	e := s.episodes[ek]
	if e == nil {
		return nil
	}
	sess := s.sessions[root]
	c := s.creds[e.account]
	switch {
	case b == nil || b.AuthID != e.account || sess == nil || sess.Generation != e.gen:
		delete(s.episodes, ek)
		return nil
	case c == nil || c.Disabled || c.health.resting(now),
		e.tryAt.IsZero() && (e.tries >= e.budget || !now.Before(e.giveUp())):
		s.endEpisodeLocked(ek, root, e, nil, now)
		return nil
	}
	return e
}

// episodeFailureLocked takes a failed attempt of the bound account into the binding's episode: a
// try's failure, or a first failure that starts one.
func (s *State) episodeFailureLocked(ek episodeKey, root string, b *Binding, u Usage, kind string, at, now time.Time) {
	sess := s.sessions[root]
	if moved := s.elsewhere[ek]; !claudeCode(root) || sess == nil || at.Before(sess.GenerationAt) || !moved.IsZero() && !at.After(moved) {
		return // sent before the session moved, or by the time its request went elsewhere
	}
	end := at.Add(u.Latency)
	e := s.episodeLocked(ek, root, b, now)
	if e != nil {
		if at.Before(e.firstEnd) {
			return // a request that failed with the first one
		}
		answered := u.TTFT > 0 && kind != FailHang
		e.tryAt = time.Time{}
		e.answered = e.answered || answered
		e.retryHung = e.retryHung || kind == FailHang
		e.last = &Cause{Kind: kind, Status: u.StatusCode, WaitMs: u.Latency.Milliseconds(), Answered: answered}
		s.retryLineLocked(ek, root, u, e, at, false)
		if retryable(kind) {
			e.nextTry = end.Add(pauseOf(u))
		}
		if kind == FailHang || !retryable(kind) || e.tries >= e.budget || s.creds[e.account].health.resting(now) {
			s.endEpisodeLocked(ek, root, e, nil, now)
		}
		return
	}
	c := s.creds[b.AuthID]
	if !retryable(kind) || c == nil || c.health.resting(now) || s.hung[ek] {
		return
	}
	// A session too small to wait through the proxy's pause gets only the retries that need none.
	last := sess.Last.Input + sess.Last.CacheRead + sess.Last.CacheCreation
	if waitsOut(u.StatusCode) && last < waitAbove {
		return
	}
	e = &episode{account: b.AuthID, gen: sess.Generation, firstEnd: end, budget: retriesAfterFailure,
		cause: Cause{Kind: kind, Status: u.StatusCode, WaitMs: u.Latency.Milliseconds()}, nextTry: end}
	if kind == FailHang {
		e.budget = retriesAfterHang
	}
	if waitsOut(u.StatusCode) {
		e.nextTry = end.Add(pauseOf(u))
	}
	s.episodes[ek] = e
}

// pauseOf is how long the proxy holds an account back after a failure: its Retry-After, which the
// proxy prefers, else its default pause.
func pauseOf(u Usage) time.Duration {
	if !waitsOut(u.StatusCode) {
		return 0
	}
	if secs, err := strconv.Atoi(strings.TrimSpace(http.Header(u.ResponseHeader).Get("Retry-After"))); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return defaultPause
}

// episodeSuccessLocked ends a binding's episode kept: a request answered on its account.
func (s *State) episodeSuccessLocked(ek episodeKey, root string, b *Binding, u Usage, at, now time.Time) {
	delete(s.hung, ek) // a success on the account clears the mark, whoever had it
	e := s.episodeLocked(ek, root, b, now)
	if e == nil || at.Before(e.firstEnd) {
		return
	}
	s.retryLineLocked(ek, root, u, e, at, true)
	s.endEpisodeLocked(ek, root, e, &u, now)
}

// endEpisodeLocked ends an episode: kept, with the request that worked, or not, which marks the
// binding `hung` when it began with a hang and no retry answered, or when a retry hung, and gives
// the move that follows its retries.
func (s *State) endEpisodeLocked(ek episodeKey, root string, e *episode, kept *Usage, now time.Time) {
	delete(s.episodes, ek)
	if kept != nil {
		if sess := s.sessions[root]; sess != nil && ek.binding == keyOf(ek.binding, root) {
			// When the try that worked was sent, after the first failure: "the retry 61s later worked".
			sent := kept.RequestedAt
			if sent.IsZero() || sent.After(now) {
				sent = now
			}
			sess.RetryOutcome = &RetryOutcome{Account: e.account, Cause: e.cause, Tries: e.tries,
				AfterMs: max(0, sent.Sub(e.firstEnd).Milliseconds()), CacheRead: kept.CacheRead, At: now}
		}
		s.dirty = true
		return
	}
	if e.cause.Kind == FailHang && !e.answered || e.retryHung {
		s.hung[ek] = true
	}
	if f := s.failures[ek.binding][ek.model]; f != nil {
		f.Retries, f.LastRetry = e.tries, e.last
	}
	s.dirty = true
}

// keyOf is the root binding key of a binding key's provider: provider|root.
func keyOf(binding, root string) string {
	provider, _, _ := strings.Cut(binding, "|")
	return provider + "|" + root
}

// retryLineLocked writes a try's event line: its number, how long after the first failure it
// started, whether it worked, and how it failed.
func (s *State) retryLineLocked(ek episodeKey, root string, u Usage, e *episode, at time.Time, ok bool) {
	provider, canonical, _ := strings.Cut(ek.binding, "|")
	line := LogEntry{T: at.UnixMilli(), Session: RawSession(root), Agent: canonical != root, Account: e.account, Provider: provider,
		Model: u.Model, Poll: true, Ev: EventRetry, Try: max(1, e.tries), Since: max(0, at.Sub(e.firstEnd).Milliseconds()), OK: ok}
	if !ok && e.last != nil {
		line.F, line.St, line.W, line.Answered = e.last.Kind, e.last.Status, e.last.WaitMs, e.last.Answered
	}
	s.log = append(s.log, line)
}

// endEpisodesOfLocked ends every episode and mark of a session's bindings: a switch or a route.
func (s *State) endEpisodesOfLocked(root string) {
	for ek := range s.episodes {
		if strings.HasSuffix(ek.binding, "|"+root) {
			delete(s.episodes, ek)
		}
	}
	for ek := range s.hung {
		if strings.HasSuffix(ek.binding, "|"+root) {
			delete(s.hung, ek)
		}
	}
}

// declineLocked is the reason a pick is declined while its binding's episode waits for its
// account, worded as the band's waiting row: what failed, when it is retried, and who takes over.
func (s *State) declineLocked(e *episode, model string, now time.Time) string {
	labels := s.labelsLocked()
	when := "retrying it now"
	switch {
	case e.nextTry.After(e.giveUp()):
		when = fmt.Sprintf("waiting up to %ds for it", int(retryWindow.Seconds()))
	case e.nextTry.Sub(now) >= time.Second:
		when = fmt.Sprintf("retrying it in about %ds", int(e.nextTry.Sub(now).Round(time.Second).Seconds()))
	}
	next := "another account"
	if c := s.creds[e.account]; c != nil {
		if to := s.takeoverLocked(c, model, now); to != "" {
			next = labels[to]
		}
	}
	return fmt.Sprintf("quota-pilot: %s %s; %s; %s is next if needed", labels[e.account], failurePhrase(e.cause), when, next)
}

// failurePhrase is what a failure did, as the band says it: "returned HTTP 529", "hung for 2m 15s".
func failurePhrase(c Cause) string {
	switch c.Kind {
	case FailHang:
		return "hung for " + WaitText(time.Duration(c.WaitMs)*time.Millisecond)
	case FailConnection:
		return "lost its connection"
	case FailTimeout:
		return "timed out"
	case FailRate:
		return "was rate-limited"
	}
	if c.Status != 0 {
		return fmt.Sprintf("returned HTTP %d", c.Status)
	}
	return "failed"
}

// WaitText is a wait as long as its seconds matter: "45s", "2m 15s", "2m", "1h 5m".
func WaitText(d time.Duration) string {
	s := max(1, int(d.Round(time.Second).Seconds()))
	switch {
	case s < 60:
		return fmt.Sprintf("%ds", s)
	case s < 3600 && s%60 != 0:
		return fmt.Sprintf("%dm %ds", s/60, s%60)
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	}
	m := (s + 30) / 60
	if m%60 != 0 {
		return fmt.Sprintf("%dh %dm", m/60, m%60)
	}
	return fmt.Sprintf("%dh", m/60)
}

// retryViewLocked is a session's live episode for its next turn's model, for the snapshot.
func (s *State) retryViewLocked(provider, root, model string, now time.Time) *RetryView {
	key := provider + "|" + root
	e := s.episodeLocked(episodeKey{key, modelKey(model)}, root, s.bindings[key], now)
	if e == nil {
		return nil
	}
	return &RetryView{Account: e.account, Cause: e.cause, FirstFailureAt: e.firstEnd, Try: e.tries,
		NextTryAt: e.nextTry, GiveUpAt: e.giveUp(), TryStartedAt: e.tryAt}
}

// NeedsAccountList tells whether a pick's binding has a live episode while the host's account list
// is older than inventoryAge: it is read again first, so an account removed or disabled ends it.
func (s *State) NeedsAccountList(in PickInput) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	root := RootSession(in.Canonical, in.Parent)
	key, b := s.boundLocked(pickProviders(in), in.Canonical, root)
	if b == nil || s.episodeLocked(episodeKey{key, modelKey(in.Model)}, root, b, now) == nil {
		return false
	}
	return now.Sub(s.inventoryAt) > inventoryAge
}
