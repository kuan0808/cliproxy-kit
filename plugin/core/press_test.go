package core

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// press is the band's `switch to k•••` for s1, with what the band saw when the main step began.
func press(s *State, c *clock, id, to string, gen uint64, stepStart time.Time) Ack {
	return s.Apply(Command{CommandID: id, Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: to,
		WaitedMs: c.t.Sub(stepStart).Milliseconds(), Generation: gen, StepStartedAt: stepStart})
}

// hungRetry is s1's main step sent at its start, hung for 2m 15s on A, and its retry on A running.
func hungRetry(t *testing.T) (*State, *clock, time.Time, uint64) {
	t.Helper()
	s, c := retrySetup(t, 160_000)
	start := c.t
	gen := s.Build().Sessions["s1"].Generation
	pk(s, both...)
	c.add(135 * time.Second)
	failed(s, c, "claude-a", "", 0, `Post "http://x": EOF`, 135*time.Second, 0)
	if r := pk(s, both...); r.AuthID != "claude-a" {
		t.Fatalf("retry pick = %+v", r)
	}
	s.TakeLog()
	return s, c, start, gen
}

func TestAPressDuringARetrySwitchesTheSession(t *testing.T) {
	t.Run("the switch is the user's, with the wait and the retry it stopped", func(t *testing.T) {
		s, c, start, gen := hungRetry(t)
		c.add(40 * time.Second)
		if a := press(s, c, "p1", "claude-b", gen, start); a.Status != "applied" {
			t.Fatalf("ack = %+v", a)
		}
		v := s.Build().Sessions["s1"]
		want := Cause{Kind: FailHang, WaitMs: 135_000, Retries: 1, WaitedMs: 175_000}
		if sw := v.LastSwitch; sw == nil || sw.Kind != MoveUser || sw.From != "claude-a" || sw.To != "claude-b" || sw.Reason != switchedReason || sw.Cause == nil || *sw.Cause != want {
			t.Fatalf("switch = %+v cause %+v", v.LastSwitch, v.LastSwitch.Cause)
		}
		if v.Retry != nil || v.Generation != gen+1 || boundTo(s) != "claude-b" || len(s.hung) != 0 || len(s.episodes) != 0 {
			t.Fatalf("view = %+v", v)
		}
		if lines := eventLines(s, EventMove); len(lines) != 1 || lines[0].Move != MoveUser || lines[0].Cause == nil || lines[0].Cause.WaitedMs != 175_000 {
			t.Fatalf("move lines = %+v", lines)
		}
		// The stopped try's cancel, sent before the switch, writes that try's line and nothing more.
		c.add(time.Second)
		failed(s, c, "claude-a", "", 499, "context canceled", 41*time.Second, 0)
		log := s.TakeLog()
		var tries []LogEntry
		for _, e := range log {
			if e.Ev == EventRetry {
				tries = append(tries, e)
			}
		}
		if len(tries) != 1 || tries[0].OK || tries[0].F != FailRequest || tries[0].St != 499 || tries[0].W != 41_000 || tries[0].Answered || tries[0].Try != 1 {
			t.Fatalf("retry lines = %+v", tries)
		}
		if len(moveLines(log)) != 0 || len(s.episodes) != 0 || len(s.hung) != 0 || s.creds["claude-a"].health.resting(c.t) {
			t.Fatalf("after the cancel: episodes %d hung %d", len(s.episodes), len(s.hung))
		}
		// The session's next main request goes to B.
		if r := pk(s, both...); r.AuthID != "claude-b" {
			t.Fatalf("next pick = %+v", r)
		}
	})
	t.Run("a try that had begun answering", func(t *testing.T) {
		s, c, start, gen := hungRetry(t)
		c.add(45 * time.Second)
		press(s, c, "p1", "claude-b", gen, start)
		failed(s, c, "claude-a", "", 499, "context canceled", 45*time.Second, 35*time.Second)
		if lines := eventLines(s, EventRetry); len(lines) != 1 || !lines[0].Answered || lines[0].W != 45_000 || lines[0].OK {
			t.Fatalf("retry lines = %+v", lines)
		}
	})
	t.Run("a try that worked before the stop reached it", func(t *testing.T) {
		s, c, start, gen := hungRetry(t)
		c.add(20 * time.Second)
		press(s, c, "p1", "claude-b", gen, start)
		s.Observe(Usage{Provider: "claude", Model: opus, SessionID: "claude:s1", AuthID: "claude-a", RequestedAt: c.t.Add(-20 * time.Second), CacheRead: 160_000, Output: 5, TTFT: time.Second})
		if lines := eventLines(s, EventRetry); len(lines) != 1 || !lines[0].OK {
			t.Fatalf("retry lines = %+v", lines)
		}
		if boundTo(s) != "claude-b" || s.Build().Sessions["s1"].LastSwitch.Kind != MoveUser {
			t.Fatalf("the late success moved the session back")
		}
	})
	t.Run("a press while Claude Code waits between retries records the wait alone of the try", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		start, gen := c.t, s.Build().Sessions["s1"].Generation
		pk(s, both...)
		c.add(time.Second)
		failed(s, c, "claude-a", "", 529, "", time.Second, time.Second)
		c.add(10 * time.Second)
		press(s, c, "p1", "claude-b", gen, start)
		want := Cause{Kind: FailOverloaded, Status: 529, WaitMs: 1000, WaitedMs: 11_000}
		if sw := s.Build().Sessions["s1"].LastSwitch; sw == nil || sw.Cause == nil || *sw.Cause != want || len(s.stopped) != 0 {
			t.Fatalf("switch = %+v", sw)
		}
	})
	t.Run("a press during the first hang, before any episode", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		start, gen := c.t, s.Build().Sessions["s1"].Generation
		pk(s, both...)
		c.add(45 * time.Second)
		press(s, c, "p1", "claude-b", gen, start)
		// The cancelled request ran 45 s with no answer: a cancel, which never counts.
		failed(s, c, "claude-a", "", 499, "context canceled", 45*time.Second, 0)
		if sw := s.Build().Sessions["s1"].LastSwitch; sw == nil || *sw.Cause != (Cause{WaitedMs: 45_000}) || len(s.episodes) != 0 || len(eventLines(s, EventRetry)) != 0 {
			t.Fatalf("switch = %+v", sw)
		}
	})
}

