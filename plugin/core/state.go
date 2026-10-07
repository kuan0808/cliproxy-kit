// Package core holds quota-pilot's routing state and decisions. It has no cgo and no I/O, so
// every rule here is unit-tested with an injected clock.
package core

import (
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// bindingTTL keeps a thread on its account across long pauses and resumed sessions.
	bindingTTL = 24 * time.Hour
	sessionTTL = 24 * time.Hour
	routeTTL   = 24 * time.Hour
	// choiceTTL keeps an account or a route the user chose for as long as Claude Code keeps a
	// session to resume (30 days by default); what the proxy chose itself lasts a day unused.
	choiceTTL = 30 * 24 * time.Hour
	// traceTTL bounds how long a request's thread marker waits for its usage record.
	traceTTL    = time.Hour
	activeAfter = time.Hour
	idleAfter   = 15 * time.Minute
	// cacheGone is the longest a prompt cache lives (Claude's 1-hour TTL); a session idle that
	// long rewrites its cache whichever account it lands on.
	cacheGone = time.Hour
	// fiveRefillSoon: a 5-hour window this close to its reset counts as refilled for a new session.
	fiveRefillSoon = 30 * time.Minute
	maxAcks        = 50
	agentMarker    = ":agent:"
)

// Config is the plugin configuration, edited on the official panel's Plugins page.
type Config struct {
	CrossProvider          string            // "off" or "auto"
	FallbackMap            map[string]string // provider -> "provider:model"
	MinFiveHourLeftPercent float64
	IdlePollMinutes        int
	ContextLengths         map[string]int
}

// Normalized fills defaults and drops invalid values.
func (c Config) Normalized() Config {
	if c.CrossProvider != "auto" {
		c.CrossProvider = "off"
	}
	if c.MinFiveHourLeftPercent <= 0 || c.MinFiveHourLeftPercent >= 100 {
		c.MinFiveHourLeftPercent = 25
	}
	if c.IdlePollMinutes <= 0 {
		c.IdlePollMinutes = 10
	}
	if c.FallbackMap == nil {
		c.FallbackMap = map[string]string{}
	}
	if c.ContextLengths == nil {
		c.ContextLengths = map[string]int{}
	}
	return c
}

// staleAfter is how old a window may be before it no longer counts for ranking.
func (c Config) staleAfter() time.Duration {
	return time.Duration(2*c.IdlePollMinutes+5) * time.Minute
}

// Cred is one upstream credential.
type Cred struct {
	ID       string
	Index    string
	Provider string
	Email    string
	Disabled bool
	// Unavailable is the host's aggregate over all models: some model of this credential is
	// cooling down. It says nothing about any one model, so it never blocks on its own.
	Unavailable    bool
	NextRetryAfter time.Time
	Windows        map[string]Window
	// Absent holds the window kinds the provider's last full reading said the account does not
	// have, apart from those not read yet.
	Absent map[string]bool
	// Plan is the subscription, e.g. Max 20x or Pro 200; "" until a poll has read it.
	Plan string
	// refusedAt is when the account last turned a request away while read as used up; a request
	// it answers clears it. Kept in memory: after a restart one more refusal says it again.
	refusedAt time.Time
	// startedOver is when a window's use last fell back without a new period: what a plan change
	// does, so the plan is read again. In memory only.
	startedOver time.Time
	// tracks apply the window rules (window.go) to each window kind's readings, and planAt is when
	// the plan last changed. In memory only: after a restart they start from the windows kept.
	tracks map[string]*track[Window]
	planAt time.Time
}

// CredInfo is the inventory the host reports for a credential.
type CredInfo struct {
	ID, Index, Provider, Email string
	Disabled, Unavailable      bool
	NextRetryAfter             time.Time
}

// Binding ties one conversation thread (a main session, a subagent or a fork) to the
// credential that holds its upstream message thread and prompt cache.
type Binding struct {
	AuthID   string    `json:"auth_id"`
	Reason   string    `json:"reason"`
	LastUsed time.Time `json:"last_used"`
	// At is when the request that set it was sent: a request sent earlier that answers later
	// cannot take the binding back.
	At time.Time `json:"at,omitzero"`
}

// Route is a per-session cross-provider override: the band's, or the proxy's own takeover (Auto).
type Route struct {
	Provider string    `json:"provider"`
	Model    string    `json:"model"`
	Auto     bool      `json:"auto"`
	At       time.Time `json:"at"`
}

// ttl is how long a binding lasts unused: one the user chose as long as a session can be resumed.
func (b Binding) ttl() time.Duration {
	if b.Reason == switchedReason {
		return choiceTTL
	}
	return bindingTTL
}

// ttl is how long a route lasts unused: one the user chose as long as a session can be resumed.
func (r Route) ttl() time.Duration {
	if r.Auto {
		return routeTTL
	}
	return choiceTTL
}

// Usage is the part of an upstream usage record the core needs.
type Usage struct {
	Provider       string
	Model          string
	SessionID      string
	ParentID       string
	TraceID        string
	AuthID         string
	AuthIndex      string
	Failed         bool
	StatusCode     int
	RequestedAt    time.Time
	Input, Output  int64
	CacheRead      int64
	CacheCreation  int64
	ResponseHeader http.Header
	TierAsked      string // the service tier the client asked for, as the host read it; "auto" for none
	TierServed     string // the service tier the provider reported serving it at; "" when it did not say
	ClientKey      string // the client key the proxy accepted the request with
}

