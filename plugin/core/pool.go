package core

import (
	"math"
	"slices"
	"sort"
	"strings"
	"time"
)

// PoolSchemaVersion is the version of the /pool document. A field added does not raise it.
const PoolSchemaVersion = 1

// PoolInput is what one /pool call read from the host beside the ledger: its account list
// (ListRead false when the read failed) and the model names the host's registry holds for each
// credential (RegistryRead false when host.auth.models did not answer).
type PoolInput struct {
	Version      string
	Models       []string
	Floor        *float64
	List         []CredInfo
	ListRead     bool
	Registry     []Registered
	RegistryRead bool
}

// Registered is one credential of host.auth.models' answer.
type Registered struct {
	ID, Provider string
	Models       []string
}

// Pool is the pooled quota an agent decides dispatch on: every account the proxy holds and, per
// model asked, which of them serve it, how much of its weekly quota each has left, and a verdict
// against the caller's floor. Every key is always there; null is a value not known or not applying.
type Pool struct {
	SchemaVersion     int           `json:"schema_version"`
	QuotaPilot        string        `json:"quota_pilot"`
	GeneratedAt       time.Time     `json:"generated_at"`
	StaleAfterSeconds int           `json:"stale_after_seconds"`
	Floor             *float64      `json:"floor"`
	Accounts          []PoolAccount `json:"accounts"`
	Models            []PoolModel   `json:"models"`
	Errors            []string      `json:"errors"`
}

// PoolAccount is one credential the host holds. One quota-pilot does not read (another
// provider's, or one with no file) has its id, provider, registered_models and, when the host's
// list names it, disabled; the rest is null.
type PoolAccount struct {
	ID               string       `json:"id"`
	Label            *string      `json:"label"`
	Provider         string       `json:"provider"`
	Plan             *string      `json:"plan"`
	Disabled         *bool        `json:"disabled"`
	SameAs           *string      `json:"same_as"`
	Rest             *RestView    `json:"rest"`
	RegisteredModels *int         `json:"registered_models"`
	ReadFailure      *string      `json:"read_failure"`
	Credits          *PoolCredits `json:"credits"`
	Absent           []string     `json:"absent"`
	Windows          []PoolWindow `json:"windows"`
}

// PoolWindow is one quota window of an account as last read.
type PoolWindow struct {
	Kind    string     `json:"kind"`
	Left    float64    `json:"left"`
	ResetAt *time.Time `json:"reset_at"`
	ReadAt  time.Time  `json:"read_at"`
	Stale   bool       `json:"stale"`
}

// PoolCredits is a Codex account's credits: State is what a rule branches on, Balance the
// provider's figure as read.
type PoolCredits struct {
	State   string     `json:"state"`
	Balance *float64   `json:"balance"`
	ReadAt  *time.Time `json:"read_at"`
	Stale   *bool      `json:"stale"`
}

// PoolModel is one model asked for: its accounts and the verdict.
type PoolModel struct {
	Model             string    `json:"model"`
	Providers         []string  `json:"providers"`
	Verdict           *string   `json:"verdict"`
	UnmeasuredBecause *string   `json:"unmeasured_because"`
	Accounts          int       `json:"accounts"`
	Read              int       `json:"read"`
	AtOrAboveFloor    *int      `json:"at_or_above_floor"`
	BestWeeklyLeft    *float64  `json:"best_weekly_left"`
	Rows              []PoolRow `json:"rows"`
}

// PoolRow is one account for one model. The verdict reads Counts, WeeklyLeft and WeeklyRead; the
// ranking fields are the pick's estimate and enter no figure.
type PoolRow struct {
	Account       string     `json:"account"`
	Counts        bool       `json:"counts"`
	WhyNot        *string    `json:"why_not"`
	CountedUnder  *string    `json:"counted_under"`
	WeeklyLeft    *float64   `json:"weekly_left"`
	WeeklyWindow  *string    `json:"weekly_window"`
	WeeklyResetAt *time.Time `json:"weekly_reset_at"`
	WeeklyRead    bool       `json:"weekly_read"`
	Tier          *int       `json:"tier"`
	Blocked       *bool      `json:"blocked"`
	Resting       *bool      `json:"resting"`
	BackAt        *time.Time `json:"back_at"`
	Reason        *string    `json:"reason"`
}

// poolMember is an account of the pool: a ledger account (cred set), or one the host holds that
// quota-pilot does not read.
type poolMember struct {
	id, provider string
	cred         *Cred
	disabled     *bool
	models       []string
	registered   bool // in the registry answer
}

