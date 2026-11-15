package core

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// Every figure here is made up: no reading of a real account.

var poolNow = time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)

// pool is a proxy's accounts as one /pool call sees them: the ledger, the host's list, and the
// model names the host's registry holds for each credential.
type pool struct {
	s    *State
	c    *clock
	list []CredInfo
	reg  map[string][]string
}

// nine and seven are the model names two kinds of made-up plan register (fable and opus are the
// package's test models).
var (
	nine  = []string{fable, opus, "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-1", "claude-sonnet-5-1", "claude-haiku-5-1", "claude-opus-4-9", "claude-sonnet-4-9"}
	seven = []string{opus, "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-1", "claude-sonnet-5-1", "claude-haiku-5-1", "claude-opus-4-9"}
)

// newPool holds Claude accounts by the given ids, each signed in as <id>@example.com and
// registering every model of nine.
func newPool(ids ...string) *pool {
	c := &clock{t: poolNow}
	p := &pool{s: New("pool-test", c.now), c: c, reg: map[string][]string{}}
	for _, id := range ids {
		p.list = append(p.list, CredInfo{ID: id, Index: id, Provider: "claude", Email: id + "@example.com"})
		p.reg[id] = nine
	}
	p.s.UpdateInventory(p.list)
	return p
}

func (p *pool) input(floor *float64, models ...string) PoolInput {
	in := PoolInput{Version: "0.2.1", Models: models, Floor: floor, List: p.list, ListRead: true, RegistryRead: true}
	for id, names := range p.reg {
		provider := "claude"
		for _, info := range p.list {
			if info.ID == id {
				provider = info.Provider
			}
		}
		in.Registry = append(in.Registry, Registered{ID: id, Provider: provider, Models: names})
	}
	return in
}

func (p *pool) read(floor *float64, models ...string) Pool {
	return p.s.Pool(p.input(floor, models...))
}

// full is a full reading of the usage endpoint taken now; header one taken from response headers.
func (p *pool) full(id string, windows ...Window) {
	for i := range windows {
		windows[i].ObservedAt = p.c.t
	}
	p.s.MergePoll(id, "claude", windows, true)
}

func (p *pool) header(id string, windows ...Window) {
	for i := range windows {
		windows[i].ObservedAt = p.c.t
	}
	p.s.MergeWindows(id, "claude", windows)
}

// win is a window with left percent left and the reset given.
func win(kind string, left float64, reset time.Time) Window {
	return Window{Kind: kind, Remaining: left / 100, ResetAt: reset}
}

func floor(f float64) *float64 { return &f }

func ts(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func rowOf(t *testing.T, doc Pool, model, id string) PoolRow {
	t.Helper()
	for _, m := range doc.Models {
		if m.Model != model {
			continue
		}
		for _, r := range m.Rows {
			if r.Account == opaqueID(id) {
				return r
			}
		}
	}
	t.Fatalf("no row for %s on %s", id, model)
	return PoolRow{}
}

func verdictText(m PoolModel) string {
	v, why := "null", "null"
	if m.Verdict != nil {
		v = *m.Verdict
	}
	if m.UnmeasuredBecause != nil {
		why = *m.UnmeasuredBecause
	}
	return v + "/" + why
}

// sameJSON compares a document with the expected one, the ids written as {id}. The accounts are
// listed by provider and id, and the opaque ids decide that order, so the expected one is put in it.
func sameJSON(t *testing.T, doc Pool, want string, ids ...string) {
	t.Helper()
	for _, id := range ids {
		want = strings.ReplaceAll(want, "{"+id+"}", opaqueID(id))
	}
	if !sort.SliceIsSorted(doc.Accounts, func(i, j int) bool {
		a, b := doc.Accounts[i], doc.Accounts[j]
		return a.Provider < b.Provider || a.Provider == b.Provider && a.ID < b.ID
	}) {
		t.Fatalf("accounts out of order: %+v", doc.Accounts)
	}
	var expected Pool
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatalf("expected document: %v", err)
	}
	sort.Slice(expected.Accounts, func(i, j int) bool { return expected.Accounts[i].ID < expected.Accounts[j].ID })
	reordered, _ := json.Marshal(expected)
	want = string(reordered)
	got, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("expected document: %v", err)
	}
	if !reflect.DeepEqual(g, w) {
		pretty, _ := json.MarshalIndent(g, "", "  ")
		t.Fatalf("document:\n%s\nwant:\n%s", pretty, want)
	}
}

