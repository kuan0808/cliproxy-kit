package main

import (
	"cmp"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/tidwall/gjson"
)

// ---- what is known of each session ----

// namedSession is what is known of one session, from whichever source says it: its transcript on
// this machine, the band on any device (in headers with each read of its snapshot, so the proxy's
// request log never holds them), and its own requests. Each source fills what it knows; a field
// one leaves empty keeps what another said.
type namedSession struct {
	Title  string         `json:"title,omitempty"`  // its current title: a rename, else Claude Code's
	Asked  string         `json:"asked,omitempty"`  // its first request, its title until it has one
	Cwd    string         `json:"cwd,omitempty"`    // the folder it started in
	Root   string         `json:"root,omitempty"`   // the repository it runs in, as its device names it
	Repo   string         `json:"repo,omitempty"`   // that repository by its remote, the same on every device
	Origin string         `json:"origin,omitempty"` // what ran it, as sessionInfo.Origin
	Here   bool           `json:"here,omitempty"`   // its transcript is on this machine, so it ran here
	Placed bool           `json:"placed,omitempty"` // its band said where it runs, which only Here overrules
	Remote bool           `json:"remote,omitempty"` // its requests came from another device, so its folders are not here
	Addr   string         `json:"addr,omitempty"`   // that device's address
	Device string         `json:"device,omitempty"` // and its name, where DNS gave one (see deviceName)
	Place  *placedProject `json:"place,omitempty"`  // where its folder was placed here, kept once the folder is gone
	At     int64          `json:"at"`               // when it was last seen, unix milliseconds
}

// placedProject is the project a session's folder was placed in while the folder existed: a
// session in a worktree keeps its project after the worktree is removed.
type placedProject struct {
	Project string `json:"project"`
	Path    string `json:"path"`
	Repo    bool   `json:"repo,omitempty"`
}

var (
	namedMu    sync.Mutex
	named      map[string]namedSession
	namedDirty bool // changed since it was last written
)

func namedPath() string { return filepath.Join(usageDir(), "sessions.json") }

// A session id as Claude Code and Codex name one; anything else is not taken.
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// namedKept is how long what is known of a session is kept: as long as the usage log.
func namedKept(s namedSession, now time.Time) bool {
	return s.At >= now.AddDate(0, -usageMonths, 0).UnixMilli()
}

func loadNamedLocked() {
	if named != nil {
		return
	}
	named = map[string]namedSession{}
	if raw, errRead := os.ReadFile(namedPath()); errRead == nil {
		_ = json.Unmarshal(raw, &named)
	}
	if taken := migrateNamedLocked(); len(taken) > 0 {
		if namedDirty = !saveNamedLocked(); !namedDirty {
			for _, path := range taken {
				_ = os.Remove(path)
			}
		}
	}
	// What has run out leaves the file too, though nothing may be said again.
	namedDirty = trimNamedLocked(time.Now()) || namedDirty
}

// migrateNamedLocked takes what 0.1.6 kept in two files: what sessions said, a band's session
// ("origin": "remote", from another device) with its current title and one named by its requests
// with its first, and where each session's folder was placed; what the store knows already stays.
// It returns the files it read whole, to remove once the store is written; one it could not read
// stays, and is tried again at the next start.
func migrateNamedLocked() (taken []string) {
	read := func(name string, into any) {
		path := filepath.Join(usageDir(), name)
		if raw, errRead := os.ReadFile(path); errRead == nil && json.Unmarshal(raw, into) == nil {
			taken = append(taken, path)
		}
	}
	var said map[string]namedSession
	var places map[string]placedProject
	read("named-sessions.json", &said)
	read("projects.json", &places)
	for id, s := range said {
		if s.Origin == "remote" {
			s.Origin, s.Remote, s.Placed = "", true, s.Cwd != ""
		} else {
			s.Title, s.Asked = "", s.Title
		}
		// What the store says already wins; what only the old file says fills in.
		cur, had := named[id]
		if !had {
			named[id] = s
			continue
		}
		cur.Title, cur.Asked = cmp.Or(cur.Title, s.Title), cmp.Or(cur.Asked, s.Asked)
		cur.Cwd, cur.Root, cur.Origin = cmp.Or(cur.Cwd, s.Cwd), cmp.Or(cur.Root, s.Root), cmp.Or(cur.Origin, s.Origin)
		cur.Remote, cur.Placed, cur.At = cur.Remote || s.Remote, cur.Placed || s.Placed, max(cur.At, s.At)
		named[id] = cur
	}
	now := time.Now().UnixMilli()
	for id, p := range places {
		s, had := named[id]
		if !had {
			s.At = now
		}
		if s.Place == nil {
			s.Place = &p
		}
		named[id] = s
	}
	return taken
}

