package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// SchemaVersion is the snapshot and command format version.
const SchemaVersion = 1

// Command is a switch, route or back the band sends with a read of its snapshot.
type Command struct {
	CommandID string    `json:"command_id"`
	Session   string    `json:"session"` // Claude Code's own session id
	BootID    string    `json:"boot_id"`
	CreatedAt time.Time `json:"created_at"`
	Action    string    `json:"action"` // switch, route, unroute
	AuthID    string    `json:"auth_id,omitempty"`
	Provider  string    `json:"provider,omitempty"`
	Model     string    `json:"model,omitempty"`
	// Client is who sent it, as the proxy knows its key (see State.Client); never the band's say.
	Client string `json:"-"`
}

// Ack is the outcome of one command, published in the snapshot.
type Ack struct {
	CommandID string    `json:"command_id"`
	Session   string    `json:"session,omitempty"`
	Status    string    `json:"status"` // applied or rejected
	Reason    string    `json:"reason,omitempty"`
	At        time.Time `json:"at"`
}

// Apply runs one command and records its acknowledgement.
func (s *State) Apply(cmd Command) Ack {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	ack := Ack{CommandID: cmd.CommandID, Session: cmd.Session, Status: "rejected", At: now}
	root := rootFromRaw(cmd.Session)
	switch {
	case cmd.CommandID == "" || cmd.Session == "":
		ack.Reason = "missing command id or session"
	case cmd.BootID != s.bootID:
		ack.Reason = "proxy restarted since the command was written"
	case now.Sub(cmd.CreatedAt) > 10*time.Minute:
		ack.Reason = "command too old"
	case s.sessions[root] == nil:
		ack.Reason = "the proxy has not seen this session"
	case !s.sessions[root].Owned || s.sessions[root].Client != cmd.Client:
		ack.Reason = "the session runs on another client key"
	case cmd.CreatedAt.Before(s.sessions[root].LastCommandAt):
		ack.Reason = "superseded by a newer command"
	default:
		sess := s.sessionLocked(root, now)
		ack.Reason = s.applyLocked(cmd, root, sess, now)
		if ack.Reason == "" {
			ack.Status = "applied"
			sess.LastCommandAt = cmd.CreatedAt
		}
	}
	s.addAckLocked(ack)
	return ack
}

func (s *State) applyLocked(cmd Command, root string, sess *session, now time.Time) string {
	switch cmd.Action {
	case "switch":
		// The session's next thread request reaches the new account, which answers that it
		// has no such thread; Claude Code then replays the conversation there once. Subagents
		// already running keep their own threads where they are.
		c := s.creds[cmd.AuthID]
		if c == nil {
			return "unknown account"
		}
		provider, model := s.nextLocked(root, sess)
		if provider != "" && c.Provider != provider {
			return "account belongs to another provider"
		}
		if r := s.classifyLocked(c, model, now); r.Blocked {
			return "account cannot serve now: " + r.Reason
		}
		s.bindings[c.Provider+"|"+root] = &Binding{AuthID: c.ID, Reason: switchedReason, LastUsed: now, At: now}
	case "route":
		if cmd.Provider == "" || cmd.Model == "" {
			return "route needs provider and model"
		}
		s.routes[root] = Route{Provider: strings.ToLower(cmd.Provider), Model: cmd.Model, At: now}
	case "unroute":
		delete(s.routes, root)
		if sess != nil {
			s.noteLocked(sess, "")
		}
	default:
		return "unknown action " + cmd.Action
	}
	s.dirty = true
	return ""
}

// switchedReason marks a binding the user chose.
const switchedReason = "switched by user"

func (s *State) addAckLocked(a Ack) {
	s.acks = append(s.acks, a)
	if len(s.acks) > maxAcks {
		s.acks = s.acks[len(s.acks)-maxAcks:]
	}
	s.dirty = true
}