// The first document of the output contract: three accounts serve Fable, one of them is used up on
// its Fable week, one is at 9 on its all-models week, and the fourth has no Fable registered.
func TestPoolDocumentForEnough(t *testing.T) {
	p := newPool("alpha", "bravo", "charlie", "delta")
	p.reg["delta"] = seven
	for id, plan := range map[string]string{"alpha": "Max 20x", "bravo": "Max 5x", "charlie": "Max 20x", "delta": "Pro"} {
		p.s.SetPlan(id, "claude", plan)
	}
	p.c.t = ts("2026-01-10T11:58:40Z")
	p.full("alpha", win("5h", 80, ts("2026-01-10T15:00:00Z")), win("7d", 71, ts("2026-01-15T03:00:00Z")), win("7d_fable", 62.5, ts("2026-01-12T08:00:00Z")))
	p.c.t = ts("2026-01-10T11:58:41Z")
	p.full("bravo", win("5h", 55, ts("2026-01-10T14:00:00Z")), win("7d", 9, ts("2026-01-15T03:00:00Z")), win("7d_fable", 30, ts("2026-01-14T08:00:00Z")))
	p.full("charlie", win("5h", 40, ts("2026-01-10T13:30:00Z")), win("7d", 48, ts("2026-01-13T19:00:00Z")), win("7d_fable", 0, ts("2026-01-16T08:00:00Z")))
	p.c.t = ts("2026-01-10T11:58:42Z")
	p.full("delta", win("5h", 90, ts("2026-01-10T16:00:00Z")), win("7d", 85, ts("2026-01-14T10:00:00Z")))
	p.c.t = poolNow
	sameJSON(t, p.read(floor(15), fable), `{
  "schema_version": 1,
  "quota_pilot": "0.2.1",
  "generated_at": "2026-01-10T12:00:00Z",
  "stale_after_seconds": 1500,
  "floor": 15,
  "accounts": [
    {"id": "{alpha}", "label": "a•••", "provider": "claude", "plan": "Max 20x",
     "disabled": false, "same_as": null, "rest": null, "registered_models": 9,
     "read_failure": null, "credits": null, "absent": ["7d_opus", "7d_sonnet"],
     "windows": [
       {"kind": "5h", "left": 80, "reset_at": "2026-01-10T15:00:00Z", "read_at": "2026-01-10T11:58:40Z", "stale": false},
       {"kind": "7d", "left": 71, "reset_at": "2026-01-15T03:00:00Z", "read_at": "2026-01-10T11:58:40Z", "stale": false},
       {"kind": "7d_fable", "left": 62.5, "reset_at": "2026-01-12T08:00:00Z", "read_at": "2026-01-10T11:58:40Z", "stale": false}]},
    {"id": "{bravo}", "label": "b•••", "provider": "claude", "plan": "Max 5x",
     "disabled": false, "same_as": null, "rest": null, "registered_models": 9,
     "read_failure": null, "credits": null, "absent": ["7d_opus", "7d_sonnet"],
     "windows": [
       {"kind": "5h", "left": 55, "reset_at": "2026-01-10T14:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d", "left": 9, "reset_at": "2026-01-15T03:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d_fable", "left": 30, "reset_at": "2026-01-14T08:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false}]},
    {"id": "{charlie}", "label": "c•••", "provider": "claude", "plan": "Max 20x",
     "disabled": false, "same_as": null, "rest": null, "registered_models": 9,
     "read_failure": null, "credits": null, "absent": ["7d_opus", "7d_sonnet"],
     "windows": [
       {"kind": "5h", "left": 40, "reset_at": "2026-01-10T13:30:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d", "left": 48, "reset_at": "2026-01-13T19:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d_fable", "left": 0, "reset_at": "2026-01-16T08:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false}]},
    {"id": "{delta}", "label": "d•••", "provider": "claude", "plan": "Pro",
     "disabled": false, "same_as": null, "rest": null, "registered_models": 7,
     "read_failure": null, "credits": null, "absent": ["7d_fable", "7d_opus", "7d_sonnet"],
     "windows": [
       {"kind": "5h", "left": 90, "reset_at": "2026-01-10T16:00:00Z", "read_at": "2026-01-10T11:58:42Z", "stale": false},
       {"kind": "7d", "left": 85, "reset_at": "2026-01-14T10:00:00Z", "read_at": "2026-01-10T11:58:42Z", "stale": false}]}
  ],
  "models": [
    {
      "model": "claude-fable-5-2",
      "providers": ["claude"],
      "verdict": "enough",
      "unmeasured_because": null,
      "accounts": 3,
      "read": 3,
      "at_or_above_floor": 1,
      "best_weekly_left": 62.5,
      "rows": [
        {"account": "{alpha}", "counts": true, "why_not": null, "counted_under": null,
         "weekly_left": 62.5, "weekly_window": "7d_fable", "weekly_reset_at": "2026-01-12T08:00:00Z", "weekly_read": true,
         "tier": 1, "blocked": false, "resting": false, "back_at": null, "reason": "Weekly Fable quota resets soonest"},
        {"account": "{bravo}", "counts": true, "why_not": null, "counted_under": null,
         "weekly_left": 9, "weekly_window": "7d", "weekly_reset_at": "2026-01-15T03:00:00Z", "weekly_read": true,
         "tier": 1, "blocked": false, "resting": false, "back_at": null, "reason": "Weekly Fable quota resets soonest"},
        {"account": "{charlie}", "counts": true, "why_not": null, "counted_under": null,
         "weekly_left": 0, "weekly_window": "7d_fable", "weekly_reset_at": "2026-01-16T08:00:00Z", "weekly_read": true,
         "tier": 3, "blocked": true, "resting": false, "back_at": "2026-01-16T08:00:00Z", "reason": "Weekly Fable quota used up"},
        {"account": "{delta}", "counts": false, "why_not": "not_registered", "counted_under": null,
         "weekly_left": null, "weekly_window": null, "weekly_reset_at": null, "weekly_read": false,
         "tier": null, "blocked": null, "resting": null, "back_at": null, "reason": null}
      ]
    }
  ],
  "errors": []
}`, "alpha", "bravo", "charlie", "delta")

	// Asked for Opus, which no account has a week of its own for, each is judged on its all-models
	// week: charlie, used up on Fable, counts for Opus at its 48.
	doc := p.read(floor(15), opus)
	for id, want := range map[string]float64{"alpha": 71, "bravo": 9, "charlie": 48, "delta": 85} {
		if r := rowOf(t, doc, opus, id); !r.WeeklyRead || *r.WeeklyLeft != want || *r.WeeklyWindow != "7d" {
			t.Fatalf("%s on Opus = %+v, want %v on 7d", id, r, want)
		}
	}
	if got := verdictText(doc.Models[0]); got != "enough/null" || doc.Models[0].Accounts != 4 {
		t.Fatalf("Opus verdict = %s over %d accounts", got, doc.Models[0].Accounts)
	}
}