// trimNamedLocked drops what has run out and, past the bound on what clients can make the store
// hold (far more sessions than three months bring), what was seen least lately.
func trimNamedLocked(now time.Time) (dropped bool) {
	for id, s := range named {
		if !namedKept(s, now) {
			delete(named, id)
			dropped = true
		}
	}
	if over := len(named) - namedLimit; over > 0 {
		ids := make([]string, 0, len(named))
		for id := range named {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return named[ids[i]].At < named[ids[j]].At })
		for _, id := range ids[:over] {
			delete(named, id)
		}
		dropped = true
	}
	return dropped
}

var namedLimit = 20000

// saveNamedLocked writes what is known of sessions, whole and at once.
func saveNamedLocked() bool {
	body, errMarshal := json.Marshal(named)
	return errMarshal == nil && writeAtomic(namedPath(), body) == nil
}

// saveNamed writes what is known of sessions when it changed; a write that fails is tried again
// with the next pass of the store loop.
func saveNamed() {
	namedMu.Lock()
	defer namedMu.Unlock()
	if !namedDirty {
		return
	}
	trimNamedLocked(time.Now())
	namedDirty = !saveNamedLocked()
}

// noteSession keeps what a source says of a session: what it says replaces what is known, its
// first request excepted, which stays the one first said, and what it leaves empty keeps what is
// known. Saying only where it runs from notes a known session as still seen. Facts rarely change,
// so the store is written when they do, and at most hourly to note the session is still seen.
func noteSession(id string, next namedSession, now time.Time) {
	if !sessionID.MatchString(id) {
		return
	}
	namedMu.Lock()
	defer namedMu.Unlock()
	loadNamedLocked()
	old, had := named[id]
	if !had && next.Title == "" && next.Asked == "" && next.Cwd == "" && next.Root == "" && next.Repo == "" {
		return
	}
	s := old
	if next.Title != "" {
		s.Title = next.Title
	}
	if s.Asked == "" {
		s.Asked = next.Asked
	}
	if next.Cwd != "" {
		s.Cwd = next.Cwd
	}
	if next.Root != "" {
		s.Root = next.Root
	}
	if next.Repo != "" {
		s.Repo = next.Repo
	}
	if next.Origin != "" {
		s.Origin = next.Origin
	}
	s.Remote = s.Remote || next.Remote
	s.Here = s.Here || next.Here
	s.Placed = s.Placed || next.Placed
	if next.Addr != "" {
		s.Addr = next.Addr
	}
	if next.Device != "" {
		s.Device = next.Device
	}
	if had && s == old && now.UnixMilli()-old.At < time.Hour.Milliseconds() {
		return
	}
	s.At = now.UnixMilli()
	named[id], namedDirty = s, true
}

// namedKnown is what is known of a session so far.
func namedKnown(id string) namedSession {
	namedMu.Lock()
	defer namedMu.Unlock()
	loadNamedLocked()
	return named[id]
}