type session struct {
	Provider       string
	Model          string
	ServedAuth     string
	LastMainAt     time.Time
	LastSeen       time.Time
	Totals         Tokens
	Last           Tokens
	LastSwitch     *Switch
	RequestedModel string
	RouteNote      string
	LastCommandAt  time.Time
	// Client is the key whose request it first served (see clientID, "" for none, on a proxy
	// without api-keys), once Owned: only that key's band commands it.
	Client string
	Owned  bool
}

// Tokens are summed or single-request token counts of a session's main thread.
type Tokens struct {
	Input         int64     `json:"input"`
	Output        int64     `json:"output"`
	CacheRead     int64     `json:"cache_read"`
	CacheCreation int64     `json:"cache_creation"`
	At            time.Time `json:"at,omitempty"`
}

// Switch records a change of serving credential for a session.
type Switch struct {
	From   string    `json:"from"`
	To     string    `json:"to"`
	At     time.Time `json:"at"`
	Reason string    `json:"reason"`
}

// State is the plugin's whole routing state.
type State struct {
	mu       sync.Mutex
	cfg      Config
	now      func() time.Time
	bootID   string
	sequence uint64
	creds    map[string]*Cred
	// bindings are keyed by provider + "|" + canonical thread id.
	bindings map[string]*Binding
	sessions map[string]*session // keyed by root session id
	routes   map[string]Route    // keyed by root session id
	// traces describe inbound requests by id until their usage record arrives, so the record can
	// tell a conversation turn from a side request of the same session.
	traces map[string]trace
	// displaced holds, by binding key, the models for which the bound account was not offered at
	// the last pick: it cannot serve them, so the next success of that model elsewhere takes the
	// binding over. By model, as a request beside the conversation on another model may still be
	// served there.
	displaced    map[string]map[string]bool
	log          []LogEntry // usage log lines not yet written to disk
	acks         []Ack
	lastActivity time.Time
	dirty        bool
	lastError    string
	// inventoryLoaded is false until the host's credential list arrived; until then a
	// provider is never reported as used up, because unseen credentials may still serve.
	inventoryLoaded bool
	// inventoryAt is when the host's list was last read: an automatic takeover, which acts on every
	// account of a provider being used up, waits for a fresh one.
	inventoryAt time.Time
	// identities name the provider account behind each credential read, kept past its removal.
	identities map[string]Identity
	// clients are the client keys the proxy accepted, by hash, with when each was last used.
	clients map[string]time.Time
	// keyedAt is when the newest request that came with a key was sent: one without a key sent
	// before it, answered late, does not open the proxy again (see noteClientLocked).
	keyedAt time.Time
}

// New creates an empty state. now may be nil for the wall clock.
func New(bootID string, now func() time.Time) *State {
	if now == nil {
		now = time.Now
	}
	return &State{
		cfg:        Config{}.Normalized(),
		now:        now,
		bootID:     bootID,
		creds:      map[string]*Cred{},
		bindings:   map[string]*Binding{},
		sessions:   map[string]*session{},
		routes:     map[string]Route{},
		traces:     map[string]trace{},
		displaced:  map[string]map[string]bool{},
		identities: map[string]Identity{},
		clients:    map[string]time.Time{},
	}
}

// SetConfig replaces the configuration.
func (s *State) SetConfig(cfg Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg.Normalized()
	s.dirty = true
}

// Config returns the current configuration.
func (s *State) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// Idle reports whether no request activity happened for a while; background work pauses then.
func (s *State) Idle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastActivity.IsZero() || s.now().Sub(s.lastActivity) > idleAfter
}

// TakeDirty reports and clears whether the state changed since the last call, so it is saved.
func (s *State) TakeDirty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dirty
	s.dirty = false
	return d
}

// NoteError keeps the last internal error for the snapshot.
func (s *State) NoteError(msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.noteErrorLocked(msg)
}

func (s *State) noteErrorLocked(msg string) {
	s.lastError = s.now().UTC().Format(time.RFC3339) + " " + msg
	s.dirty = true
}

// Persisted is the part of the state that survives a proxy restart.
type Persisted struct {
	SchemaVersion int                `json:"schema_version"`
	Bindings      map[string]Binding `json:"bindings"`
	Routes        map[string]Route   `json:"routes"`
	// Sessions keep which account and model each session was last served on, so a restart does
	// not leave the band guessing until the session's next reply.
	Sessions map[string]SavedSession `json:"sessions,omitempty"`
	// Accounts keep the quota last read, each window with when it was read, so a restart does not
	// leave routing, the band and the report without it until the next reading: a used-up account
	// stays out of new sessions, and a reading grown old counts as stale as it would have.
	Accounts map[string]SavedAccount `json:"accounts,omitempty"`
	// Identities name the provider account behind each credential read, removed ones included, so
	// the report counts an account logged in again under a new credential as one account.
	Identities map[string]Identity `json:"identities,omitempty"`
	// Clients are the client keys the proxy accepted (see clientID), with when each was last used,
	// and KeyedAt when the newest request with a key was sent (see State.keyedAt).
	Clients map[string]time.Time `json:"clients,omitempty"`
	KeyedAt time.Time            `json:"keyed_at,omitzero"`
}

