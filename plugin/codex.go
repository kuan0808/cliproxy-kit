package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// ---- what a Codex hook shows ----

// codexHookResponse answers a Codex hook (README, "Codex"), which sends its session's id in a
// header: at the session's start a line on the account it runs on and how much of that account is
// used; at the end of a turn a line only when that changed in a way that matters: another account
// took the session, or a window of its account passed 80% or ran out. Codex shows a hook's
// systemMessage as a notice, apart from the model's context; "{}" says nothing.
func codexHookResponse(req pluginapi.ManagementRequest) ([]byte, error) {
	start := req.Query.Get("event") == "SessionStart"
	token, _ := strings.CutPrefix(req.Headers.Get("Authorization"), "Bearer ")
	client, known := state.Client(strings.TrimSpace(token))
	text := ""
	switch id := strings.TrimSpace(req.Headers.Get("X-Codex-Session")); {
	case !known:
		if start {
			text = "quota-pilot: quota shows once this key has sent a request through the proxy"
		}
	case sessionID.MatchString(id) && state.MayName("codex:"+id, client):
		text = codexNotice("codex:"+id, client, start, time.Now())
	}
	out := map[string]string{}
	if text != "" {
		out["systemMessage"] = text
	}
	body, errMarshal := json.Marshal(out)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return httpResponse(http.StatusOK, body)
}

// told is what a Codex session was last told: its account, and how far each of its windows was
// used (see levelOf).
type told struct {
	auth   string
	levels map[string]int
	at     time.Time
}

var codexTold = struct {
	sync.Mutex
	sessions map[string]told
}{sessions: map[string]told{}}

// codexNotice is what a Codex session is told at its start, and at the end of a turn what changed
// since it was last told; "" for nothing.
func codexNotice(session, client string, start bool, now time.Time) string {
	snap := state.BuildForBand(session, "", client)
	view := snap.Providers["codex"]
	if view == nil || len(view.Credentials) == 0 {
		return ""
	}
	sess := snap.Sessions[session]
	cred, expected := codexAccount(view, sess, snap.Expected["codex"])
	if cred == nil {
		return ""
	}
	// The window that went furthest past a mark since the session was last told, if one did.
	levels, up := map[string]int{}, 0
	var crossed core.WindowView
	codexTold.Lock()
	last, seen := codexTold.sessions[session]
	for _, w := range cred.Windows {
		levels[w.Kind] = levelOf(w)
		if levels[w.Kind] > last.levels[w.Kind] && levels[w.Kind] > up {
			up, crossed = levels[w.Kind], w
		}
	}
	codexTold.sessions[session] = told{auth: cred.ID, levels: levels, at: now}
	for id, t := range codexTold.sessions {
		if now.Sub(t.at) > 24*time.Hour {
			delete(codexTold.sessions, id)
		}
	}
	codexTold.Unlock()

	usage := windowsText(cred, now)
	switch {
	case (start || !seen) && expected:
		return fmt.Sprintf("quota-pilot: expected on %s · %s", accountText(cred), usage)
	case start || !seen:
		// Told nothing yet (its key was new at the start, or the proxy restarted): all of it.
		return fmt.Sprintf("quota-pilot: on %s · %s", accountText(cred), usage)
	case last.auth != cred.ID:
		// Another account took the session: why, in the band's words, when the record says.
		if sw := sess.LastSwitch; sw != nil && sw.To == cred.ID {
			from := "previous account"
			if c := credByID(view, sw.From); c != nil {
				from = c.Label
			}
			why, _ := moveWhy(*sw, from, now)
			return fmt.Sprintf("quota-pilot: switched to %s · %s · %s", accountText(cred), why, usage)
		}
		return fmt.Sprintf("quota-pilot: switched to %s · %s", accountText(cred), usage)
	case up == 2:
		// An account read as used up answers until it refuses a request (see State.Pick).
		next := "no other account has quota"
		if n := credByID(view, nextOf(sess)); n != nil && n.ID != cred.ID {
			next = "the session moves to " + n.Label + " once it stops answering"
		}
		return fmt.Sprintf("quota-pilot: %s has used up its %s quota%s; %s", cred.Label, strings.ToLower(crossed.Label), resetText(crossed, now), next)
	case up == 1:
		return fmt.Sprintf("quota-pilot: %s has used %d%% of its %s quota%s", cred.Label, used(crossed), strings.ToLower(crossed.Label), resetText(crossed, now))
	}
	return ""
}

// codexAccount is the account a Codex session runs on, or, before the proxy has seen it, the one
// a new session gets.
func codexAccount(view *core.ProviderView, sess *core.SessionView, next string) (cred *core.CredView, expected bool) {
	if sess != nil {
		if c := credByID(view, sess.AuthID); c != nil {
			return c, false
		}
	}
	return credByID(view, next), true
}

func nextOf(sess *core.SessionView) string {
	if sess == nil {
		return ""
	}
	return sess.NextAuthID
}

func credByID(view *core.ProviderView, id string) *core.CredView {
	for _, c := range view.Credentials {
		if id != "" && c.ID == id {
			return c
		}
	}
	return nil
}