// rememberProject keeps where a session's folder was placed while the folder exists.
func rememberProject(id string, p placedProject) {
	namedMu.Lock()
	defer namedMu.Unlock()
	loadNamedLocked()
	if s, ok := named[id]; ok && (s.Place == nil || *s.Place != p) {
		s.Place = &p
		named[id], namedDirty = s, true
	}
}

// namedMeta is a session's title and project as it is known. A session that ran here, as one with
// its transcript here or a local Codex session, is placed by its folder while that is here or was.
// One its band placed, unless its transcript is here, and one that ran on another device or in a
// folder this machine cannot look up (a Windows path, a share, which a lookup would reach over the
// network), is placed as its device named it: a client that reaches the proxy directly looks like
// this machine, and the same path here may be another folder. Its device is named as DNS names its
// address now, else as it last did.
func namedMeta(id string) (sessionInfo, bool) {
	namedMu.Lock()
	loadNamedLocked()
	s, ok := named[id]
	namedMu.Unlock()
	if !ok || !namedKept(s, time.Now()) {
		return sessionInfo{}, false
	}
	info := sessionInfo{Title: s.Title, Origin: s.Origin, Remote: s.Remote, Device: s.Device, Repository: s.Repo}
	if info.Title == "" {
		info.Title = s.Asked
	}
	if s.Addr != "" {
		info.addr, info.Device = s.Addr, cmp.Or(deviceName(s.Addr), s.Device)
	}
	ranHere := !s.Remote && (s.Here || !s.Placed)
	if strings.HasPrefix(s.Cwd, "/") && !strings.HasPrefix(s.Cwd, "//") && ranHere && placeSession(id, s.Cwd, s.Place, &info) {
		return info, true
	}
	if p := s.Place; p != nil && ranHere {
		info.Path, info.Repo, info.Project = p.Path, p.Repo, p.Project
		return info, true
	}
	info.Path, info.Repo = s.Root, s.Root != ""
	if info.Path == "" {
		info.Path = s.Cwd
	}
	if info.Path != "" {
		info.Project = projectName(info.Path)
	}
	return info, true
}

// ---- what the band says ----

// noteBandSession takes what the band says of its session, from the device it runs on: its
// title, the folder it started in, its repository's root there and remote, and, by where its read
// came from, which other device that is.
func noteBandSession(h http.Header, now time.Time) {
	repo := cleanText(headerText(h, "X-Band-Repo"), 200)
	if !repoName.MatchString(repo) {
		repo = ""
	}
	where := deviceOf(h)
	where.Title = cleanText(headerText(h, "X-Band-Title"), 200)
	where.Cwd = cleanPath(headerText(h, "X-Band-Cwd"))
	where.Root = cleanPath(headerText(h, "X-Band-Root"))
	where.Repo, where.Placed = repo, where.Cwd != ""
	noteSession(headerText(h, "X-Band-Session"), where, now)
}

// deviceOf is where a request came from: another device, its address and its name where known.
func deviceOf(h http.Header) namedSession {
	addr := otherDevice(h)
	if addr == "" {
		return namedSession{}
	}
	return namedSession{Remote: true, Addr: addr, Device: deviceName(addr)}
}