// The second document: the only read account is under the floor and the other cannot be read.
func TestPoolDocumentForUnread(t *testing.T) {
	p := newPool("bravo", "echo")
	p.s.SetPlan("bravo", "claude", "Max 5x")
	p.c.t = ts("2026-01-09T20:11:02Z")
	p.header("echo", win("7d", 64, ts("2026-01-13T19:00:00Z")))
	p.c.t = ts("2026-01-10T11:58:41Z")
	p.full("bravo", win("5h", 55, ts("2026-01-10T14:00:00Z")), win("7d", 9, ts("2026-01-15T03:00:00Z")), win("7d_fable", 30, ts("2026-01-14T08:00:00Z")))
	p.s.NoteRead("echo", "login")
	p.c.t = poolNow
	sameJSON(t, p.read(floor(15), fable), `{
  "schema_version": 1,
  "quota_pilot": "0.2.1",
  "generated_at": "2026-01-10T12:00:00Z",
  "stale_after_seconds": 1500,
  "floor": 15,
  "accounts": [
    {"id": "{bravo}", "label": "b•••", "provider": "claude", "plan": "Max 5x",
     "disabled": false, "same_as": null, "rest": null, "registered_models": 9,
     "read_failure": null, "credits": null, "absent": ["7d_opus", "7d_sonnet"],
     "windows": [
       {"kind": "5h", "left": 55, "reset_at": "2026-01-10T14:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d", "left": 9, "reset_at": "2026-01-15T03:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false},
       {"kind": "7d_fable", "left": 30, "reset_at": "2026-01-14T08:00:00Z", "read_at": "2026-01-10T11:58:41Z", "stale": false}]},
    {"id": "{echo}", "label": "e•••", "provider": "claude", "plan": null,
     "disabled": false, "same_as": null, "rest": null, "registered_models": 9,
     "read_failure": "login", "credits": null, "absent": [],
     "windows": [
       {"kind": "7d", "left": 64, "reset_at": "2026-01-13T19:00:00Z", "read_at": "2026-01-09T20:11:02Z", "stale": true}]}
  ],
  "models": [
    {
      "model": "claude-fable-5-2",
      "providers": ["claude"],
      "verdict": "unmeasured",
      "unmeasured_because": "unread",
      "accounts": 2,
      "read": 1,
      "at_or_above_floor": 0,
      "best_weekly_left": 9,
      "rows": [
        {"account": "{bravo}", "counts": true, "why_not": null, "counted_under": null,
         "weekly_left": 9, "weekly_window": "7d", "weekly_reset_at": "2026-01-15T03:00:00Z", "weekly_read": true,
         "tier": 1, "blocked": false, "resting": false, "back_at": null, "reason": "Weekly Fable quota resets soonest"},
        {"account": "{echo}", "counts": true, "why_not": null, "counted_under": null,
         "weekly_left": null, "weekly_window": null, "weekly_reset_at": null, "weekly_read": false,
         "tier": 2, "blocked": false, "resting": false, "back_at": null, "reason": "quota unknown"}
      ]
    }
  ],
  "errors": []
}`, "bravo", "echo")
}