// Identity is the provider account a credential logs in to, and when that was last read.
type Identity struct {
	Account string    `json:"account"`
	Seen    time.Time `json:"seen"`
}

// identityTTL is how long the identity of a credential no longer read is kept: as long as the log.
const identityTTL = 100 * 24 * time.Hour

// SetIdentity records the provider account a credential logs in to.
func (s *State) SetIdentity(authID, account string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if authID == "" || account == "" {
		return
	}
	s.identities[authID] = Identity{Account: account, Seen: s.now()}
	s.dirty = true
}

// Canonical maps each credential that logs in to the same provider account as another to the one
// the report counts that account under: the credential the host holds, enabled before disabled,
// else the one read last. A credential with no other for its account is left out.
func (s *State) Canonical() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.canonicalLocked()
}

func (s *State) canonicalLocked() map[string]string {
	byAccount := map[string][]string{}
	for id, ident := range s.identities {
		byAccount[ident.Account] = append(byAccount[ident.Account], id)
	}
	out := map[string]string{}
	for _, ids := range byAccount {
		if len(ids) < 2 {
			continue
		}
		sort.Slice(ids, func(i, j int) bool {
			a, b := ids[i], ids[j]
			if ha, hb := s.creds[a] != nil, s.creds[b] != nil; ha != hb {
				return ha
			}
			if ea, eb := s.creds[a] != nil && !s.creds[a].Disabled, s.creds[b] != nil && !s.creds[b].Disabled; ea != eb {
				return ea
			}
			if sa, sb := s.identities[a].Seen, s.identities[b].Seen; !sa.Equal(sb) {
				return sa.After(sb)
			}
			return a < b
		})
		for _, id := range ids[1:] {
			out[id] = ids[0]
		}
	}
	return out
}

// SavedAccount is the part of an account kept across restarts. The host's inventory, read again
// at the first poll, drops one the proxy no longer holds.
type SavedAccount struct {
	Provider string            `json:"provider"`
	Email    string            `json:"email,omitempty"`
	Plan     string            `json:"plan,omitempty"`
	Windows  map[string]Window `json:"windows,omitempty"`
	Absent   []string          `json:"absent,omitempty"`
}

// SavedSession is the part of a session kept across restarts.
type SavedSession struct {
	Provider       string    `json:"provider,omitempty"`
	Model          string    `json:"model,omitempty"`
	ServedAuth     string    `json:"served_auth,omitempty"`
	RequestedModel string    `json:"requested_model,omitempty"`
	LastMainAt     time.Time `json:"last_main_at"`
	LastSeen       time.Time `json:"last_seen"`
	LastSwitch     *Switch   `json:"last_switch,omitempty"`
	Client         string    `json:"client,omitempty"`
	Owned          bool      `json:"owned,omitempty"`
	// Last is its last main turn, so a restart does not leave routing to judge a conversation's
	// size by a continuation that carries only what is new.
	Last Tokens `json:"last,omitzero"`
}

// Export returns the bindings, routes, sessions and quota readings to save.
func (s *State) Export() Persisted {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := Persisted{SchemaVersion: SchemaVersion, Bindings: map[string]Binding{}, Routes: map[string]Route{}, Sessions: map[string]SavedSession{},
		Accounts: map[string]SavedAccount{}}
	for k, b := range s.bindings {
		p.Bindings[k] = *b
	}
	for k, r := range s.routes {
		p.Routes[k] = r
	}
	for root, sess := range s.sessions {
		p.Sessions[root] = SavedSession{Provider: sess.Provider, Model: sess.Model, ServedAuth: sess.ServedAuth,
			RequestedModel: sess.RequestedModel, LastMainAt: sess.LastMainAt, LastSeen: sess.LastSeen, LastSwitch: sess.LastSwitch, Client: sess.Client,
			Owned: sess.Owned, Last: sess.Last}
	}
	for id, c := range s.creds {
		if len(c.Windows) == 0 && len(c.Absent) == 0 && c.Plan == "" {
			continue
		}
		windows := make(map[string]Window, len(c.Windows))
		for kind, w := range c.Windows {
			windows[kind] = w
		}
		var absent []string
		for kind := range c.Absent {
			absent = append(absent, kind)
		}
		sort.Strings(absent)
		p.Accounts[id] = SavedAccount{Provider: c.Provider, Email: c.Email, Plan: c.Plan, Windows: windows, Absent: absent}
	}
	p.Identities = map[string]Identity{}
	for id, ident := range s.identities {
		p.Identities[id] = ident
	}
	p.Clients = map[string]time.Time{}
	for h, seen := range s.clients {
		p.Clients[h] = seen
	}
	p.KeyedAt = s.keyedAt
	return p
}

