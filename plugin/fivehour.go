package main

import (
	"sort"
	"time"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
)

// The 5-hour range: each account's running 5-hour window, counted as the week range counts a week,
// beside the windows of the last day. A 5-hour window starts with the first request after the last
// one ended, so windows follow no schedule: only readings that name their reset tell them apart,
// and the log holds those from 0.1.4 on. The running window is told by the proxy's own reading.

// usageWindow is one 5-hour window of one account, in parts of that window.
type usageWindow struct {
	Account   string             `json:"account"`
	From      int64              `json:"from"`
	To        int64              `json:"to"`      // when it resets, or ended when the next began first
	Running   bool               `json:"running"` // the window the summary shows
	Used      float64            `json:"used"`    // its last reading
	BeforeLog float64            `json:"before_log,omitempty"`
	Outside   float64            `json:"outside,omitempty"`
	Projects  map[string]float64 `json:"projects,omitempty"`
	Requests  int                `json:"requests"`
	Tokens    core.TokenSum      `json:"tokens"`
	Sessions  []daySession       `json:"sessions"` // the largest, up to three
}

// fiveHour reads an account over the 5-hour range: its running window, counted as the week range
// counts a week (when it started over in place, from then on), and the windows of the last day,
// from one walk begun a window earlier so the rate and the reading are known where they begin.
func (u *reading) fiveHour(info core.AccountInfo, lines []core.LogEntry, logStart int64, now time.Time, keep func(string) bool) usageAccount {
	id, nowMs := info.ID, now.UnixMilli()
	reset, present, absent := state.FiveHour(id)
	// Whether the account has a 5-hour window, whether it was read at all, and its latest 5-hour
	// reading. A Codex account may have a weekly window only; the provider's last full reading says
	// so, whatever older readings had.
	has, read := present, present || absent || !info.ResetAt.IsZero()
	var last *core.LogEntry
	// The windows of the last day are walked from the readings that name their reset; the others
	// cannot tell one window from the next across a pause. An idle window names none and loses none.
	named := make([]core.LogEntry, len(lines))
	unnamed := -1 // the last reading that shows use but names no reset
	for i, e := range lines {
		read = read || e.Used7d != nil || e.Used5h != nil
		if e.Used5h != nil {
			has, last = !absent, &lines[i]
		}
		if e.Reset5 == 0 {
			if e.Used5h != nil && *e.Used5h > 0 {
				unnamed = i
			}
			e.Used5h = nil
		}
		named[i] = e
	}
	switch {
	case unnamed < 0:
	case unnamed+1 < len(lines):
		u.namedFrom[id] = lines[unnamed+1].T
	default:
		u.namedFrom[id] = lines[unnamed].T + 1
	}
	past := core.Attribute(named, id, core.Span{From: nowMs - day - 2*core.FiveMs, To: nowMs,
		CountFrom: nowMs - day - core.FiveMs, LogStart: logStart, Range: true, Five: true})
	// The running window resets when the proxy last read it would, else when the log says.
	r := int64(0)
	if reset.After(now) {
		r = reset.UnixMilli()
	} else if n := len(past.Periods); n > 0 && past.Periods[n-1].Ended == 0 && windowEnd(past.Periods[n-1]) > nowMs {
		r = windowEnd(past.Periods[n-1])
	}
	info.ResetAt = time.Time{}
	start, from := nowMs, nowMs
	idle := core.Attribute(nil, id, core.Span{From: nowMs, To: nowMs, CountFrom: nowMs}) // none running: nothing counts
	current := idle
	if r > 0 {
		start, from = r-core.FiveMs, r-core.FiveMs-core.WindowJitter
		current = core.Attribute(lines, id, core.Span{From: from, To: nowMs, CountFrom: from, LogStart: logStart,
			WindowStart: start, Five: true, Keep: keep})
		// A window whose readings used nothing and that served no request is not running: the
		// provider names a reset for it all the same, a later one with each reading.
		if n := len(current.Periods); n > 0 && current.Used == 0 && current.Periods[n-1].Requests == 0 {
			r, start, from, current = 0, nowMs, nowMs, idle
		} else {
			info.ResetAt = time.UnixMilli(r)
		}
	}
	u.week[id], u.ranged[id] = current, current
	u.froms[id], u.starts[id] = max(from, current.Restart), max(start, restartedAt(current))
	// The strip: the windows that ended in the last day, then the running one as counted above.
	runFrom := nowMs
	var running *core.Period
	if n := len(current.Periods); r > 0 && n > 0 {
		running = &current.Periods[n-1]
		running.Reset, runFrom = r, running.From
	}
	// A window with nothing used shows no bar.
	var list []fiveWindow
	for _, p := range past.Periods {
		if end := windowEnd(p); end > nowMs-day && end <= min(nowMs, runFrom+core.WindowJitter) && (p.Used > 0 || p.Requests > 0) {
			list = append(list, fiveWindow{p, false})
		}
	}
	if running != nil && (running.Used > 0 || running.Requests > 0) {
		list = append(list, fiveWindow{*running, true})
	}
	u.windows[id] = list
	// With none running, the latest 5-hour reading tells that none does when it read nothing or its
	// window has ended; one that read use and named no reset (an older log's) leaves it unknown.
	known := current.Seen
	if r == 0 {
		known = last != nil && (*last.Used5h == 0 || last.Reset5 > 0 && last.Reset5 <= nowMs || last.T <= nowMs-core.FiveMs)
	}
	u.noWindow[id] = read && !has
	return usageAccount{AccountInfo: info, Used: current.Used, Known: known, BeforeLog: current.BeforeLog,
		Outside: current.Outside, NoWindow: u.noWindow[id], RestartedAt: restartedAt(current)}
}

// fiveWindow is a window of the strip, and whether it is the running one.
type fiveWindow struct {
	core.Period
	running bool
}

// windowEnd is when a window ended or will: when the next began, else its reset, and never more
// than five hours after it began.
func windowEnd(p core.Period) int64 {
	end := p.From + core.FiveMs
	switch {
	case p.Ended > 0:
		end = min(end, p.Ended)
	case p.Reset > 0:
		end = min(end, p.Reset)
	}
	return end
}

// restartedAt is when an account's current window started over before its reset (a plan change),
// counted from then; 0 when it did not.
func restartedAt(a core.Attribution) int64 {
	if a.Restart == 0 {
		return 0
	}
	return a.Periods[0].From
}

// windowDoc is a window as the report lists it: its part by project, what no request explains,
// what its requests ran, and its largest sessions.
func windowDoc(account string, w fiveWindow, refs map[string]projectRef) usageWindow {
	doc := usageWindow{Account: account, From: w.From, To: windowEnd(w.Period), Running: w.running, Used: w.Used,
		BeforeLog: w.BeforeLog, Outside: w.Outside, Projects: map[string]float64{}, Requests: w.Requests,
		Tokens: w.Tokens, Sessions: []daySession{}}
	parts := map[string]float64{}
	for id, x := range w.Parts {
		if x > 0 {
			view := core.ViewSession(id)
			parts[view] += x
			doc.Projects[refs[view].Name] += x
		}
	}
	ids := make([]string, 0, len(parts))
	for id := range parts {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool {
		if parts[ids[a]] != parts[ids[b]] {
			return parts[ids[a]] > parts[ids[b]]
		}
		return ids[a] < ids[b]
	})
	for _, id := range ids[:min(3, len(ids))] {
		x := parts[id]
		doc.Sessions = append(doc.Sessions, daySession{ID: id, Title: sessionMeta(id).Title, Used: &x})
	}
	return doc
}