// short needs every counting account read and under the floor; one at the floor exactly passes.
func TestPoolShortOnlyWhenEveryCountingAccountIsReadBelowTheFloor(t *testing.T) {
	p := newPool("a", "b")
	reset := poolNow.Add(72 * time.Hour)
	p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 9, reset))
	p.full("b", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 14.99, reset))
	m := p.read(floor(15), opus).Models[0]
	if verdictText(m) != "short/null" || m.Accounts != 2 || m.Read != 2 || *m.AtOrAboveFloor != 0 || *m.BestWeeklyLeft != 14.99 {
		t.Fatalf("short pool = %s %+v", verdictText(m), m)
	}
	// The next week, read at 15: within a window the highest use stands, so a new one is read.
	p.full("b", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 15, reset.Add(7*24*time.Hour)))
	if m := p.read(floor(15), opus).Models[0]; verdictText(m) != "enough/null" || *m.AtOrAboveFloor != 1 {
		t.Fatalf("an account at the floor = %s", verdictText(m))
	}
	// Without a floor the figures stay and nothing is judged.
	m = p.read(nil, opus).Models[0]
	if m.Verdict != nil || m.UnmeasuredBecause != nil || m.AtOrAboveFloor != nil || m.Accounts != 2 || m.Read != 2 || *m.BestWeeklyLeft != 15 {
		t.Fatalf("no floor = %s %+v", verdictText(m), m)
	}
	if doc := p.read(floor(15)); len(doc.Models) != 0 || doc.Models == nil {
		t.Fatalf("no model asked: models = %#v", doc.Models)
	}
}

// The verdict is the first line of the table that applies.
func TestPoolVerdictLines(t *testing.T) {
	low := func() *pool {
		p := newPool("a", "b")
		for _, id := range []string{"a", "b"} {
			p.full(id, win("5h", 90, poolNow.Add(time.Hour)), win("7d", 5, poolNow.Add(72*time.Hour)))
		}
		return p
	}
	for name, tc := range map[string]struct {
		in   func(p *pool) PoolInput
		want string
		errs string
	}{
		"1 the account list could not be read, over a low pool": {func(p *pool) PoolInput {
			in := p.input(floor(15), opus)
			in.List, in.ListRead = nil, false
			return in
		}, "unmeasured/inventory", "inventory"},
		"1 the account list was empty": {func(p *pool) PoolInput {
			in := p.input(floor(15), opus)
			in.List = nil
			return in
		}, "unmeasured/inventory", "inventory"},
		"2 the registry did not answer": {func(p *pool) PoolInput {
			in := p.input(floor(15), opus)
			in.Registry, in.RegistryRead = nil, false
			return in
		}, "unmeasured/registry", "registry"},
		"2 the registry answered with nothing": {func(p *pool) PoolInput {
			in := p.input(floor(15), opus)
			in.Registry = nil
			return in
		}, "unmeasured/registry", "registry"},
		"2 an account of the list is missing from the registry": {func(p *pool) PoolInput {
			in := p.input(floor(15), opus)
			in.Registry = in.Registry[:1]
			return in
		}, "unmeasured/registry", "registry"},
		"2 an enabled account has no model registered": {func(p *pool) PoolInput {
			p.reg["b"] = []string{}
			return p.input(floor(15), opus)
		}, "unmeasured/registry", "registry"},
		"3 no account has the name registered": {func(p *pool) PoolInput {
			return p.input(floor(15), "team/claude-opus-5-5")
		}, "unmeasured/name_not_registered", ""},
		"4 only a provider quota-pilot does not read has it": {func(p *pool) PoolInput {
			p.list = append(p.list, CredInfo{ID: "g", Index: "g", Provider: "gemini"})
			p.reg["g"] = []string{"gemini-9-pro"}
			return p.input(floor(15), "gemini-9-pro")
		}, "not_pooled/null", ""},
		"6 every counting account read and below": {func(p *pool) PoolInput {
			return p.input(floor(15), opus)
		}, "short/null", ""},
		"7 no account counts": {func(p *pool) PoolInput {
			p.list[0].Disabled, p.list[1].Disabled = true, true
			p.s.UpdateInventory(p.list)
			return p.input(floor(15), opus)
		}, "unmeasured/unread", ""},
	} {
		t.Run(name, func(t *testing.T) {
			p := low()
			doc := p.s.Pool(tc.in(p))
			if got := verdictText(doc.Models[0]); got != tc.want {
				t.Fatalf("verdict = %s, want %s", got, tc.want)
			}
			if got := strings.Join(doc.Errors, ","); got != tc.errs {
				t.Fatalf("errors = %q, want %q", got, tc.errs)
			}
			if len(doc.Accounts) < 2 {
				t.Fatalf("the accounts the ledger knows are not listed: %+v", doc.Accounts)
			}
		})
	}
	// 5 and 7 with the same pool: one read account at or above the floor is enough, whatever the
	// others; with none at or above it, an unread one leaves it unmeasured.
	p := low()
	p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 40, poolNow.Add(72*time.Hour)))
	p.c.add(30 * time.Minute)
	p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 40, poolNow.Add(72*time.Hour)))
	if m := p.read(floor(15), opus).Models[0]; verdictText(m) != "enough/null" || m.Read != 1 || m.Accounts != 2 {
		t.Fatalf("5: %s, read %d of %d", verdictText(m), m.Read, m.Accounts)
	}
	p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 10, poolNow.Add(72*time.Hour)))
	if m := p.read(floor(15), opus).Models[0]; verdictText(m) != "unmeasured/unread" || m.Read != 1 {
		t.Fatalf("7: %s, read %d", verdictText(m), m.Read)
	}
}