// Snapshot is the document the band and the panel read.
type Snapshot struct {
	SchemaVersion int                      `json:"schema_version"`
	BootID        string                   `json:"boot_id"`
	Sequence      uint64                   `json:"sequence"`
	GeneratedAt   time.Time                `json:"generated_at"`
	Config        SnapshotConfig           `json:"config"`
	Providers     map[string]*ProviderView `json:"providers"`
	Sessions      map[string]*SessionView  `json:"sessions"`
	Acks          []Ack                    `json:"acks"`
	Contexts      map[string]int           `json:"context_lengths"`
	LastError     string                   `json:"last_error,omitempty"`
	// Expected is, for a band or a Codex hook, the account a new session of each provider gets for
	// the model it names ("" for none), as a pick ranks them.
	Expected map[string]string `json:"expected,omitempty"`
}

// SnapshotConfig exposes the settings the band and panel display.
type SnapshotConfig struct {
	CrossProvider          string            `json:"cross_provider"`
	FallbackMap            map[string]string `json:"fallback_map"`
	MinFiveHourLeftPercent float64           `json:"min_five_hour_left_percent"`
	IdlePollMinutes        int               `json:"idle_poll_minutes"`
}

// ProviderView lists a provider's credentials in routing order.
type ProviderView struct {
	Health      string      `json:"health"` // healthy, exhausted, unknown
	Credentials []*CredView `json:"credentials"`
}

// CredView is one credential as displayed.
type CredView struct {
	ID          string       `json:"id"`
	Index       string       `json:"auth_index"`
	Label       string       `json:"label"`
	Email       string       `json:"email,omitempty"`
	Plan        string       `json:"plan,omitempty"`
	Order       int          `json:"order"`
	Tier        int          `json:"tier"`
	Reason      string       `json:"reason"`
	Sessions    int          `json:"sessions"`
	Unavailable bool         `json:"unavailable,omitempty"` // disabled, or known unable to serve now
	Disabled    bool         `json:"disabled,omitempty"`
	BackAt      time.Time    `json:"back_at,omitempty"` // when the window that limits it resets
	Windows     []WindowView `json:"windows"`
	// Absent names the window kinds the provider said the account does not have, apart from
	// those not read yet.
	Absent []string `json:"absent,omitempty"`
	// SameAs is the credential the proxy also holds that logs in to the same provider account: its
	// quota is that one's, counted once.
	SameAs string `json:"same_as,omitempty"`
}