// Import restores saved bindings and routes that have not expired, and the quota last read.
func (s *State) Import(p Persisted) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.SchemaVersion != SchemaVersion {
		return
	}
	now := s.now()
	for k, b := range p.Bindings {
		if b.AuthID != "" && now.Sub(b.LastUsed) <= b.ttl() {
			s.bindings[k] = &b
		}
	}
	for k, r := range p.Routes {
		if r.Provider != "" && r.Model != "" && now.Sub(r.At) <= r.ttl() {
			s.routes[k] = r
		}
	}
	chosen := s.chosenLocked()
	for root, saved := range p.Sessions {
		if now.Sub(saved.LastSeen) <= sessionTTL || chosen[root] {
			s.sessions[root] = &session{Provider: saved.Provider, Model: saved.Model, ServedAuth: saved.ServedAuth,
				RequestedModel: saved.RequestedModel, LastMainAt: saved.LastMainAt, LastSeen: saved.LastSeen, LastSwitch: saved.LastSwitch,
				Client: saved.Client, Owned: saved.Owned, Last: saved.Last}
		}
	}
	for id, ident := range p.Identities {
		if ident.Account != "" && now.Sub(ident.Seen) <= identityTTL {
			s.identities[id] = ident
		}
	}
	s.keyedAt = p.KeyedAt
	for h, seen := range p.Clients {
		if now.Sub(seen) <= clientTTL {
			s.clients[h] = seen
			// A state saved before the watermark was: the keys' own times stand in for it.
			if p.KeyedAt.IsZero() && h != "" && seen.After(s.keyedAt) {
				s.keyedAt = seen
			}
		}
	}
	for id, saved := range p.Accounts {
		if id == "" || !Supported(saved.Provider) {
			continue
		}
		c := s.credLocked(id, saved.Provider)
		if c.Email == "" {
			c.Email = saved.Email
		}
		if c.Plan == "" {
			c.Plan = saved.Plan
		}
		windows := make([]Window, 0, len(saved.Windows))
		for kind, w := range saved.Windows {
			w.Kind = kind
			// A reading dated ahead of the clock (the clock was set back since) is not trusted as
			// fresh: a reading taken now replaces it.
			if w.ObservedAt.After(now.Add(time.Minute)) {
				w.ObservedAt = time.Time{}
			}
			windows = append(windows, w)
		}
		s.mergeWindowsLocked(id, saved.Provider, windows)
		for _, kind := range saved.Absent {
			if _, read := c.Windows[kind]; !read {
				if c.Absent == nil {
					c.Absent = map[string]bool{}
				}
				c.Absent[kind] = true
			}
		}
	}
	s.dirty = true
}

// RootSession returns the main-conversation id for a canonical session id.
func RootSession(canonical, parent string) string {
	if parent != "" {
		return rootOnly(parent)
	}
	return rootOnly(canonical)
}

func rootOnly(id string) string {
	if i := strings.Index(id, agentMarker); i >= 0 {
		return id[:i]
	}
	return id
}

// RawSession strips the server's client prefix so the id matches Claude Code's own session id.
func RawSession(root string) string {
	if raw, ok := strings.CutPrefix(root, "claude:"); ok {
		return raw
	}
	return root
}

func rootFromRaw(raw string) string {
	if strings.Contains(raw, ":") {
		return raw
	}
	return "claude:" + raw
}

// UpdateInventory merges the host's credential list.
func (s *State) UpdateInventory(list []CredInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, info := range list {
		if info.ID == "" || !Supported(strings.ToLower(info.Provider)) {
			continue
		}
		seen[info.ID] = true
		c := s.credLocked(info.ID, info.Provider)
		c.Index, c.Email = info.Index, info.Email
		c.Disabled, c.Unavailable, c.NextRetryAfter = info.Disabled, info.Unavailable, info.NextRetryAfter
	}
	for id := range s.creds {
		if !seen[id] {
			delete(s.creds, id)
		}
	}
	s.inventoryLoaded, s.inventoryAt = true, s.now()
	s.dirty = true
}

// memberLocked is the account the host holds under id; nil once the host's list, read, does not
// name it: a late record of a removed account is history, not an account again.
func (s *State) memberLocked(id, provider string) *Cred {
	if id == "" || s.inventoryLoaded && s.creds[id] == nil {
		return nil
	}
	return s.credLocked(id, provider)
}

func (s *State) credLocked(id, provider string) *Cred {
	c := s.creds[id]
	if c == nil {
		c = &Cred{ID: id, Windows: map[string]Window{}}
		s.creds[id] = c
	}
	if provider != "" {
		c.Provider = strings.ToLower(provider)
	}
	return c
}

// SetPlan records a credential's subscription plan.
func (s *State) SetPlan(authID, provider, plan string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if authID == "" || plan == "" {
		return
	}
	if c := s.memberLocked(authID, provider); c != nil && c.Plan != plan {
		if c.Plan != "" {
			// A plan change can start the windows over by any amount: the log says when, for the
			// report's walk.
			now := s.now()
			c.planChanged(now)
			s.log = append(s.log, LogEntry{T: now.UnixMilli(), Account: authID, Provider: strings.ToLower(provider), Poll: true, Plan: plan})
		}
		c.Plan = plan
		s.dirty = true
	}
}

// AccountInfo is what the usage view shows about one credential.
type AccountInfo struct {
	ID       string    `json:"id"`
	Label    string    `json:"label"`
	Email    string    `json:"-"` // for naming it apart from the others; never sent
	Plan     string    `json:"plan,omitempty"`
	Provider string    `json:"provider"`
	ResetAt  time.Time `json:"reset_at"` // end of the current weekly window; zero when unknown
}