// ResetPassed tells whether an account holds a weekly window whose reset has passed since it was
// read: that window shows full and is not fresh until it is read again.
func (s *State) ResetPassed(authID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.creds[authID]
	if c == nil {
		return false
	}
	now := s.now()
	for kind, w := range c.Windows {
		if kind != KindFiveHour && !w.ResetAt.IsZero() && !now.Before(w.ResetAt) {
			return true
		}
	}
	return false
}

// Pool builds the pool document from the ledger and what this call read from the host.
func (s *State) Pool(in PoolInput) Pool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	doc := Pool{SchemaVersion: PoolSchemaVersion, QuotaPilot: in.Version, GeneratedAt: now.UTC(),
		StaleAfterSeconds: int(s.cfg.staleAfter().Seconds()), Floor: in.Floor,
		Accounts: []PoolAccount{}, Models: []PoolModel{}, Errors: []string{}}

	// The members: the ledger's accounts, then what the host's list and registry hold beside them.
	registry := map[string]Registered{}
	for _, r := range in.Registry {
		registry[r.ID] = r
	}
	members := map[string]*poolMember{}
	for id, c := range s.creds {
		if Supported(c.Provider) {
			disabled := c.Disabled
			members[id] = &poolMember{id: id, provider: c.Provider, cred: c, disabled: &disabled}
		}
	}
	for _, info := range in.List {
		if members[info.ID] == nil && info.ID != "" {
			disabled := info.Disabled
			members[info.ID] = &poolMember{id: info.ID, provider: strings.ToLower(info.Provider), disabled: &disabled}
		}
	}
	for _, r := range in.Registry {
		if members[r.ID] == nil && r.ID != "" {
			members[r.ID] = &poolMember{id: r.ID, provider: strings.ToLower(r.Provider)}
		}
	}
	for id, m := range members {
		if r, ok := registry[id]; ok && in.RegistryRead {
			m.models, m.registered = r.Models, true
		}
	}

	// The membership test: only a complete picture gives a measured verdict.
	inventory := in.ListRead && len(in.List) > 0
	complete := in.RegistryRead
	for _, info := range in.List {
		r, ok := registry[info.ID]
		if !ok || !info.Disabled && len(r.Models) == 0 {
			complete = false
		}
	}
	if !inventory {
		doc.Errors = append(doc.Errors, "inventory")
	}
	if !complete {
		doc.Errors = append(doc.Errors, "registry")
	}

	labels, same := s.labelsLocked(), s.canonicalLocked()
	for _, m := range members {
		doc.Accounts = append(doc.Accounts, s.poolAccountLocked(m, labels, same, in.RegistryRead, now))
	}
	sort.Slice(doc.Accounts, func(i, j int) bool {
		a, b := doc.Accounts[i], doc.Accounts[j]
		return a.Provider < b.Provider || a.Provider == b.Provider && a.ID < b.ID
	})

	for _, model := range in.Models {
		pm := PoolModel{Model: model, Providers: []string{}, Rows: []PoolRow{}}
		switch {
		case !inventory:
			pm.UnmeasuredBecause = text("inventory")
		case !complete:
			pm.UnmeasuredBecause = text("registry")
		default:
			s.poolModelLocked(&pm, members, now)
		}
		verdictOf(&pm, in.Floor)
		doc.Models = append(doc.Models, pm)
	}
	return doc
}

func (s *State) poolAccountLocked(m *poolMember, labels, same map[string]string, registryRead bool, now time.Time) PoolAccount {
	a := PoolAccount{ID: opaqueID(m.id), Provider: m.provider, Disabled: m.disabled}
	if m.registered {
		n := len(m.models)
		a.RegisteredModels = &n
	}
	c := m.cred
	if c == nil {
		return a
	}
	a.Label, a.Plan, a.ReadFailure = text(labels[m.id]), text(c.Plan), text(c.readFailure)
	if to := same[m.id]; s.creds[to] != nil {
		a.SameAs = text(opaqueID(to))
	}
	a.Rest = c.health.view(now)
	a.Absent = []string{}
	for kind := range c.Absent {
		a.Absent = append(a.Absent, kind)
	}
	sort.Strings(a.Absent)
	a.Windows = []PoolWindow{}
	for _, w := range s.windowViewsLocked(c, now) {
		a.Windows = append(a.Windows, PoolWindow{Kind: w.Kind, Left: percent(w.Remaining), ResetAt: when(w.ResetAt), ReadAt: w.ObservedAt.UTC(), Stale: w.Stale})
	}
	if c.Provider == "codex" {
		a.Credits = &PoolCredits{State: "unknown"}
		if !c.creditsAt.IsZero() {
			stale := now.Sub(c.creditsAt) > s.cfg.staleAfter()
			a.Credits = &PoolCredits{State: c.credits.State, Balance: c.credits.Balance, ReadAt: when(c.creditsAt), Stale: &stale}
		}
	}
	return a
}