// A credential the host holds and quota-pilot does not read (one with no file, or another
// provider's) counts when it has the model and is never read, so it can keep a pool from short;
// the registry holding one the list leaves out is no contradiction.
func TestPoolCredentialsQuotaPilotDoesNotReadCountUnread(t *testing.T) {
	p := newPool("a")
	p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 5, poolNow.Add(72*time.Hour)))
	p.reg["config-key"] = []string{opus}
	p.list = append(p.list, CredInfo{ID: "g", Index: "g", Provider: "gemini"})
	p.reg["g"] = []string{"gemini-9-pro", opus}
	doc := p.read(floor(15), opus)
	m := doc.Models[0]
	if verdictText(m) != "unmeasured/unread" || m.Accounts != 3 || m.Read != 1 || !reflect.DeepEqual(m.Providers, []string{"claude", "gemini"}) {
		t.Fatalf("pool with unread credentials = %s %+v", verdictText(m), m)
	}
	for _, id := range []string{"config-key", "g"} {
		if r := rowOf(t, doc, opus, id); !r.Counts || r.WeeklyRead || r.Tier != nil || r.Reason != nil {
			t.Fatalf("%s row = %+v", id, r)
		}
	}
	two, one := 2, 1
	for _, a := range doc.Accounts {
		var want PoolAccount
		switch a.ID {
		case opaqueID("config-key"):
			want = PoolAccount{ID: a.ID, Provider: "claude", RegisteredModels: &one}
		case opaqueID("g"):
			f := false
			want = PoolAccount{ID: a.ID, Provider: "gemini", RegisteredModels: &two, Disabled: &f}
		default:
			continue
		}
		if !reflect.DeepEqual(a, want) {
			t.Fatalf("account %+v, want %+v", a, want)
		}
	}
	if len(doc.Errors) != 0 {
		t.Fatalf("errors = %v", doc.Errors)
	}
}

