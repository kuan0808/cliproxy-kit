package core

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// SchemaVersion is the snapshot and command format version.
const SchemaVersion = 1

// Command is a request the band writes into the command directory.
type Command struct {
	CommandID string    `json:"command_id"`
	Session   string    `json:"session"` // Claude Code's own session id
	BootID    string    `json:"boot_id"`
	CreatedAt time.Time `json:"created_at"`
	Action    string    `json:"action"` // switch, route, unroute
	AuthID    string    `json:"auth_id,omitempty"`
	Provider  string    `json:"provider,omitempty"`
	Model     string    `json:"model,omitempty"`
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
	case s.sessions[root] != nil && cmd.CreatedAt.Before(s.sessions[root].LastCommandAt):
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
		s.bindings[c.Provider+"|"+root] = &Binding{AuthID: c.ID, Reason: switchedReason, LastUsed: now}
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

// RejectUnreadable records a command file that never became valid JSON.
func (s *State) RejectUnreadable(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.addAckLocked(Ack{CommandID: name, Status: "rejected", Reason: "unreadable command file", At: s.now()})
}

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
	Provider       string    `json:"provider"`
	Model          string    `json:"model"`
	RequestedModel string    `json:"requested_model,omitempty"`
	RouteNote      string    `json:"route_note,omitempty"`
	AuthID         string    `json:"auth_id"`
	ServedAuthID   string    `json:"served_auth_id,omitempty"`
	AuthLabel      string    `json:"auth_label"`
	BindingReason  string    `json:"binding_reason"`
	Switched       bool      `json:"switched,omitempty"` // the user chose this account
	Route          *Route    `json:"route,omitempty"`
	LastSwitch     *Switch   `json:"last_switch,omitempty"`
	SwitchImminent bool      `json:"switch_imminent"`
	SwitchReason   string    `json:"switch_reason,omitempty"`
	NextAuthID     string    `json:"next_auth_id,omitempty"`
	Totals         Tokens    `json:"totals"`
	Last           Tokens    `json:"last"`
	LastSeen       time.Time `json:"last_seen"`
}

// MaskEmail turns "dana@example.com" into "d•••".
func MaskEmail(email string) string {
	local, _, _ := strings.Cut(email, "@")
	if local == "" {
		return "•••"
	}
	return string([]rune(local)[:1]) + "•••"
}

// Build renders the snapshot and advances the sequence.
func (s *State) Build() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	labels := map[string]string{}
	for provider, cands := range byProvider {
		ranked := s.rankLocked(cands, "", now)
		pv := &ProviderView{Health: s.healthLocked(provider, "", now)}
		for i, r := range ranked {
			c := s.creds[r.ID]
			v := &CredView{ID: c.ID, Index: c.Index, Label: MaskEmail(c.Email), Email: c.Email, Plan: c.Plan, Order: i + 1,
				Tier: r.Tier, Reason: r.Reason, Sessions: sessionsPerCred[c.ID],
				Unavailable: c.Disabled || r.Blocked, Disabled: c.Disabled, BackAt: r.BackAt}
			v.Windows = s.windowViewsLocked(c, now)
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
	return v
}

// fillImminentLocked flags a session whose next turn's account cannot serve it, so the proxy
// will move it, and names the account it will most likely land on. An account that is only
// running low keeps serving the session it holds.
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
		if next := s.rankLocked(cands, model, now)[0]; next.Tier < 3 {
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

func (s *State) contextsLocked() map[string]int {
	out := map[string]int{}
	for k, v := range defaultContextLengths {
		out[k] = v
	}
	for k, v := range s.cfg.ContextLengths {
		out[k] = v
	}
	return out
}

// BuildForBand is the snapshot for a band on another device, read over the network with a
// client key listed in band_tokens. Credential ids are file names that contain the account's
// email, so every reference becomes an opaque id, and internal errors (which may hold paths)
// are left out. Only the asking band's own session is in it, and no acknowledgements: the remote
// band only displays, it never sends commands.
func (s *State) BuildForBand(session string) Snapshot {
	snap := s.Build()
	snap.LastError, snap.Acks = "", []Ack{}
	own := snap.Sessions[session]
	snap.Sessions = map[string]*SessionView{}
	if own != nil {
		snap.Sessions[session] = own
	}
	for _, pv := range snap.Providers {
		for _, c := range pv.Credentials {
			c.ID, c.Email = opaqueID(c.ID), ""
		}
	}
	for _, v := range snap.Sessions {
		v.AuthID, v.ServedAuthID, v.NextAuthID = opaqueID(v.AuthID), opaqueID(v.ServedAuthID), opaqueID(v.NextAuthID)
		if v.LastSwitch != nil {
			sw := *v.LastSwitch
			sw.From, sw.To = opaqueID(sw.From), opaqueID(sw.To)
			v.LastSwitch = &sw
		}
	}
	return snap
}

func opaqueID(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:8])
}

// BandTokenAllowed reports whether token is one of the configured band tokens.
func (s *State) BandTokenAllowed(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if token == "" {
		return false
	}
	for _, t := range s.cfg.BandTokens {
		if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
			return true
		}
	}
	return false
}
