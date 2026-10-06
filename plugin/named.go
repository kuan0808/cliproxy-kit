package main

import (
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

// ---- sessions named by what reaches the proxy ----

// namedSession is what the proxy is told of a session whose transcript it cannot read: the band
// on another machine says what its Claude Code session is, in headers with each read of its
// snapshot (headers, not the query string, so the proxy's request log never holds them), and a
// Codex session says it in its first request.
type namedSession struct {
	Title  string `json:"title,omitempty"`
	Cwd    string `json:"cwd,omitempty"`
	Root   string `json:"root,omitempty"` // the repository it runs in, when the band knows it
	Origin string `json:"origin"`         // originRemote for a band's session; else what started it
	At     int64  `json:"at"`             // when it was last said, unix milliseconds
}

// originRemote marks a Claude Code session the band on another machine named.
const originRemote = "remote"

var (
	namedMu    sync.Mutex
	named      map[string]namedSession
	namedDirty bool
)

func namedPath() string { return filepath.Join(usageDir(), "named-sessions.json") }

// A session id as Claude Code and Codex name one; anything else is not taken.
var sessionID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// namedKept is how long what a session said is kept: as long as the usage log.
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
	// What has run out leaves the file too, though nothing may be said again.
	if trimNamedLocked(time.Now()) {
		saveNamedLocked()
	}
}

// trimNamedLocked drops what has run out and, past the bound on what clients can make the store
// hold (far more sessions than three months bring), what was said least lately.
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

// saveNamedLocked writes what sessions said, whole and at once; a write that fails is tried again
// with the next change.
func saveNamedLocked() {
	body, errMarshal := json.Marshal(named)
	if errMarshal != nil {
		return
	}
	_ = os.MkdirAll(usageDir(), 0o700)
	tmp := namedPath() + ".tmp"
	namedDirty = !(os.WriteFile(tmp, body, 0o600) == nil && os.Rename(tmp, namedPath()) == nil)
}

// noteSession keeps what a session says of itself. What it says less keeps what is known: the band
// may ask before it has read a title, and a session's folder comes with every read. A session
// named by its requests keeps its first title, as a later request may carry only its newest
// message; the band's title is the session's current one. A session's facts rarely change, so the
// file is written when they do, and at most hourly to note it is still seen.
func noteSession(id string, next namedSession, now time.Time) {
	if !sessionID.MatchString(id) || (next.Title == "" && next.Cwd == "" && next.Root == "") {
		return
	}
	next.At = now.UnixMilli()
	namedMu.Lock()
	defer namedMu.Unlock()
	loadNamedLocked()
	old, had := named[id]
	if next.Title == "" || (next.Origin != originRemote && old.Title != "") {
		next.Title = old.Title
	}
	if next.Cwd == "" {
		next.Cwd, next.Root = old.Cwd, old.Root
	}
	changed := !had || old.Title != next.Title || old.Cwd != next.Cwd || old.Root != next.Root || old.Origin != next.Origin
	if !changed && !namedDirty && now.UnixMilli()-old.At < time.Hour.Milliseconds() {
		return
	}
	named[id] = next
	trimNamedLocked(now)
	saveNamedLocked()
}

// namedKnown is what a session has said of itself so far.
func namedKnown(id string) namedSession {
	namedMu.Lock()
	defer namedMu.Unlock()
	loadNamedLocked()
	return named[id]
}

// namedMeta is a session's title and project as it was named. A band's session runs on another
// machine, so its folders are placed as given; any other, as a Codex session, is placed like a
// local one when its folder is here.
func namedMeta(id string) (sessionInfo, bool) {
	namedMu.Lock()
	loadNamedLocked()
	s, ok := named[id]
	if ok && !namedKept(s, time.Now()) {
		delete(named, id)
		saveNamedLocked()
		ok = false
	}
	namedMu.Unlock()
	if !ok {
		return sessionInfo{}, false
	}
	info := sessionInfo{Title: s.Title, Origin: s.Origin}
	if s.Origin != originRemote {
		if s.Cwd != "" {
			placeSession(id, s.Cwd, &info)
		}
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

// ---- what the band on another machine says ----

// noteBandSession takes what a band with a band key says of its session.
func noteBandSession(h http.Header, now time.Time) {
	noteSession(headerText(h, "X-Band-Session"), namedSession{
		Title:  cleanText(headerText(h, "X-Band-Title"), 200),
		Cwd:    cleanPath(headerText(h, "X-Band-Cwd")),
		Root:   cleanPath(headerText(h, "X-Band-Root")),
		Origin: originRemote,
	}, now)
}

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

// ---- what a Codex session's requests say ----

var envCwd = regexp.MustCompile(`<cwd>([^<]+)</cwd>`)

// noteRequestSession names a session from a Responses API request, as Codex sends: the folder in
// its environment context, its first request (see noteSession), and what started it from the
// client's originator.
func noteRequestSession(id string, headers http.Header, body []byte, now time.Time) {
	input := gjson.GetBytes(body, "input")
	if id == "" || !input.IsArray() {
		return
	}
	known := namedKnown(id)
	if known.Title != "" && known.Cwd != "" {
		return
	}
	var cwd string
	var texts []string
	read := func(text string) {
		if m := envCwd.FindStringSubmatch(text); m != nil && strings.HasPrefix(strings.TrimSpace(text), "<environment_context>") {
			// The folder is looked up on this machine, so only a local absolute path is taken:
			// never a share (//server, \\server), which a lookup would reach over the network.
			if p := strings.TrimSpace(m[1]); strings.HasPrefix(p, "/") && !strings.HasPrefix(p, "//") {
				cwd = cleanPath(p)
			}
			return
		}
		texts = append(texts, text)
	}
	input.ForEach(func(_, item gjson.Result) bool {
		if item.Get("role").String() != "user" {
			return true
		}
		if content := item.Get("content"); content.Type == gjson.String {
			read(content.String())
		} else {
			content.ForEach(func(_, part gjson.Result) bool {
				read(part.Get("text").String())
				return true
			})
		}
		return true
	})
	title := requestTitle(texts)
	origin := cleanText(headers.Get("Originator"), 64)
	if origin == "" {
		origin, _, _ = strings.Cut(cleanText(headers.Get("User-Agent"), 64), "/")
	}
	noteSession(id, namedSession{Title: title, Cwd: cwd, Origin: origin}, now)
}