// poolModelLocked lists one model's accounts: every one whose registry entry holds the name, and
// the other accounts of the same providers, in the order the ledger ranks them for it.
func (s *State) poolModelLocked(pm *PoolModel, members map[string]*poolMember, now time.Time) {
	key := modelKey(pm.Model)
	registers := func(m *poolMember) bool {
		return slices.ContainsFunc(m.models, func(name string) bool { return strings.ToLower(strings.TrimSpace(name)) == key })
	}
	for _, m := range members {
		if registers(m) && !slices.Contains(pm.Providers, m.provider) {
			pm.Providers = append(pm.Providers, m.provider)
		}
	}
	sort.Strings(pm.Providers)
	var cands []Candidate
	var others []*poolMember
	for _, m := range members {
		switch {
		case !slices.Contains(pm.Providers, m.provider):
		case m.cred != nil:
			cands = append(cands, Candidate{ID: m.id, Provider: m.provider})
		default:
			others = append(others, m)
		}
	}
	sort.Slice(others, func(i, j int) bool {
		a, b := others[i], others[j]
		return a.provider < b.provider || a.provider == b.provider && opaqueID(a.id) < opaqueID(b.id)
	})
	ranked := map[string]Ranked{}
	order := []*poolMember{}
	if len(cands) > 0 {
		for _, r := range s.rankLocked(cands, pm.Model, now, false) {
			ranked[r.ID] = r
			order = append(order, members[r.ID])
		}
	}
	order = append(order, others...)

	// Eligible accounts that sign in to one provider account form a group, counted once under the
	// member whose all-models week was read last.
	groups := map[string][]*poolMember{}
	for _, m := range order {
		if m.cred != nil && (m.disabled == nil || !*m.disabled) && registers(m) {
			if account := s.identities[m.id].Account; account != "" {
				groups[account] = append(groups[account], m)
			}
		}
	}
	under := map[string]string{}
	for _, g := range groups {
		rep := g[0]
		for _, m := range g[1:] {
			a, b := m.cred.Windows[KindWeekly].ObservedAt, rep.cred.Windows[KindWeekly].ObservedAt
			if a.After(b) || a.Equal(b) && opaqueID(m.id) < opaqueID(rep.id) {
				rep = m
			}
		}
		for _, m := range g {
			under[m.id] = rep.id
		}
	}
	// The model's own week, as the pick names it, and whether an account of the provider holds it.
	ownWeek := func(provider string) string {
		if provider == "claude" {
			return ModelBucket(pm.Model)
		}
		return ""
	}
	heldInPool := map[string]bool{}
	for _, m := range members {
		if k := ownWeek(m.provider); k != "" && m.cred != nil {
			if _, ok := m.cred.Windows[k]; ok {
				heldInPool[m.provider] = true
			}
		}
	}

	for _, m := range order {
		row := PoolRow{Account: opaqueID(m.id)}
		switch {
		case m.disabled != nil && *m.disabled:
			row.WhyNot = text("disabled")
		case !registers(m):
			row.WhyNot = text("not_registered")
		case under[m.id] != "" && under[m.id] != m.id:
			row.WhyNot, row.CountedUnder = text("same_account"), text(opaqueID(under[m.id]))
		default:
			row.Counts = true
		}
		if row.Counts && m.cred != nil {
			group := []*Cred{m.cred}
			if account := s.identities[m.id].Account; account != "" {
				group = group[:0]
				for _, g := range groups[account] {
					group = append(group, g.cred)
				}
			}
			k := ownWeek(m.provider)
			if left, kind, reset, read := s.weeklyLocked(group, k, k != "" && heldInPool[m.provider], now); read {
				row.WeeklyLeft, row.WeeklyWindow, row.WeeklyResetAt, row.WeeklyRead = &left, &kind, when(reset), true
			}
			r := ranked[m.id]
			row.Tier, row.Blocked, row.Resting, row.BackAt, row.Reason = &r.Tier, &r.Blocked, &r.Resting, when(r.BackAt), &r.Reason
		}
		pm.Rows = append(pm.Rows, row)
	}
	// The accounts that count come first, so the first of them not blocked is the one a new session
	// most likely gets; each part keeps the ledger's order.
	sort.SliceStable(pm.Rows, func(i, j int) bool { return pm.Rows[i].Counts && !pm.Rows[j].Counts })
}