// The weekly figure follows what the readings hold, through the mapping the pick uses.
func TestPoolWeeklyFigure(t *testing.T) {
	week := poolNow.Add(5 * 24 * time.Hour)
	later := poolNow.Add(6 * 24 * time.Hour)
	type want struct {
		read   bool
		left   float64
		window string
	}
	check := func(t *testing.T, doc Pool, model, id string, w want) {
		t.Helper()
		r := rowOf(t, doc, model, id)
		if r.WeeklyRead != w.read || w.read && (*r.WeeklyLeft != w.left || *r.WeeklyWindow != w.window) || !w.read && (r.WeeklyLeft != nil || r.WeeklyWindow != nil || r.WeeklyResetAt != nil) {
			t.Fatalf("%s on %s = %+v, want %+v", id, model, r, w)
		}
	}
	t.Run("an account with header readings only", func(t *testing.T) {
		p := newPool("h", "x")
		p.header("h", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 60, week))
		p.full("x", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 70, week))
		// No account has an Opus week, nor a Fable week: both are read on 7d alone.
		check(t, p.read(nil, opus), opus, "h", want{true, 60, "7d"})
		check(t, p.read(nil, fable), fable, "h", want{true, 60, "7d"})
		// Once another account holds a Fable week, one that has not said whether it has one is not
		// read for Fable, and still is for Opus.
		p.full("x", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 70, week), win("7d_fable", 80, week))
		check(t, p.read(nil, fable), fable, "h", want{read: false})
		check(t, p.read(nil, opus), opus, "h", want{true, 60, "7d"})
		// A fresh zero is read before that.
		p.header("h", win("7d", 0, week))
		check(t, p.read(nil, fable), fable, "h", want{true, 0, "7d"})
	})
	t.Run("a full reading says whether the account has the week", func(t *testing.T) {
		p := newPool("held", "lacks")
		p.full("held", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 70, week), win("7d_fable", 40, later))
		p.full("lacks", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 30, week))
		doc := p.read(nil, fable)
		check(t, doc, fable, "held", want{true, 40, "7d_fable"})
		check(t, doc, fable, "lacks", want{true, 30, "7d"})
	})
	t.Run("a fresh zero first", func(t *testing.T) {
		p := newPool("z", "noweek")
		p.full("z", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 50, week), win("7d_fable", 80, week))
		p.c.add(30 * time.Minute)
		p.header("z", win("7d_fable", 0, week))
		// The 7d reading is stale now; the Fable week, read at zero, is fresh.
		check(t, p.read(nil, fable), fable, "z", want{true, 0, "7d_fable"})
		check(t, p.read(nil, opus), opus, "z", want{read: false})
		// With no 7d reading at all, a fresh zero is still read.
		p.full("noweek", win("5h", 90, poolNow.Add(time.Hour)), win("7d_fable", 0, week))
		check(t, p.read(nil, fable), fable, "noweek", want{true, 0, "7d_fable"})
		p.full("noweek", win("5h", 90, poolNow.Add(time.Hour)), win("7d_fable", 20, later))
		check(t, p.read(nil, fable), fable, "noweek", want{read: false})
	})
	t.Run("stale or past its reset", func(t *testing.T) {
		p := newPool("a")
		p.full("a", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 50, poolNow.Add(10*time.Minute)))
		check(t, p.read(nil, opus), opus, "a", want{true, 50, "7d"})
		if p.s.ResetPassed("a") {
			t.Fatal("a reset still ahead counted as passed")
		}
		p.c.add(11 * time.Minute)
		check(t, p.read(nil, opus), opus, "a", want{read: false})
		if !p.s.ResetPassed("a") {
			t.Fatal("a weekly reset that passed since the reading is not seen")
		}
		p.full("a", win("5h", 90, p.c.t.Add(time.Hour)), win("7d", 99, p.c.t.Add(7*24*time.Hour)))
		p.c.add(26 * time.Minute)
		check(t, p.read(nil, opus), opus, "a", want{read: false})
	})
	t.Run("the tie rule", func(t *testing.T) {
		for name, tc := range map[string]struct {
			weekly, own Window
			window      string
		}{
			"the later known reset":      {win("7d", 50, later), win("7d_fable", 50, week), "7d"},
			"a known reset":              {win("7d", 50, time.Time{}), win("7d_fable", 50, week), "7d_fable"},
			"then the model's own week":  {win("7d", 50, week), win("7d_fable", 50, week), "7d_fable"},
			"its own week resets later":  {win("7d", 50, week), win("7d_fable", 50, later), "7d_fable"},
			"at zero, the later reset":   {win("7d", 0, later), win("7d_fable", 0, week), "7d"},
			"the least left, not a tie":  {win("7d", 49.99, week), win("7d_fable", 50, later), "7d"},
			"rounded to what is printed": {win("7d", 50.001, later), win("7d_fable", 50.004, week), "7d"},
		} {
			t.Run(name, func(t *testing.T) {
				p := newPool("a")
				p.full("a", win("5h", 90, poolNow.Add(time.Hour)), tc.weekly, tc.own)
				r := rowOf(t, p.read(nil, fable), fable, "a")
				if !r.WeeklyRead || *r.WeeklyWindow != tc.window {
					t.Fatalf("row = %+v, want %s", r, tc.window)
				}
			})
		}
	})
}

func TestPoolPendingMemberReadingsStayUnread(t *testing.T) {
	for _, window := range []struct{ kind, model string }{
		{"7d", opus}, {"7d_opus", opus}, {"7d_sonnet", "claude-sonnet-5-5"}, {"7d_fable", fable},
	} {
		for _, members := range []struct {
			name, pending string
			ids           []string
		}{
			{"singleton", "a", []string{"a"}},
			{"first member", "a", []string{"a", "b"}},
			{"last member", "b", []string{"a", "b"}},
		} {
			for _, source := range []string{"full", "headers"} {
				t.Run(window.kind+"/"+members.name+"/"+source, func(t *testing.T) {
					p := newPool(members.ids...)
					reset := poolNow.Add(7 * 24 * time.Hour)
					windows := []Window{win("5h", 90, poolNow.Add(time.Hour)), win("7d", 90, reset)}
					if window.kind == "7d" {
						windows[1] = win("7d", 0, reset)
					} else {
						windows = append(windows, win(window.kind, 0, reset))
					}
					for _, id := range members.ids {
						if len(members.ids) > 1 {
							p.s.SetIdentity(id, "claude:same/org")
						}
						p.full(id, windows...)
						p.c.add(time.Minute)
					}
					if m := p.read(floor(15), window.model).Models[0]; verdictText(m) != "short/null" || m.Accounts != 1 || m.Read != 1 {
						t.Fatalf("initial zero = %s %+v", verdictText(m), m)
					}
					windows[len(windows)-1] = win(window.kind, 80, reset)
					read := p.full
					if source == "headers" {
						read = p.header
					}
					read(members.pending, windows...)
					m := p.read(floor(15), window.model).Models[0]
					if verdictText(m) != "unmeasured/unread" || m.Accounts != 1 || m.Read != 0 || m.BestWeeklyLeft != nil || m.Rows[0].WeeklyLeft != nil || m.Rows[0].WeeklyWindow != nil || m.Rows[0].WeeklyResetAt != nil {
						t.Fatalf("pending member = %s %+v", verdictText(m), m)
					}
					p.c.add(6 * time.Minute)
					if m = p.read(floor(15), window.model).Models[0]; verdictText(m) != "enough/null" || m.Read != 1 || m.BestWeeklyLeft == nil || *m.BestWeeklyLeft != 80 {
						t.Fatalf("settled member = %s %+v", verdictText(m), m)
					}
				})
			}
		}
	}
}