// moveWhy is why a session left from, worded from its switch record and never from the account's
// state now, as the band words it (mod/hooks/logic.ts moveWhy; mod/tests/moves.js holds both
// sides' expected wording): why for the notice, short for a narrow row.
func moveWhy(sw core.Switch, from string, now time.Time) (why, short string) {
	c := core.Cause{}
	if sw.Cause != nil {
		c = *sw.Cause
	}
	if sw.Kind == core.MoveRest {
		// The failures that rested it, while their kind agrees, and when it is tried again.
		what := fmt.Sprintf("%s resting after %d failures", from, max(c.Count, 2))
		if c.Kind != "" {
			what = failedWhy(c, from)
		}
		switch {
		case !c.Until.After(now):
			short, _, _ := strings.Cut(what, "; ")
			return what, short
		case c.Kind != "":
			return what + "; resting, back in " + untilText(c.Until.Sub(now)), from + " resting"
		}
		return what, from + " resting"
	}
	status := ""
	if c.Status != 0 {
		status = fmt.Sprintf(" (HTTP %d)", c.Status)
	}
	said := func(why string) (string, string) {
		short, _, _ := strings.Cut(why, "; ")
		return why, short
	}
	switch sw.Kind {
	case "":
		switch {
		case strings.Contains(sw.Reason, "by user"):
			return said("switched by you")
		case strings.HasPrefix(sw.Reason, "moved while idle"):
			return said("moved while idle")
		}
		return said("reason not recorded")
	case core.MoveUser:
		if c.WaitedMs > 0 {
			// From a waiting turn (the band's Switch now): how long it had waited.
			return "by you after waiting " + core.WaitText(time.Duration(c.WaitedMs)*time.Millisecond), "by you"
		}
		return said("switched by you")
	case core.MoveQuota:
		reason := c.Reason
		if reason == "" {
			reason = "quota used up"
		}
		return said(from + " " + reason)
	case core.MoveIdle:
		if c.Reason == "" {
			return said("moved while idle")
		}
		return said(from + " " + c.Reason + "; moved while idle")
	case core.MoveGone:
		if c.Reason == "disabled" {
			return said(from + " is disabled")
		}
		return said(from + " was removed")
	case core.MoveSignIn:
		return said(from + " refused sign-in" + status)
	case core.MoveModel:
		model := c.Model
		if model == "" {
			model = "this model"
		}
		return said(from + " cannot serve " + strings.TrimPrefix(model, "claude-"))
	case core.MoveLeftOut:
		return "the proxy left " + from + " out; no failure recorded", "reason unknown"
	}
	if c.Kind == core.FailHang {
		return failedWhy(c, from) + retryTail(c), from + " hung"
	}
	return said(failedWhy(c, from) + retryTail(c))
}

// retryTail is how the last retry failed, when that says more than its count: "; the retry got no
// answer".
func retryTail(c core.Cause) string {
	r := c.LastRetry
	switch {
	case r == nil, r.Kind == c.Kind && r.Kind != core.FailRequest:
		return ""
	case r.Kind == core.FailRequest && r.Answered:
		return "; the retry was cancelled"
	case r.Kind == core.FailRequest:
		return "; the retry got no answer"
	}
	once := *r
	once.Count = 1
	return "; " + failedWhy(once, "the retry")
}

// failedWhy is what a failure, or a run of failures of one kind, did: "d••• returned HTTP 529 twice".
func failedWhy(c core.Cause, from string) string {
	n := ""
	switch {
	case c.Count == 2:
		n = " twice"
	case c.Count > 2:
		n = fmt.Sprintf(" %d times", c.Count)
	}
	switch c.Kind {
	case core.FailHang:
		if n != "" {
			return from + " hung" + n
		}
		return from + " hung for " + core.WaitText(time.Duration(c.WaitMs)*time.Millisecond)
	case core.FailConnection:
		return from + " lost its connection" + n
	case core.FailTimeout:
		return from + " timed out" + n
	case core.FailOverloaded:
		code := c.Status
		if code == 0 {
			code = 529
		}
		return fmt.Sprintf("%s returned HTTP %d%s", from, code, n)
	case core.FailServer:
		return fmt.Sprintf("%s returned HTTP %d%s", from, c.Status, n)
	case core.FailRate:
		return from + " was rate-limited" + n
	}
	if c.Status != 0 {
		return fmt.Sprintf("%s failed (HTTP %d)%s", from, c.Status, n)
	}
	return from + " failed" + n
}

// levelOf is how far a window is used: 0 below 80%, 1 from 80%, 2 used up.
func levelOf(w core.WindowView) int {
	switch {
	case w.Remaining <= 0:
		return 2
	case w.Remaining <= 0.2:
		return 1
	}
	return 0
}

func accountText(c *core.CredView) string {
	if c.Plan != "" {
		return fmt.Sprintf("%s (%s)", c.Label, c.Plan)
	}
	return c.Label
}

// windowsText is each window of an account as "5-hour 12% used", a reading grown old marked "~".
func windowsText(c *core.CredView, now time.Time) string {
	if len(c.Windows) == 0 {
		return "no quota reading yet"
	}
	parts := make([]string, 0, len(c.Windows))
	for _, w := range c.Windows {
		stale := ""
		if w.Stale {
			stale = "~"
		}
		parts = append(parts, fmt.Sprintf("%s %d%%%s used%s", strings.ToLower(w.Label), used(w), stale, resetText(w, now)))
	}
	return strings.Join(parts, " · ")
}

func used(w core.WindowView) int { return int(math.Round((1 - w.Remaining) * 100)) }

// resetText is ", resets in 3d 4h" for a window that resets ahead; "" for one that does not say.
func resetText(w core.WindowView, now time.Time) string {
	if w.ResetAt.IsZero() || !w.ResetAt.After(now) {
		return ""
	}
	return ", resets in " + untilText(w.ResetAt.Sub(now))
}

// untilText is a duration as the band writes it: "3d 4h", "13h", "2h 5m", "12m".
func untilText(d time.Duration) string {
	total := int(math.Round(d.Minutes()))
	days, hours, minutes := total/(24*60), total%(24*60)/60, total%60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd %dh", days, hours)
	case hours >= 10 || hours > 0 && minutes == 0:
		return fmt.Sprintf("%dh", hours)
	case hours > 0:
		return fmt.Sprintf("%dh %dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", max(1, minutes))
}