// Account describes a credential for the usage view.
func (s *State) Account(authID string) (AccountInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.creds[authID]
	if c == nil {
		return AccountInfo{}, false
	}
	_, reset, _, _ := s.effective(c, KindWeekly, s.now())
	return AccountInfo{ID: c.ID, Label: s.labelsLocked()[c.ID], Email: c.Email, Plan: c.Plan, Provider: c.Provider, ResetAt: reset}, true
}

// FiveHour tells when an account's 5-hour window resets, zero when none runs or it is not known;
// whether a reading of it is in force; and whether the provider said the account has none (a Codex
// plan with a weekly window only).
func (s *State) FiveHour(authID string) (reset time.Time, present, absent bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.creds[authID]
	if c == nil {
		return time.Time{}, false, false
	}
	_, reset, present, _ = s.effective(c, KindFiveHour, s.now())
	return reset, present, c.Absent[KindFiveHour]
}

// Accounts lists a provider's credentials for the usage view, by id.
func (s *State) Accounts(provider string) []AccountInfo {
	s.mu.Lock()
	ids := make([]string, 0, len(s.creds))
	for id, c := range s.creds {
		if c.Provider == provider {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	sort.Strings(ids)
	out := make([]AccountInfo, 0, len(ids))
	for _, id := range ids {
		if info, ok := s.Account(id); ok {
			out = append(out, info)
		}
	}
	return out
}

// Plan returns a credential's known plan, "" when not read yet.
func (s *State) Plan(authID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.creds[authID]; c != nil {
		return c.Plan
	}
	return ""
}

// MergeWindows stores windows a provider reported in part (response headers) by the window rules.
func (s *State) MergeWindows(authID, provider string, windows []Window) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mergeWindowsLocked(authID, provider, windows)
	s.logReadingLocked(authID, provider, windows)
}

// MergePoll stores a full reading of the provider's usage endpoint: the windows it names, and the
// absence of those it does not.
func (s *State) MergePoll(authID, provider string, windows []Window) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if authID == "" {
		return
	}
	s.mergeWindowsLocked(authID, provider, windows)
	if c := s.memberLocked(authID, provider); c != nil {
		c.absentAfter(windows)
		s.dirty = true
	}
	s.logReadingLocked(authID, provider, windows)
}

func (s *State) logReadingLocked(authID, provider string, windows []Window) {
	if r, ok := readingOf(windows); authID != "" && ok {
		r.T, r.Account, r.Provider, r.Poll = s.now().UnixMilli(), authID, strings.ToLower(provider), true
		s.log = append(s.log, r)
	}
}

func (s *State) mergeWindowsLocked(authID, provider string, windows []Window) {
	c := s.memberLocked(authID, provider)
	if c == nil || len(windows) == 0 {
		return
	}
	for _, w := range windows {
		c.observe(w)
	}
	s.dirty = true
}

// StartedOver tells when a window of the account last started over without a new period, zero when
// none did since the proxy started.
func (s *State) StartedOver(authID string) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.creds[authID]; c != nil {
		return c.startedOver
	}
	return time.Time{}
}