func TestAPressIsRefusedWhenWhatTheBandSawChanged(t *testing.T) {
	t.Run("the target failed since: its listing is void", func(t *testing.T) {
		s, c, start, gen := hungRetry(t)
		failed(s, c, "claude-b", "", 529, "", time.Second, time.Second)
		if a := press(s, c, "p1", "claude-b", gen, start); a.Status != "rejected" || !strings.HasSuffix(a.Reason, " cannot take the session now") {
			t.Fatalf("ack = %+v", a)
		}
		if boundTo(s) != "claude-a" || s.Build().Sessions["s1"].LastSwitch != nil {
			t.Fatalf("moved")
		}
	})
	t.Run("the session moved meanwhile", func(t *testing.T) {
		s, c, start, gen := hungRetry(t)
		s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
		s.Apply(Command{CommandID: "w2", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-a"})
		pk(s, both...)
		if a := press(s, c, "p1", "claude-b", gen, start); a.Status != "rejected" || a.Reason != "the session moved meanwhile" {
			t.Fatalf("ack = %+v", a)
		}
	})
	t.Run("a pick of the binding answered another account since the step began", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		start, gen := c.t, s.Build().Sessions["s1"].Generation
		pk(s, both...)
		c.add(31 * time.Second)
		// A not offered: the pick answers B, where the step's request may be now.
		if r := pk(s, credB); r.AuthID != "claude-b" {
			t.Fatalf("pick = %+v", r)
		}
		if a := press(s, c, "p1", "claude-b", gen, start); a.Status != "rejected" || !strings.HasPrefix(a.Reason, "the request may already be on ") {
			t.Fatalf("ack = %+v", a)
		}
		// One answered elsewhere more than a second before the step began is no sign of it.
		c.add(time.Minute)
		if a := press(s, c, "p2", "claude-b", gen, c.t.Add(-10*time.Second)); a.Status != "applied" {
			t.Fatalf("ack = %+v", a)
		}
	})
	t.Run("a 418, not retried, then the next round answered B: the view says so, which hides the control", func(t *testing.T) {
		s, c := retrySetup(t, 160_000)
		start := c.t
		pk(s, both...)
		c.add(time.Second)
		failed(s, c, "claude-a", "", 418, "", time.Second, time.Second)
		if v := s.Build().Sessions["s1"]; v.Retry != nil {
			t.Fatalf("a 418 is retried: %+v", v.Retry)
		}
		if r := pk(s, credB); r.AuthID != "claude-b" {
			t.Fatalf("pick = %+v", r)
		}
		if v := s.Build().Sessions["s1"]; !v.ElsewhereAt.After(start) {
			t.Fatalf("elsewhere_at %v, the step began %v", v.ElsewhereAt, start)
		}
	})
	t.Run("a command without the press's fields is today's switch", func(t *testing.T) {
		s, c, _, _ := hungRetry(t)
		a := s.Apply(Command{CommandID: "w1", Session: "s1", BootID: "boot-1", CreatedAt: c.t, Action: "switch", AuthID: "claude-b"})
		if sw := s.Build().Sessions["s1"].LastSwitch; a.Status != "applied" || sw.Cause != nil || len(s.stopped) != 0 {
			t.Fatalf("ack %+v switch %+v", a, sw)
		}
	})
}

// The record is written at the switch: the next success on B keeps it, and a restart keeps it.
func TestAPressIsRecordedOnceAndSurvivesARestart(t *testing.T) {
	s, c, start, gen := hungRetry(t)
	c.add(40 * time.Second)
	press(s, c, "p1", "claude-b", gen, start)
	c.add(5 * time.Second)
	pk(s, both...)
	answered(s, c, "claude:s1", "claude-b")
	before := *s.Build().Sessions["s1"].LastSwitch
	if before.Kind != MoveUser || before.Cause.WaitedMs != 175_000 || len(moveLines(s.TakeLog())) != 1 {
		t.Fatalf("switch = %+v", before)
	}
	raw, _ := json.Marshal(s.Export())
	next := New("boot-2", c.now)
	var p Persisted
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	next.Import(p)
	after := next.Build().Sessions["s1"].LastSwitch
	if after == nil || after.Kind != before.Kind || !after.At.Equal(before.At) || *after.Cause != *before.Cause {
		t.Fatalf("after a restart = %+v", after)
	}
}