// weeklyLocked is the weekly figure of a counting account, or of the group of sign-ins to one
// provider account it stands for: the least left among its bounding windows (the all-models week,
// and the model's own week k where it bounds), and whether that figure can be used. inPool says an
// account of the provider holds k.
func (s *State) weeklyLocked(group []*Cred, k string, inPool bool, now time.Time) (float64, string, time.Time, bool) {
	holds, absent := false, false
	for _, c := range group {
		_, held := c.Windows[k]
		holds, absent = holds || k != "" && held, absent || k != "" && !held && c.Absent[k]
	}
	kinds := []string{KindWeekly}
	if holds {
		kinds = append(kinds, k)
	}
	type bound struct {
		kind           string
		left           float64
		reset          time.Time
		present, fresh bool
	}
	var bounds []bound
	for _, kind := range kinds {
		var rem float64
		var reset time.Time
		var present, fresh bool
		if len(group) == 1 {
			rem, reset, present, fresh = s.effective(group[0], kind, now)
		} else {
			// A group is one quota read through several sign-ins: their windows in force, in the
			// order read, go through the window rules on a scratch account outside the ledger.
			scratch := &Cred{Provider: group[0].Provider, Windows: map[string]Window{}}
			var held []Window
			for _, c := range group {
				c.settle(kind, now)
				if w, ok := c.Windows[kind]; ok {
					held = append(held, w)
				}
				if c.planAt.After(scratch.planAt) {
					scratch.planAt = c.planAt
				}
			}
			sort.SliceStable(held, func(i, j int) bool { return held[i].ObservedAt.Before(held[j].ObservedAt) })
			for _, w := range held {
				scratch.observe(w)
			}
			rem, reset, present, fresh = s.effective(scratch, kind, now)
			if t := scratch.tracks[kind]; t != nil && t.fall != nil {
				return 0, "", time.Time{}, false // a fall still waits: the zero in force may be gone
			}
		}
		bounds = append(bounds, bound{kind, percent(rem), reset, present, fresh})
	}
	// Two bounding windows at the same percent: the one with the later known reset is shown, a
	// known reset before an unknown one, then the model's own week.
	least := func(bs []bound) bound {
		best := bs[0]
		for _, b := range bs[1:] {
			switch {
			case b.left != best.left:
				if b.left < best.left {
					best = b
				}
			case !b.reset.IsZero() && !best.reset.IsZero() && !b.reset.Equal(best.reset):
				if b.reset.After(best.reset) {
					best = b
				}
			case b.reset.IsZero() != best.reset.IsZero():
				if !b.reset.IsZero() {
					best = b
				}
			case b.kind != KindWeekly:
				best = b
			}
		}
		return best
	}
	var zeros []bound
	for _, b := range bounds {
		if b.present && b.fresh && b.left <= 0 {
			zeros = append(zeros, b)
		}
	}
	switch {
	case len(group) > 1 && holds && absent:
		return 0, "", time.Time{}, false // one sign-in has the model's own week and another not
	case len(zeros) > 0:
		z := least(zeros)
		return 0, z.kind, z.reset, true
	case !holds && !absent && inPool:
		return 0, "", time.Time{}, false // the week exists in the pool; this account has not said
	}
	for _, b := range bounds {
		if !b.present || !b.fresh {
			return 0, "", time.Time{}, false
		}
	}
	b := least(bounds)
	return b.left, b.kind, b.reset, true
}

// verdictOf sets a model's pooled figures and, given a floor, its verdict: the first line that
// applies of membership incomplete, the name registered nowhere, or only on providers quota-pilot
// does not read; else enough, short, or unmeasured.
func verdictOf(pm *PoolModel, floor *float64) {
	above := 0
	for _, r := range pm.Rows {
		if !r.Counts {
			continue
		}
		pm.Accounts++
		if r.WeeklyRead {
			pm.Read++
			if pm.BestWeeklyLeft == nil || *r.WeeklyLeft > *pm.BestWeeklyLeft {
				pm.BestWeeklyLeft = r.WeeklyLeft
			}
			if floor != nil && *r.WeeklyLeft >= *floor {
				above++
			}
		}
	}
	if floor == nil {
		pm.UnmeasuredBecause = nil
		return
	}
	pm.AtOrAboveFloor = &above
	pooled := slices.ContainsFunc(pm.Providers, Supported)
	switch {
	case pm.UnmeasuredBecause != nil:
		pm.Verdict = text("unmeasured")
	case len(pm.Providers) == 0:
		pm.Verdict, pm.UnmeasuredBecause = text("unmeasured"), text("name_not_registered")
	case !pooled:
		pm.Verdict = text("not_pooled")
	case above > 0:
		pm.Verdict = text("enough")
	case pm.Accounts > 0 && pm.Read == pm.Accounts:
		pm.Verdict = text("short")
	default:
		pm.Verdict, pm.UnmeasuredBecause = text("unmeasured"), text("unread")
	}
}

// percent is a fraction left as the document prints it, and the floor compares: two decimals.
func percent(rem float64) float64 {
	return math.Round(rem*1e4) / 100
}

func text(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func when(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	u := t.UTC()
	return &u
}