// Observe records one upstream usage record.
func (s *State) Observe(u Usage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.lastActivity = now
	provider := strings.ToLower(u.Provider)
	// Headers describe the quota when the request was answered, not when its usage record
	// arrives: a long stream reports late and must not overwrite a newer observation.
	at := u.RequestedAt
	if at.IsZero() || at.After(now) {
		at = now
	}
	// A request with neither a key nor a session may be the host's own, a model call of a plugin.
	if u.ClientKey != "" || u.SessionID != "" {
		s.noteClientLocked(u.ClientKey, at, now)
	}
	if provider == "" {
		if c := s.creds[u.AuthID]; c != nil {
			provider = c.Provider
		}
	}
	supported := Supported(provider)
	// What the client asked, as Intercept saw it; kept until the request succeeds, as each
	// upstream attempt reports apart.
	tr, known := s.traces[u.TraceID]
	if !u.Failed {
		delete(s.traces, u.TraceID)
	}
	if u.AuthID != "" {
		var windows []Window
		if supported {
			if c := s.memberLocked(u.AuthID, provider); c != nil && u.AuthIndex != "" {
				c.Index = u.AuthIndex
			}
			windows = WindowsFromHeaders(provider, u.ResponseHeader, at)
			s.mergeWindowsLocked(u.AuthID, provider, windows)
		}
		r, read := readingOf(windows)
		r.T, r.Account, r.Provider = at.UnixMilli(), u.AuthID, provider
		// A refused request (a 429 at 100%) still reads the quota with no tokens run; a stream
		// that broke off after it began ran the tokens it reports, and they count.
		ran := u.Input+u.Output+u.CacheRead+u.CacheCreation > 0
		if c := s.creds[u.AuthID]; supported && c != nil {
			switch {
			case !u.Failed || ran:
				c.refusedAt = time.Time{}
			case u.StatusCode == http.StatusTooManyRequests && s.classifyLocked(c, u.Model, now).Blocked:
				// Turned away for quota: a request-scoped failure (a lost thread, a bad request, a
				// cancel) says nothing of the account.
				c.refusedAt = at
			}
		}
		if u.Failed && !ran && read {
			r.Poll = true
			s.log = append(s.log, r)
		}
		if !u.Failed || ran {
			root := RootSession(u.SessionID, u.ParentID)
			r.Session, r.Agent = RawSession(root), u.SessionID != "" && u.SessionID != root
			r.Model, r.TierAsked, r.TierServed = u.Model, u.TierAsked, u.TierServed
			if known {
				r.TierAsked, r.Remote = tr.Tier, tr.Remote
			}
			r.Input = freshInput(provider, u.Input, u.CacheRead, u.CacheCreation)
			r.Output, r.CacheRead, r.CacheWrite = u.Output, u.CacheRead, u.CacheCreation
			s.log = append(s.log, r)
		}
	}
	if u.SessionID == "" {
		return
	}
	root := RootSession(u.SessionID, u.ParentID)
	sess := s.sessionLocked(root, now)
	if u.Failed || u.AuthID == "" {
		return
	}
	if !sess.Owned {
		// The key whose request it first served owns it; one that only failed under its id does not.
		sess.Client, sess.Owned = clientID(u.ClientKey), true
	}
	if supported {
		s.commitLocked(provider, u.SessionID, root, u.AuthID, u.Model, tr.Thread, known && tr.Side, at, now)
	}
	if u.SessionID != root || at.Before(sess.LastMainAt) || (known && tr.Side) {
		return // a subagent, a fork, a side request, or a late record from an older request
	}
	sess.LastMainAt = at
	sess.Provider, sess.Model = provider, u.Model
	// The served account is the one that answered: a late answer from the old account after a
	// switch names that account, so the cache the band shows is the one that was written.
	if prev := s.creds[sess.ServedAuth]; prev != nil && prev.Provider == provider && sess.ServedAuth != u.AuthID {
		reason := ""
		if b := s.bindings[provider+"|"+root]; b != nil && b.AuthID == u.AuthID {
			reason = b.Reason
		}
		sess.LastSwitch = &Switch{From: sess.ServedAuth, To: u.AuthID, At: now, Reason: reason}
	}
	sess.ServedAuth = u.AuthID
	// Input without the cached part, which Codex counts in it: the same for every provider.
	input := freshInput(provider, u.Input, u.CacheRead, u.CacheCreation)
	sess.Last = Tokens{Input: input, Output: u.Output, CacheRead: u.CacheRead, CacheCreation: u.CacheCreation, At: now}
	sess.Totals.Input += input
	sess.Totals.Output += u.Output
	sess.Totals.CacheRead += u.CacheRead
	sess.Totals.CacheCreation += u.CacheCreation
	s.dirty = true
}

// commitLocked moves a thread's binding only after a request succeeded. A request that carried
// a message thread proves the thread now lives on authID, and so does a turn's success once the
// bound account stopped being offered. A side request (a permission check, a title) only binds a
// thread that has no account yet: it may run on a smaller model whose limits say nothing about
// where the conversation fits. A subagent without a thread of its own keeps following its parent.
func (s *State) commitLocked(provider, canonical, root, authID, model string, threaded, side bool, at, now time.Time) {
	key := provider + "|" + canonical
	b := s.bindings[key]
	displaced := s.displaced[key][modelKey(model)]
	moved := threaded || (displaced && !side)
	switch {
	case b != nil && b.AuthID == authID:
		// A later request served here: one sent before it, answered late elsewhere, is older news.
		b.LastUsed = now
		if at.After(b.At) {
			b.At = at
		}
		delete(s.displaced[key], modelKey(model))
		return
	case b != nil && at.Before(b.At):
		return // sent before the binding was set: it says nothing of where the thread lives now
	case b != nil && !moved, b != nil && b.Reason == switchedReason && !displaced:
		// A late success elsewhere, a thread on the old account answering after the user switched,
		// leaves the account the user chose: it moves only once that one stops being offered.
		return
	case b == nil && canonical != root && !threaded:
		return
	}
	delete(s.displaced[key], modelKey(model))
	reason := s.classifyLocked(s.creds[authID], model, now).Reason
	if b != nil {
		reason = "previous account unavailable; " + reason
	}
	s.bindings[key] = &Binding{AuthID: authID, Reason: reason, LastUsed: now, At: at}
	s.dirty = true
}

// modelKey is a model as a pick and its usage record both name it: without a context or thinking
// suffix ("[1m]", "(high)"), which one may carry and the other not.
func modelKey(model string) string {
	if i := strings.IndexAny(model, "[("); i >= 0 {
		model = model[:i]
	}
	return strings.ToLower(strings.TrimSpace(model))
}

func (s *State) sessionLocked(root string, now time.Time) *session {
	sess := s.sessions[root]
	if sess == nil {
		sess = &session{}
		s.sessions[root] = sess
	}
	sess.LastSeen = now
	return sess
}

// Candidate is one credential offered by the host for a pick.
type Candidate struct {
	ID       string
	Provider string
}

// PickInput is the part of a scheduler pick the core needs.
type PickInput struct {
	Provider   string
	Providers  []string
	Model      string
	Canonical  string
	Parent     string
	Candidates []Candidate
}

// PickResult is the core's decision. Handled false leaves the pick to the host.
type PickResult struct {
	Handled bool
	AuthID  string
	Reason  string
}