// WindowView is one window as displayed.
type WindowView struct {
	Kind       string    `json:"kind"`
	Label      string    `json:"label"`
	Remaining  float64   `json:"remaining"`
	ResetAt    time.Time `json:"reset_at,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
	Stale      bool      `json:"stale"`
}

// SessionView is one Claude Code session as displayed, keyed by its raw id. Provider, Model and
// AuthID say where the session's next turn goes: the route's provider and model when routed,
// else the provider of the model it asks for, and the account bound there. ServedAuthID is the
// account that answered its last turn, which differs right after a switch.
type SessionView struct {
	Provider       string  `json:"provider"`
	Model          string  `json:"model"`
	RequestedModel string  `json:"requested_model,omitempty"`
	RouteNote      string  `json:"route_note,omitempty"`
	AuthID         string  `json:"auth_id"`
	ServedAuthID   string  `json:"served_auth_id,omitempty"`
	AuthLabel      string  `json:"auth_label"`
	BindingReason  string  `json:"binding_reason"`
	Switched       bool    `json:"switched,omitempty"` // the user chose this account
	Route          *Route  `json:"route,omitempty"`
	LastSwitch     *Switch `json:"last_switch,omitempty"`
	SwitchImminent bool    `json:"switch_imminent"`
	SwitchReason   string  `json:"switch_reason,omitempty"`
	NextAuthID     string  `json:"next_auth_id,omitempty"`
	// Blocked names the accounts of its provider that cannot serve its next model (used up, also
	// on a model's own window, or disabled): the band does not offer a switch to them.
	Blocked  []string  `json:"blocked,omitempty"`
	Totals   Tokens    `json:"totals"`
	Last     Tokens    `json:"last"`
	LastSeen time.Time `json:"last_seen"`
}

// MaskEmail turns "dana@example.com" into "d•••".
func MaskEmail(email string) string {
	local, _, _ := strings.Cut(email, "@")
	if local == "" {
		return "•••"
	}
	return string([]rune(local)[:1]) + "•••"
}

// UniqueLabels masks each email as MaskEmail does, showing as many leading characters (up to four)
// as it takes to tell it from the others given; ones still alike are numbered, in id order. Keyed
// as given.
func UniqueLabels(emails map[string]string) map[string]string {
	locals := map[string][]rune{}
	ids := make([]string, 0, len(emails))
	for id, email := range emails {
		local, _, _ := strings.Cut(email, "@")
		locals[id] = []rune(local)
		ids = append(ids, id)
	}
	sort.Strings(ids)
	prefix := func(id string, n int) string { return string(locals[id][:min(n, len(locals[id]))]) }
	out, taken := map[string]string{}, map[string]int{}
	for _, id := range ids {
		n := 1
		for ; n < 4; n++ {
			alone := true
			for _, other := range ids {
				if other != id && prefix(other, n) == prefix(id, n) {
					alone = false
					break
				}
			}
			if alone {
				break
			}
		}
		label := prefix(id, n) + "•••"
		if taken[label]++; taken[label] > 1 {
			label = fmt.Sprintf("%s%d", label, taken[label])
		}
		out[id] = label
	}
	return out
}

// labelsLocked names each account of each provider apart from the others (UniqueLabels).
func (s *State) labelsLocked() map[string]string {
	byProvider := map[string]map[string]string{}
	for id, c := range s.creds {
		if byProvider[c.Provider] == nil {
			byProvider[c.Provider] = map[string]string{}
		}
		byProvider[c.Provider][id] = c.Email
	}
	out := map[string]string{}
	for _, emails := range byProvider {
		for id, label := range UniqueLabels(emails) {
			out[id] = label
		}
	}
	return out
}

// Build renders the snapshot and advances the sequence.
func (s *State) Build() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buildLocked()
}

// BuildWithCanonical is the snapshot with the credentials counted under another (see Canonical),
// read together, so a report counts each account once while polls go on.
func (s *State) BuildWithCanonical() (Snapshot, map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buildLocked(), s.canonicalLocked()
}

func (s *State) buildLocked() Snapshot {
	now := s.now()
	s.sweepLocked(now)
	s.sequence++
	snap := Snapshot{
		SchemaVersion: SchemaVersion,
		BootID:        s.bootID,
		Sequence:      s.sequence,
		GeneratedAt:   now.UTC(),
		Config: SnapshotConfig{
			CrossProvider:          s.cfg.CrossProvider,
			FallbackMap:            s.cfg.FallbackMap,
			MinFiveHourLeftPercent: s.cfg.MinFiveHourLeftPercent,
			IdlePollMinutes:        s.cfg.IdlePollMinutes,
		},
		Providers: map[string]*ProviderView{},
		Sessions:  map[string]*SessionView{},
		Acks:      append([]Ack{}, s.acks...),
		Contexts:  s.contextsLocked(),
		LastError: s.lastError,
	}
	// Each session first, so the accounts can count the sessions whose next turn they serve.
	sessions := map[string]*SessionView{}
	sessionsPerCred := map[string]int{}
	for root, sess := range s.sessions {
		if ViewSession(RawSession(root)) == "" {
			continue // a conversation the proxy named by its content: no Claude Code session to show
		}
		v := s.sessionViewLocked(root, sess)
		if v.AuthID != "" && now.Sub(sess.LastSeen) <= activeAfter {
			sessionsPerCred[v.AuthID]++
		}
		s.fillImminentLocked(v, now)
		sessions[root] = v
	}
	byProvider := map[string][]Candidate{}
	for _, c := range s.creds {
		if c.Provider == "" || c.Provider == "unknown" {
			continue
		}
		byProvider[c.Provider] = append(byProvider[c.Provider], Candidate{ID: c.ID, Provider: c.Provider})
	}
	labels, masked, same := map[string]string{}, s.labelsLocked(), s.canonicalLocked()
	for provider, cands := range byProvider {
		ranked := s.rankLocked(cands, "", now, false)
		pv := &ProviderView{Health: s.healthLocked(provider, "", now)}
		for i, r := range ranked {
			c := s.creds[r.ID]
			v := &CredView{ID: c.ID, Index: c.Index, Label: masked[c.ID], Email: c.Email, Plan: c.Plan, Order: i + 1,
				Tier: r.Tier, Reason: r.Reason, Sessions: sessionsPerCred[c.ID],
				Unavailable: c.Disabled || r.Blocked, Disabled: c.Disabled, BackAt: r.BackAt}
			v.Windows = s.windowViewsLocked(c, now)
			for kind := range c.Absent {
				v.Absent = append(v.Absent, kind)
			}
			sort.Strings(v.Absent)
			if to := same[c.ID]; s.creds[to] != nil {
				v.SameAs = to
			}
			pv.Credentials = append(pv.Credentials, v)
			labels[c.ID] = v.Label
		}
		snap.Providers[provider] = pv
	}
	for root, v := range sessions {
		v.AuthLabel = labels[v.AuthID]
		snap.Sessions[RawSession(root)] = v
	}
	return snap
}

// nextLocked is where a session's next turn goes: its route, else the provider of the model it
// asks for, else where its last turn ran.
func (s *State) nextLocked(root string, sess *session) (provider, model string) {
	provider, model = sess.Provider, sess.Model
	if p := ProviderOfModel(sess.RequestedModel); p != "" {
		provider, model = p, sess.RequestedModel
	}
	if r, ok := s.routes[root]; ok {
		provider, model = r.Provider, r.Model
	}
	return provider, model
}

// sessionViewLocked says where a session's next turn goes.
func (s *State) sessionViewLocked(root string, sess *session) *SessionView {
	v := &SessionView{ServedAuthID: sess.ServedAuth,
		RequestedModel: sess.RequestedModel, RouteNote: sess.RouteNote,
		LastSwitch: sess.LastSwitch, Totals: sess.Totals, Last: sess.Last, LastSeen: sess.LastSeen}
	v.Provider, v.Model = s.nextLocked(root, sess)
	if r, ok := s.routes[root]; ok {
		rr := r
		v.Route = &rr
	}
	if b := s.bindings[v.Provider+"|"+root]; b != nil {
		v.AuthID, v.BindingReason, v.Switched = b.AuthID, b.Reason, b.Reason == switchedReason
	} else if c := s.creds[sess.ServedAuth]; c != nil && c.Provider == v.Provider {
		v.AuthID = sess.ServedAuth
	}
	now := s.now()
	for _, c := range s.creds {
		if c.Provider == v.Provider && s.classifyLocked(c, v.Model, now).Blocked {
			v.Blocked = append(v.Blocked, c.ID)
		}
	}
	sort.Strings(v.Blocked)
	return v
}

// fillImminentLocked flags a session whose account is read as unable to serve it, and names the
// account it will most likely land on. An account read as used up often answers a while longer:
// the session stays until it turns a request away, then moves. An account that is only running
// low keeps serving the session it holds.
func (s *State) fillImminentLocked(v *SessionView, now time.Time) {
	c := s.creds[v.AuthID]
	if c == nil {
		return
	}
	model := v.Model
	if v.Route == nil && v.RequestedModel != "" {
		model = v.RequestedModel
	}
	r := s.classifyLocked(c, model, now)
	if !r.Blocked {
		return
	}
	v.SwitchImminent, v.SwitchReason = true, r.Reason
	var cands []Candidate
	for _, other := range s.creds {
		if other.Provider == c.Provider && other.ID != c.ID {
			cands = append(cands, Candidate{ID: other.ID, Provider: other.Provider})
		}
	}
	if len(cands) > 0 {
		if next := s.rankLocked(cands, model, now, false)[0]; next.Tier < 3 {
			v.NextAuthID = next.ID
		}
	}
}

func (s *State) windowViewsLocked(c *Cred, now time.Time) []WindowView {
	kinds := make([]string, 0, len(c.Windows))
	for k := range c.Windows {
		kinds = append(kinds, k)
	}
	sort.Slice(kinds, func(i, j int) bool {
		return kindOrder(kinds[i]) < kindOrder(kinds[j]) || (kindOrder(kinds[i]) == kindOrder(kinds[j]) && kinds[i] < kinds[j])
	})
	out := make([]WindowView, 0, len(kinds))
	for _, k := range kinds {
		w := c.Windows[k]
		rem, reset, _, fresh := s.effective(c, k, now)
		out = append(out, WindowView{Kind: k, Label: windowLabel(k), Remaining: rem, ResetAt: reset, ObservedAt: w.ObservedAt, Stale: !fresh})
	}
	return out
}

func kindOrder(kind string) int {
	switch kind {
	case KindFiveHour:
		return 0
	case KindWeekly:
		return 1
	}
	return 2
}

// Health reports whether a provider can serve a model: healthy, exhausted or unknown.
func (s *State) Health(provider, model string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.healthLocked(provider, model, s.now())
}

// healthLocked is exhausted only when every credential is known to be unable to serve.
func (s *State) healthLocked(provider, model string, now time.Time) string {
	if !s.inventoryLoaded {
		return "unknown"
	}
	any := false
	unknown := false
	for _, c := range s.creds {
		if c.Provider != provider {
			continue
		}
		any = true
		r := s.classifyLocked(c, model, now)
		switch {
		case r.Tier == 2:
			unknown = true
		case !r.Blocked:
			return "healthy"
		}
	}
	if !any || unknown {
		return "unknown"
	}
	return "exhausted"
}

// contextsLocked are the context windows of the models sessions run on through a route, configured
// or by family, for the band to show a routed session's context against.
func (s *State) contextsLocked() map[string]int {
	out := map[string]int{}
	for k, v := range s.cfg.ContextLengths {
		out[k] = v
	}
	var models []string
	for _, r := range s.routes {
		models = append(models, r.Model)
	}
	for _, target := range s.cfg.FallbackMap {
		_, model, _ := strings.Cut(target, ":")
		models = append(models, model)
	}
	for _, model := range models {
		if n := s.contextLengthLocked(model); n > 0 && model != "" {
			out[model] = n
		}
	}
	return out
}

// BuildForBand is the snapshot for a band, read over the network with a client key the proxy
// accepted, and for the session it names when that key may speak of it (see MayName). Credential ids are file names that contain the account's email, so every reference
// becomes an opaque id, and internal errors (which may hold paths) are left out. Only the asking band's own session is in it, with the acknowledgements of its own
// commands (see FromOpaque for the ids they name).
func (s *State) BuildForBand(session, model, client string) Snapshot {
	s.mu.Lock()
	snap := s.buildLocked()
	snap.Expected = s.expectedLocked(model, s.now())
	if !s.mayNameLocked(session, client) {
		session = "" // another key's session: the band sees the accounts, not it
	}
	s.mu.Unlock()
	for p, id := range snap.Expected {
		snap.Expected[p] = opaqueID(id)
	}
	snap.LastError = ""
	acks := []Ack{}
	for _, a := range snap.Acks {
		if a.Session == session {
			acks = append(acks, a)
		}
	}
	snap.Acks = acks
	own := snap.Sessions[session]
	snap.Sessions = map[string]*SessionView{}
	if own != nil {
		snap.Sessions[session] = own
	}
	for _, pv := range snap.Providers {
		for _, c := range pv.Credentials {
			c.ID, c.Email, c.SameAs = opaqueID(c.ID), "", opaqueID(c.SameAs)
		}
	}
	for _, v := range snap.Sessions {
		v.AuthID, v.ServedAuthID, v.NextAuthID = opaqueID(v.AuthID), opaqueID(v.ServedAuthID), opaqueID(v.NextAuthID)
		for i, id := range v.Blocked {
			v.Blocked[i] = opaqueID(id)
		}
		if v.LastSwitch != nil {
			sw := *v.LastSwitch
			sw.From, sw.To = opaqueID(sw.From), opaqueID(sw.To)
			v.LastSwitch = &sw
		}
	}
	return snap
}

// expectedLocked is the account a new session of each provider gets for model: the first a pick
// ranks among those the host offers, taken to be every enabled one. The host also leaves out one
// that does not serve the model or cools down on it, which the plugin does not see: an estimate.
func (s *State) expectedLocked(model string, now time.Time) map[string]string {
	byProvider := map[string][]Candidate{}
	for _, c := range s.creds {
		if Supported(c.Provider) && !c.Disabled {
			byProvider[c.Provider] = append(byProvider[c.Provider], Candidate{ID: c.ID, Provider: c.Provider})
		}
	}
	out := map[string]string{}
	for provider, cands := range byProvider {
		out[provider] = s.rankLocked(cands, model, now, true)[0].ID
	}
	return out
}

// FromOpaque is the account a band names by its opaque id; "" for none the proxy holds.
func (s *State) FromOpaque(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for real := range s.creds {
		if opaqueID(real) == id {
			return real
		}
	}
	return ""
}

func opaqueID(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:8])
}

// clientTTL is how long a client key the proxy accepted keeps reading the quota: one removed from
// the proxy stops within it.
const clientTTL = 7 * 24 * time.Hour

// noteClientLocked remembers the client of a request the proxy accepted, sent at at: its key's
// hash, or "" for a request with no key, which only a proxy without api-keys lets in. A keyed
// request means the proxy asks for keys now, which ends the keyless entry; a keyless one sent
// before it, answered late, does not bring it back. The time moves on at most hourly, so a busy
// client does not rewrite the state with every request.
func (s *State) noteClientLocked(key string, at, now time.Time) {
	id := clientID(key)
	switch {
	case id != "":
		if at.After(s.keyedAt) {
			s.keyedAt = at
			s.dirty = true
		}
		if _, open := s.clients[""]; open {
			delete(s.clients, "")
			s.dirty = true
		}
	case !at.After(s.keyedAt):
		return
	}
	if seen, ok := s.clients[id]; !ok || now.Sub(seen) > time.Hour {
		s.clients[id] = now
		s.dirty = true
	}
}

// Client is who key is to the proxy, when it accepted that key for a request within clientTTL:
// the band on any device, and a Codex hook, read the quota with the key their client already
// sends. While the proxy asks for no api-keys every key is the keyless client "", as the requests
// it serves are, a key it accepted before included.
func (s *State) Client(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for _, id := range []string{"", clientID(key)} {
		if seen, ok := s.clients[id]; ok && now.Sub(seen) <= clientTTL {
			return id, true
		}
	}
	return "", false
}

// MayName tells whether client may speak of a session (name it, be told of it): the key that
// started it may, and anyone may of one the proxy has not seen, or one started with no key.
func (s *State) MayName(session, client string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mayNameLocked(session, client)
}

func (s *State) mayNameLocked(session, client string) bool {
	sess := s.sessions[rootFromRaw(session)]
	return sess == nil || !sess.Owned || sess.Client == client
}

// clientID is a client key as the state keeps it: its hash, never the key; "" for none.
func clientID(key string) string {
	if key == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}