func TestPoolPendingUnboundWindowsDoNotHideWeeklyQuota(t *testing.T) {
	for _, kind := range []string{"5h", "7d_fable"} {
		t.Run(kind, func(t *testing.T) {
			p := newPool("a")
			reset := poolNow.Add(7 * 24 * time.Hour)
			p.full("a", win("5h", 0, reset), win("7d", 80, reset), win("7d_fable", 0, reset))
			p.c.add(time.Minute)
			p.header("a", win(kind, 80, reset))
			m := p.read(floor(15), opus).Models[0]
			if verdictText(m) != "enough/null" || m.Read != 1 || m.BestWeeklyLeft == nil || *m.BestWeeklyLeft != 80 {
				t.Fatalf("unbound pending window = %s %+v", verdictText(m), m)
			}
		})
	}
}

// Sign-ins to one provider account count once, their windows reconciled by the window rules.
func TestPoolGroups(t *testing.T) {
	r1, r2 := poolNow.Add(24*time.Hour), poolNow.Add(7*24*time.Hour)
	// two signs in g1 then g2 to one account, and reads their all-models weeks two minutes apart.
	two := func(first, second Window) *pool {
		p := newPool("g1", "g2")
		p.s.SetIdentity("g1", "claude:same/org")
		p.s.SetIdentity("g2", "claude:same/org")
		p.full("g1", win("5h", 90, poolNow.Add(time.Hour)), first)
		p.c.add(2 * time.Minute)
		p.full("g2", win("5h", 90, poolNow.Add(time.Hour)), second)
		p.c.add(time.Minute)
		return p
	}
	group := func(t *testing.T, p *pool, model string) (PoolRow, PoolModel) {
		t.Helper()
		doc := p.read(floor(15), model)
		if r := rowOf(t, doc, model, "g1"); r.Counts || *r.WhyNot != "same_account" || *r.CountedUnder != opaqueID("g2") {
			t.Fatalf("the member read first = %+v", r)
		}
		return rowOf(t, doc, model, "g2"), doc.Models[0]
	}
	for name, tc := range map[string]struct {
		first, second Window
		read          bool
		left          float64
		verdict       string
	}{
		"an old zero, then a later reset":     {win("7d", 0, r1), win("7d", 80, r2), true, 80, "enough/null"},
		"a fall still waiting":                {win("7d", 0, r1), win("7d", 80, r1), false, 0, "unmeasured/unread"},
		"two readings of one window":          {win("7d", 50, r1), win("7d", 53, r1), true, 50, "enough/null"},
		"more used later":                     {win("7d", 60, r1), win("7d", 40, r1), true, 40, "enough/null"},
		"a late reading of the window before": {win("7d", 80, r2), win("7d", 0, r1), true, 80, "enough/null"},
	} {
		t.Run(name, func(t *testing.T) {
			r, m := group(t, two(tc.first, tc.second), opus)
			if !r.Counts || r.WeeklyRead != tc.read || tc.read && *r.WeeklyLeft != tc.left || verdictText(m) != tc.verdict || m.Accounts != 1 {
				t.Fatalf("group row = %+v, verdict %s over %d", r, verdictText(m), m.Accounts)
			}
		})
	}
	t.Run("a fall that settled", func(t *testing.T) {
		p := two(win("7d", 0, r1), win("7d", 80, r1))
		p.c.add(5 * time.Minute)
		if r, m := group(t, p, opus); !r.WeeklyRead || *r.WeeklyLeft != 80 || verdictText(m) != "enough/null" {
			t.Fatalf("settled = %+v, %s", r, verdictText(m))
		}
	})
	t.Run("a plan change", func(t *testing.T) {
		p := newPool("g1", "g2")
		p.s.SetIdentity("g1", "claude:same/org")
		p.s.SetIdentity("g2", "claude:same/org")
		p.s.SetPlan("g2", "claude", "Max 5x")
		p.full("g1", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 60, r1))
		p.c.add(time.Minute)
		p.s.SetPlan("g2", "claude", "Max 20x")
		p.c.add(time.Minute)
		p.full("g2", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 63, r1))
		p.c.add(time.Minute)
		if r, _ := group(t, p, opus); r.WeeklyRead {
			t.Fatalf("a fall after a plan change read before it settled: %+v", r)
		}
		p.c.add(5 * time.Minute)
		if r, _ := group(t, p, opus); !r.WeeklyRead || *r.WeeklyLeft != 63 {
			t.Fatalf("after the plan change = %+v", r)
		}
	})
	t.Run("a scope conflict", func(t *testing.T) {
		p := two(win("7d", 50, r2), win("7d", 50, r2))
		p.c.t = poolNow
		p.full("g1", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 50, r2), win("7d_fable", 40, r2))
		p.c.add(2 * time.Minute)
		p.full("g2", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 50, r2))
		if r, _ := group(t, p, fable); r.WeeklyRead {
			t.Fatalf("members disagreeing on the Fable week read: %+v", r)
		}
		if r, _ := group(t, p, opus); !r.WeeklyRead || *r.WeeklyLeft != 50 {
			t.Fatalf("Opus, which no member has a week of, = %+v", r)
		}
	})
	t.Run("a stale representative of the ledger beside a fresh sibling", func(t *testing.T) {
		p := newPool("g1", "g2")
		p.s.SetIdentity("g2", "claude:same/org")
		p.full("g1", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 70, r1))
		p.c.add(58 * time.Minute)
		p.full("g2", win("5h", 90, p.c.t.Add(time.Hour)), win("7d", 60, r1))
		p.s.SetIdentity("g1", "claude:same/org") // the ledger counts the account under g1
		if same := p.s.Canonical(); same["g2"] != "g1" {
			t.Fatalf("ledger representative = %v", same)
		}
		r, m := group(t, p, opus)
		if !r.Counts || !r.WeeklyRead || *r.WeeklyLeft != 60 || verdictText(m) != "enough/null" {
			t.Fatalf("group row = %+v, %s", r, verdictText(m))
		}
	})
	t.Run("the representative of the ledger lacks the model", func(t *testing.T) {
		p := newPool("g1", "g2")
		p.reg["g1"] = seven
		p.s.SetIdentity("g2", "claude:same/org")
		p.s.SetIdentity("g1", "claude:same/org")
		p.full("g1", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 70, r1))
		p.full("g2", win("5h", 90, poolNow.Add(time.Hour)), win("7d", 20, r1))
		doc := p.read(floor(15), fable)
		if r := rowOf(t, doc, fable, "g1"); r.Counts || *r.WhyNot != "not_registered" {
			t.Fatalf("g1 = %+v", r)
		}
		if r := rowOf(t, doc, fable, "g2"); !r.Counts || r.CountedUnder != nil || *r.WeeklyLeft != 20 {
			t.Fatalf("g2 = %+v", r)
		}
	})
}