// Pick chooses a credential for one attempt. Every pick with a session id is handled. It never
// changes a binding: the host may still fail this attempt, and only a success moves a thread.
func (s *State) Pick(in PickInput) PickResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.lastActivity = now
	if in.Canonical == "" || len(in.Candidates) == 0 {
		return PickResult{}
	}
	for _, c := range in.Candidates {
		if !Supported(strings.ToLower(c.Provider)) {
			return PickResult{}
		}
	}
	offered := map[string]bool{}
	for _, c := range in.Candidates {
		s.credLocked(c.ID, c.Provider)
		offered[c.ID] = true
	}
	root := RootSession(in.Canonical, in.Parent)
	s.sessionLocked(root, now)
	key, b := s.boundLocked(pickProviders(in), in.Canonical, root)
	best := s.rankLocked(in.Candidates, in.Model, now, true)[0]
	bound := b != nil && offered[b.AuthID]
	refused := bound && s.refusedLocked(b, best, in.Model, now)
	if bound && !refused && !s.moveIdleLocked(b, best, in.Model, now) {
		b.LastUsed = now
		delete(s.displaced[key], modelKey(in.Model))
		return PickResult{Handled: true, AuthID: b.AuthID, Reason: b.Reason}
	}
	reason := best.Reason
	switch {
	case refused, b != nil && !bound:
		reason = "previous account unavailable; " + reason
	case bound:
		reason = "moved while idle; " + reason
	}
	if b != nil {
		if s.displaced[key] == nil {
			s.displaced[key] = map[string]bool{}
		}
		s.displaced[key][modelKey(in.Model)] = true
	}
	return PickResult{Handled: true, AuthID: best.ID, Reason: reason}
}

// refusedLocked tells whether a bound session leaves an account that is read as used up and has
// since turned a request away. The host offers such an account again until a cooldown of its own
// starts, and every try costs the request a round trip, so a ready account takes the session at
// once. It holds for a session the user switched too: the account cannot serve it.
func (s *State) refusedLocked(b *Binding, best Ranked, model string, now time.Time) bool {
	c := s.creds[b.AuthID]
	if c == nil || c.refusedAt.IsZero() || best.Blocked || best.ID == b.AuthID {
		return false
	}
	return s.classifyLocked(c, model, now).Blocked
}

// moveIdleLocked tells whether a bound session moves now: idle for longer than a prompt cache
// lives, so the move costs nothing, on an account it would no longer be given while a ready one
// is offered. A session the user switched stays where they put it.
func (s *State) moveIdleLocked(b *Binding, best Ranked, model string, now time.Time) bool {
	if b.Reason == switchedReason || now.Sub(b.LastUsed) < cacheGone || best.Tier != 1 || best.ID == b.AuthID {
		return false
	}
	return s.classifyLocked(s.creds[b.AuthID], model, now).Tier == 3
}

// boundLocked returns the thread's own binding, else the one of its main session, with its key.
func (s *State) boundLocked(providers []string, canonical, root string) (string, *Binding) {
	for _, id := range []string{canonical, root} {
		for _, p := range providers {
			if b := s.bindings[p+"|"+id]; b != nil {
				return p + "|" + id, b
			}
		}
	}
	return "", nil
}

func pickProviders(in PickInput) []string {
	if in.Provider != "" {
		return []string{strings.ToLower(in.Provider)}
	}
	out := make([]string, 0, len(in.Providers))
	for _, p := range in.Providers {
		out = append(out, strings.ToLower(p))
	}
	sort.Strings(out)
	return out
}

// FallbackPick is used when deciding panicked: the first candidate by id.
func FallbackPick(cands []Candidate) string {
	if len(cands) == 0 {
		return ""
	}
	ids := make([]string, 0, len(cands))
	for _, c := range cands {
		ids = append(ids, c.ID)
	}
	sort.Strings(ids)
	return ids[0]
}

// Ranked is one credential in routing order.
type Ranked struct {
	ID      string
	Tier    int // 1 ready, 2 unknown, 3 limited
	Reason  string
	Blocked bool      // known to be unable to serve right now
	BackAt  time.Time // when the window that limits it resets; zero when none or unknown
	reset   time.Time
}

// rankLocked orders candidates for a model: by tier, an account that can serve before one that
// cannot, the soonest reset among the ready. offered says the host offered them for this model, so
// a cooldown it reports on some other model says nothing of them.
func (s *State) rankLocked(cands []Candidate, model string, now time.Time, offered bool) []Ranked {
	out := make([]Ranked, 0, len(cands))
	for _, cand := range cands {
		c := s.credLocked(cand.ID, cand.Provider)
		out = append(out, s.classify(c, model, now, offered))
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Tier != b.Tier {
			return a.Tier < b.Tier
		}
		if a.Blocked != b.Blocked {
			return b.Blocked
		}
		if a.Tier == 1 && !a.reset.Equal(b.reset) {
			return a.reset.Before(b.reset)
		}
		return a.ID < b.ID
	})
	return out
}