// A repository by its remote, as the band names one: "github.com/owner/name".
var repoName = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*/[^\s/.][^\s]*$`)

// headerText is one of the band's headers, escaped as encodeURIComponent does.
func headerText(h http.Header, name string) string {
	v, errUnescape := url.PathUnescape(h.Get(name))
	if errUnescape != nil {
		return ""
	}
	return v
}

// cleanText keeps a title to one line of printable text, at most max characters.
func cleanText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > max {
		s = string(r[:max])
	}
	return s
}

// cleanPath keeps an absolute path, else nothing: a POSIX one as it is, a Windows one (a drive's,
// C:\work, or a share's, \\server\share) with forward slashes, so its folders are told apart the
// same way here.
func cleanPath(s string) string {
	if len(s) > 1024 || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return ""
	}
	drive := len(s) > 2 && s[1] == ':' && (s[2] == '\\' || s[2] == '/')
	share := strings.HasPrefix(s, `\\`) || strings.HasPrefix(s, "//")
	switch {
	case drive || share:
		return strings.ReplaceAll(s, `\`, "/")
	case strings.HasPrefix(s, "/"):
		return s
	}
	return ""
}

// ---- what a session's requests say ----

var (
	envCwd    = regexp.MustCompile(`<cwd>([^<]+)</cwd>`)
	promptCwd = regexp.MustCompile(`(?m)^[\s>*-]*(?:Primary working directory|Working directory):\s*(.+?)\s*$`)
	entryOf   = regexp.MustCompile(`\(external, ([a-z-]+)\)`)
)

// noteRequestSession names a session from what its requests say, so a session is named from
// whatever machine it runs on: the folder it runs in, its first request (see noteSession), what
// started it, and whether it came from another device. Its transcript on this machine or the band
// gives its current title where there is one. A session known already is only noted as still
// seen, so what is known of it lasts as long as it runs.
func noteRequestSession(id, format string, headers http.Header, body []byte, now time.Time) {
	if id == "" {
		return
	}
	where := deviceOf(headers)
	if known := namedKnown(id); (known.Title != "" || known.Asked != "") && known.Cwd != "" {
		noteSession(id, where, now) // only where it runs from: what another source said meanwhile stays
		return
	}
	var cwd, origin string
	var texts []string
	switch format {
	case "openai-response":
		cwd, texts, origin = codexSays(headers, body)
	case "claude":
		cwd, texts, origin = claudeSays(headers, body)
	default:
		return
	}
	where.Asked, where.Cwd, where.Origin = requestTitle(texts), cwd, origin
	noteSession(id, where, now)
}

// codexSays reads a Responses API request as Codex sends it: the folder in its environment
// context, the user's texts, and what started it from its originator.
func codexSays(headers http.Header, body []byte) (cwd string, texts []string, origin string) {
	gjson.GetBytes(body, "input").ForEach(func(_, item gjson.Result) bool {
		if item.Get("role").String() == "user" {
			for _, text := range textsOf(item.Get("content")) {
				if m := envCwd.FindStringSubmatch(text); m != nil && strings.HasPrefix(strings.TrimSpace(text), "<environment_context>") {
					cwd = cleanPath(strings.TrimSpace(m[1])) // kept as said; namedMeta decides whether to look it up
				} else {
					texts = append(texts, text)
				}
			}
		}
		return true
	})
	origin = cleanText(headers.Get("Originator"), 64)
	if origin == "" {
		origin, _, _ = strings.Cut(cleanText(headers.Get("User-Agent"), 64), "/")
	}
	return cwd, texts, origin
}

// claudeSays reads a Messages API request as Claude Code sends it: the folder in its system
// prompt, the texts of its first message, and how it was run from its User-Agent
// ("claude-cli/2.1.288 (external, sdk-ts)"), "" for the interactive CLI.
func claudeSays(headers http.Header, body []byte) (cwd string, texts []string, origin string) {
	system := strings.Join(textsOf(gjson.GetBytes(body, "system")), "\n")
	if m := promptCwd.FindStringSubmatch(system); m != nil {
		cwd = cleanPath(m[1])
	}
	if first := gjson.GetBytes(body, "messages.0"); first.Get("role").String() == "user" {
		texts = textsOf(first.Get("content"))
	}
	if m := entryOf.FindStringSubmatch(headers.Get("User-Agent")); m != nil && m[1] != "cli" {
		origin = m[1]
	}
	return cwd, texts, origin
}

// textsOf is a content field's texts: the field itself when a string, else its parts' texts.
func textsOf(content gjson.Result) []string {
	if content.Type == gjson.String {
		return []string{content.String()}
	}
	var texts []string
	content.ForEach(func(_, part gjson.Result) bool {
		if text := part.Get("text"); text.Exists() {
			texts = append(texts, text.String())
		}
		return true
	})
	return texts
}