// A row that does not count says why, and carries null in its weekly and ranking fields.
func TestPoolWhyNot(t *testing.T) {
	p := newPool("on", "off", "lacks", "twin")
	p.list[1].Disabled = true
	p.s.UpdateInventory(p.list)
	p.reg["lacks"] = seven
	p.s.SetIdentity("on", "claude:one/org")
	p.s.SetIdentity("twin", "claude:one/org")
	for _, id := range []string{"twin", "off", "lacks", "on"} {
		p.full(id, win("5h", 90, poolNow.Add(time.Hour)), win("7d", 50, poolNow.Add(72*time.Hour)))
		p.c.add(time.Second) // on, read last, is the one the account counts under
	}
	doc := p.read(floor(15), fable)
	for id, why := range map[string]string{"off": "disabled", "lacks": "not_registered", "twin": "same_account"} {
		r := rowOf(t, doc, fable, id)
		if r.Counts || *r.WhyNot != why || r.WeeklyRead || r.WeeklyLeft != nil || r.Tier != nil || r.Blocked != nil || r.Resting != nil || r.Reason != nil {
			t.Fatalf("%s = %+v, want %s", id, r, why)
		}
		if (r.CountedUnder != nil) != (why == "same_account") {
			t.Fatalf("%s counted under %v", id, r.CountedUnder)
		}
	}
	if m := doc.Models[0]; m.Accounts != 1 || m.Rows[0].Account != opaqueID("on") {
		t.Fatalf("counting rows = %d, first %s", m.Accounts, m.Rows[0].Account)
	}
}