// effective returns a window's remaining fraction and next reset as of now, and whether it is
// fresh enough to rank on. A window whose reset passed is shown as full but is not fresh: only
// a new observation says what the account has now.
func (s *State) effective(c *Cred, kind string, now time.Time) (rem float64, reset time.Time, present, fresh bool) {
	c.settle(kind, now)
	w, ok := c.Windows[kind]
	if !ok {
		return 0, time.Time{}, false, false
	}
	if !w.ResetAt.IsZero() && !now.Before(w.ResetAt) {
		// A weekly window runs on a fixed schedule. A 5-hour window starts at the next use, so
		// its next reset is unknown until a reading comes.
		if kind == KindFiveHour {
			return 1, time.Time{}, true, false
		}
		return 1, NextWeeklyReset(w.ResetAt, now), true, false
	}
	return w.Remaining, w.ResetAt, true, now.Sub(w.ObservedAt) <= s.cfg.staleAfter()
}

// NextWeeklyReset is the first reset of a weekly window after now, given one reset of it: a
// weekly window runs on a fixed schedule, so one that ended rolls on by whole weeks.
func NextWeeklyReset(reset, now time.Time) time.Time {
	if now.Before(reset) {
		return reset
	}
	const week = 7 * 24 * time.Hour
	return reset.Add((now.Sub(reset)/week + 1) * week)
}

func (s *State) classifyLocked(c *Cred, model string, now time.Time) Ranked {
	return s.classify(c, model, now, false)
}

func (s *State) classify(c *Cred, model string, now time.Time, offered bool) Ranked {
	if c == nil {
		return Ranked{Tier: 2, Reason: "quota unknown"}
	}
	r := Ranked{ID: c.ID}
	if c.Disabled {
		r.Tier, r.Reason, r.Blocked = 3, "disabled", true
		return r
	}
	weekly, weeklyReset, weeklyPresent, weeklyFresh := s.effective(c, KindWeekly, now)
	five, fiveReset, fivePresent, fiveFresh := s.effective(c, KindFiveHour, now)
	// A fresh window at zero blocks on its own, whatever the other windows say.
	switch {
	case weeklyPresent && weeklyFresh && weekly <= 0:
		r.Tier, r.Reason, r.Blocked, r.BackAt = 3, "weekly quota used up", true, weeklyReset
		return r
	case fivePresent && fiveFresh && five <= 0:
		r.Tier, r.Reason, r.Blocked, r.BackAt = 3, "5-hour quota used up", true, fiveReset
		return r
	}
	// A model with a weekly window of its own (Fable) draws on it: it blocks when used up, and its
	// reset, not the account's, says which quota would expire unused first.
	ready, readyReset := "weekly quota resets soonest", weeklyReset
	if bucket := ModelBucket(model); bucket != "" && c.Provider == "claude" {
		if rem, reset, present, fresh := s.effective(c, bucket, now); present && !fresh {
			r.Tier, r.Reason = 2, "quota unknown"
			return r
		} else if present {
			if rem <= 0 {
				r.Tier, r.Reason, r.Blocked, r.BackAt = 3, windowLabel(bucket)+" quota used up", true, reset
				return r
			}
			ready, readyReset = windowLabel(bucket)+" quota resets soonest", reset
		}
	}
	needFive := c.Provider == "claude" || fivePresent
	switch {
	case !offered && c.Unavailable && now.Before(c.NextRetryAfter):
		r.Tier, r.Reason = 2, "cooling down on some model"
		return r
	case !weeklyPresent || !weeklyFresh || (needFive && (!fivePresent || !fiveFresh)):
		r.Tier, r.Reason = 2, "quota unknown"
		return r
	case fivePresent && math.Round(five*1e4)/100 < s.cfg.MinFiveHourLeftPercent && (fiveReset.IsZero() || fiveReset.Sub(now) > fiveRefillSoon):
		// Too little left to start a session on, and not refilled soon.
		r.Tier, r.Reason, r.BackAt = 3, "5-hour quota low", fiveReset
		return r
	}
	r.Tier, r.Reason, r.reset = 1, ready, readyReset
	return r
}

func (s *State) sweepLocked(now time.Time) {
	for k, b := range s.bindings {
		if now.Sub(b.LastUsed) > b.ttl() {
			delete(s.bindings, k)
			delete(s.displaced, k)
			s.dirty = true
		}
	}
	chosen := s.chosenLocked()
	for root, sess := range s.sessions {
		if now.Sub(sess.LastSeen) > sessionTTL && !chosen[root] {
			delete(s.sessions, root)
			s.dirty = true
		}
	}
	for root, r := range s.routes {
		if now.Sub(r.At) > r.ttl() {
			delete(s.routes, root)
			s.dirty = true
		}
	}
	for id, tr := range s.traces {
		if now.Sub(tr.At) > traceTTL {
			delete(s.traces, id)
		}
	}
}

// chosenLocked names the sessions with an account or a route the user chose: each is kept as long
// as that choice, so the key that started it still owns it.
func (s *State) chosenLocked() map[string]bool {
	chosen := map[string]bool{}
	for k, b := range s.bindings {
		if _, root, ok := strings.Cut(k, "|"); ok && b.Reason == switchedReason {
			chosen[root] = true
		}
	}
	for root, r := range s.routes {
		if !r.Auto {
			chosen[root] = true
		}
	}
	return chosen
}

// Sweep drops expired bindings, sessions, routes and request markers.
func (s *State) Sweep() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(s.now())
}
