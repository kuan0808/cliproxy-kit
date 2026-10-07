package main

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // the page's time zone loads where the system has no zone database, as in a slim container
	"unicode"

	"github.com/kuan0808/cliproxy-kit/plugin/core"
)

// The usage log on disk: one JSON line per request or poll, one file per month, kept for about
// three months.

const usageMonths = 3

// usageDays is how far back the usage view reads: the longest range, 30 days, and the week before
// it, where the walk across an account's windows begins.
const usageDays = 38

func usageDir() string {
	dir := filepath.Join(kitDir(), "usage")
	_ = os.MkdirAll(dir, 0o700)
	return dir
}

// logMu makes each append, and the cut-back of one that failed part way, whole: a cut-back to the
// size before it never takes lines another writer added meanwhile.
var logMu sync.Mutex

// appendLog writes pending log lines to their month's file; lines it could not write go back to
// the queue for the next pass.
func appendLog(entries []core.LogEntry) {
	if failed := appendLines("", entries); len(failed) > 0 {
		state.ReturnLog(failed)
	}
}

// appendLines writes lines to the files named prefix + month and returns the lines of each month
// it could not write.
func appendLines(prefix string, entries []core.LogEntry) (failed []core.LogEntry) {
	logMu.Lock()
	defer logMu.Unlock()
	byMonth := map[string][]core.LogEntry{}
	for _, e := range entries {
		month := time.UnixMilli(e.T).Format("2006-01")
		byMonth[month] = append(byMonth[month], e)
	}
	for month, lines := range byMonth {
		var body []byte
		for _, e := range lines {
			line, errMarshal := json.Marshal(e)
			if errMarshal == nil {
				body = append(append(body, line...), '\n')
			}
		}
		if errWrite := appendFile(filepath.Join(usageDir(), prefix+month+".jsonl"), body); errWrite != nil {
			state.NoteError("usage log: " + errWrite.Error())
			if !errors.Is(errWrite, errUndone) {
				failed = append(failed, lines...)
			}
		}
	}
	return failed
}

// errUndone is a write that failed part way and could not be cut back: retrying it could write a
// line twice, so its lines are let go.
var errUndone = errors.New("a write failed part way and could not be undone; its lines are lost")

// appendFile adds body to the file whole or not at all: a write that stops part way is cut back,
// so a retry leaves neither a broken line nor a line twice. Once the body is on disk the write
// stands, whatever closing the file says.
func appendFile(path string, body []byte) error {
	f, errOpen := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if errOpen != nil {
		return errOpen
	}
	defer f.Close()
	info, errStat := f.Stat()
	if errStat != nil {
		return errStat
	}
	_, errWrite := f.Write(body)
	if errWrite == nil {
		errWrite = f.Sync()
	}
	if errWrite != nil && f.Truncate(info.Size()) != nil {
		return errUndone
	}
	return errWrite
}

// pruneLog removes month files older than usageMonths.
func pruneLog(now time.Time) {
	oldest := now.AddDate(0, -usageMonths, 0).Format("2006-01")
	files, _ := filepath.Glob(filepath.Join(usageDir(), "20*.jsonl"))
	for _, f := range files {
		if strings.TrimSuffix(filepath.Base(f), ".jsonl") < oldest {
			_ = os.Remove(f)
		}
	}
}

// readLog returns the log lines since `since` and when the log began.
func readLog(since time.Time) (entries []core.LogEntry, logStart int64) {
	files, _ := filepath.Glob(filepath.Join(usageDir(), "20*.jsonl"))
	sort.Strings(files)
	first := since.Format("2006-01")
	for i, f := range files {
		month := strings.TrimSuffix(filepath.Base(f), ".jsonl")
		if i > 0 && month < first {
			continue
		}
		for _, e := range readEntries(f) {
			if logStart == 0 || e.T < logStart {
				logStart = e.T
			}
			if e.T >= since.UnixMilli() {
				entries = append(entries, e)
			}
		}
	}
	if logStart == 0 {
		logStart = time.Now().UnixMilli()
	}
	return entries, logStart
}

func readEntries(path string) []core.LogEntry {
	f, errOpen := os.Open(path)
	if errOpen != nil {
		return nil
	}
	defer f.Close()
	var out []core.LogEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var e core.LogEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}

// ---- sessions: project and title ----

type sessionInfo struct {
	Project    string // the project's name as shown
	Path       string // the project's folder: the repository root, or the session's folder outside one
	Repo       bool   // Path is a repository, so subfolders of it are not projects of their own
	Repository string // the repository by its remote, as the band names it, the same on every device
	Title      string
	Origin     string // what ran it: Claude Code's entrypoint when not the CLI, or Codex's originator
	Remote     bool   // it ran on another device, as its requests said
	Device     string // that device's name, where known
	addr       string // and its address, which tells devices apart where names may not
}

// fileStamp tells a file that changed from one that did not.
type fileStamp struct{ size, mod int64 }

var (
	metaMu      sync.Mutex
	transcripts = map[string]string{}    // session id to transcript path
	readStamps  = map[string]fileStamp{} // each transcript as it was last read
	indexedAt   time.Time
)

var (
	cwdField    = regexp.MustCompile(`"cwd":"((?:[^"\\]|\\.)*)"`)
	titleField  = regexp.MustCompile(`"aiTitle":"((?:[^"\\]|\\.)*)"`)
	customField = regexp.MustCompile(`"customTitle":"((?:[^"\\]|\\.)*)"`)
	entryField  = regexp.MustCompile(`"entrypoint":"([a-z-]+)"`)
)

// sessionMeta is a session's title and project for the report: what its transcript here says,
// read again once it changed, over what the band and its requests said (see noteSession).
func sessionMeta(id string) sessionInfo {
	if id == "" {
		return sessionInfo{}
	}
	noteTranscript(id)
	info, _ := namedMeta(id)
	return info
}

// noteTranscript reads a session's transcript on this machine, when it changed since it was last
// read, for its folder, how Claude Code was run, its title (the name the user gave it, else Claude
// Code's latest) and its first request. It is read outside the lock, so a report over hundreds of
// sessions reads only the ones that went on.
func noteTranscript(id string) {
	metaMu.Lock()
	path, ok := transcripts[id]
	if !ok && time.Since(indexedAt) > time.Minute {
		indexTranscripts()
		path, ok = transcripts[id]
	}
	last := readStamps[id]
	metaMu.Unlock()
	st, errStat := os.Stat(path)
	if !ok || errStat != nil {
		return
	}
	stamp := fileStamp{st.Size(), st.ModTime().UnixNano()}
	if stamp == last {
		return
	}
	head := readTranscriptHead(path)
	tail := readTail(path, 8<<20)
	title := lastMatch(tail, customField, true)
	if title == "" {
		title = lastMatch(tail, titleField, true)
	}
	origin := head.entrypoint // how Claude Code was run: an SDK, claude -p, Claude Desktop
	if origin == "cli" {
		origin = ""
	}
	noteSession(id, namedSession{Title: title, Asked: head.prompt, Cwd: head.cwd, Origin: origin, Here: true}, time.Now())
	metaMu.Lock()
	readStamps[id] = stamp
	metaMu.Unlock()
}

type transcriptHead struct{ cwd, entrypoint, prompt string }

// readTranscriptHead streams a transcript from the start for its folder, how Claude Code was run
// and the first request: a large first prompt can push them far into the file.
func readTranscriptHead(path string) transcriptHead {
	var h transcriptHead
	f, errOpen := os.Open(path)
	if errOpen != nil {
		return h
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 4<<20)
	for read := 0; read < 64<<20 && (h.cwd == "" || h.entrypoint == "" || h.prompt == ""); {
		line, errRead := r.ReadSlice('\n')
		read += len(line)
		if errors.Is(errRead, bufio.ErrBufferFull) {
			for errors.Is(errRead, bufio.ErrBufferFull) {
				line, errRead = r.ReadSlice('\n')
				read += len(line)
			}
			continue
		}
		if h.cwd == "" {
			h.cwd = lastMatch(line, cwdField, false)
		}
		if h.entrypoint == "" {
			h.entrypoint = lastMatch(line, entryField, false)
		}
		if h.prompt == "" && bytes.Contains(line[:min(len(line), 300)], []byte(`"type":"user"`)) {
			h.prompt = userPrompt(line)
		}
		if errRead != nil {
			break
		}
	}
	return h
}

// userPrompt is the title a transcript's user message gives, past tool results (see requestTitle).
func userPrompt(line []byte) string {
	var e struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &e) != nil {
		return ""
	}
	var texts []string
	var one string
	if json.Unmarshal(e.Message.Content, &one) == nil {
		texts = []string{one}
	} else {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(e.Message.Content, &parts)
		for _, p := range parts {
			if p.Type == "text" {
				texts = append(texts, p.Text)
			}
		}
	}
	return requestTitle(texts)
}

// requestTitle is the opening line of the first text a client did not add to the user's request:
// Claude Code's "Caveat:" notes, Codex's AGENTS.md text and the tagged blocks both add
// (<command-name>, <system-reminder>, <environment_context>…) are passed over; a request wrapped
// in <task>, as Claude Code's Codex plugin sends, keeps its text.
func requestTitle(texts []string) string {
	for _, t := range texts {
		t = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "Codex Companion Task:"))
		if strings.HasPrefix(t, "Caveat:") || strings.HasPrefix(t, "# AGENTS.md") || strings.HasPrefix(t, "This session is being continued") {
			continue
		}
		if m := openingTag.FindStringSubmatch(t); m != nil {
			if m[1] != "task" {
				continue
			}
			t = strings.ReplaceAll(t[len(m[0]):], "</task>", "")
		}
		if title := cleanTitle(t); title != "" {
			return title
		}
	}
	return ""
}

var openingTag = regexp.MustCompile(`^<([a-z_ -]+)>`)

// cleanTitle is one line of a title, without invisible characters, at most 90 characters.
func cleanTitle(t string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(t), "\n")
	line = strings.Join(strings.Fields(strings.Map(visible, line)), " ")
	if r := []rune(line); len(r) > 90 {
		return string(r[:89]) + "…"
	}
	return line
}

// visible drops format characters (zero-width and invisible separators) from a title.
func visible(r rune) rune {
	if unicode.Is(unicode.Cf, r) {
		return -1
	}
	return r
}

// placeSession sets a session's project from its folder. While the folder exists the answer is
// remembered, so a session in a worktree keeps its project after the worktree is removed. False for
// a folder never seen here.
func placeSession(id, cwd string, remembered *placedProject, info *sessionInfo) bool {
	if _, errStat := os.Stat(cwd); errStat == nil {
		info.Path, info.Repo = gitRoot(cwd)
		info.Project = projectName(info.Path)
		rememberProject(id, placedProject{Project: info.Project, Path: info.Path, Repo: info.Repo})
		return true
	}
	if remembered != nil {
		info.Path, info.Repo, info.Project = remembered.Path, remembered.Repo, remembered.Project
		return true
	}
	return false
}

func indexTranscripts() {
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, ".claude", "projects")
	dirs, _ := os.ReadDir(root)
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(root, d.Name()))
		for _, f := range files {
			if name := f.Name(); !f.IsDir() && strings.HasSuffix(name, ".jsonl") {
				transcripts[strings.TrimSuffix(name, ".jsonl")] = filepath.Join(root, d.Name(), name)
			}
		}
	}
	indexedAt = time.Now()
}

func readTail(path string, n int64) []byte {
	f, errOpen := os.Open(path)
	if errOpen != nil {
		return nil
	}
	defer f.Close()
	info, errStat := f.Stat()
	if errStat != nil {
		return nil
	}
	start := info.Size() - n
	if start < 0 {
		start = 0
	}
	buf := make([]byte, info.Size()-start)
	read, _ := f.ReadAt(buf, start)
	return buf[:read]
}

// lastMatch returns the first (or last) capture of re in body, JSON-unescaped.
func lastMatch(body []byte, re *regexp.Regexp, last bool) string {
	all := re.FindAllSubmatch(body, -1)
	if len(all) == 0 {
		return ""
	}
	m := all[0]
	if last {
		m = all[len(all)-1]
	}
	var s string
	if json.Unmarshal(append(append([]byte{'"'}, m[1]...), '"'), &s) != nil {
		return string(m[1])
	}
	return s
}

// gitRoot is the repository a folder belongs to: the nearest folder holding .git (or .jj, .hg),
// and for a git worktree the main repository it was made from, so a worktree's sessions count
// under their project. A folder in no repository is its own project.
func gitRoot(cwd string) (string, bool) {
	for dir := cwd; dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		git := filepath.Join(dir, ".git")
		info, errStat := os.Stat(git)
		if errStat == nil && !info.IsDir() {
			return worktreeMain(git, dir), true
		}
		if errStat == nil {
			return dir, true
		}
		for _, other := range []string{".jj", ".hg"} {
			if _, errOther := os.Stat(filepath.Join(dir, other)); errOther == nil {
				return dir, true
			}
		}
	}
	return cwd, false
}

// worktreeMain reads a .git file for the repository a worktree belongs to. Its gitdir (relative to
// the folder, or absolute) holds a commondir naming the repository's own git folder: <repo>/.git,
// or a bare repository (<repo>/.bare, <repo>.git). A .git file without one, as a submodule's, is a
// repository of its own; a worktree whose git folder is gone is placed by its path's shape.
func worktreeMain(gitFile, dir string) string {
	body, errRead := os.ReadFile(gitFile)
	if errRead != nil {
		return dir
	}
	gitdir := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(body)), "gitdir:"))
	if gitdir == "" {
		return dir
	}
	if !filepath.IsAbs(gitdir) {
		gitdir = filepath.Join(dir, gitdir)
	}
	common, errCommon := os.ReadFile(filepath.Join(gitdir, "commondir"))
	if errCommon != nil {
		sep := string(filepath.Separator)
		if main, _, ok := strings.Cut(gitdir, sep+".git"+sep+"worktrees"+sep); ok && main != "" {
			return main
		}
		return dir
	}
	repo := strings.TrimSpace(string(common))
	if !filepath.IsAbs(repo) {
		repo = filepath.Join(gitdir, repo)
	}
	if strings.HasPrefix(filepath.Base(repo), ".") {
		return filepath.Dir(repo) // <repo>/.git, <repo>/.bare
	}
	return strings.TrimSuffix(repo, ".git")
}

func projectName(path string) string {
	if home, _ := os.UserHomeDir(); path == home {
		return "~"
	}
	return filepath.Base(path)
}

// ---- the panel's usage view ----

type usageSession struct {
	ID       string        `json:"id"`
	Title    string        `json:"title"`
	Used     float64       `json:"used"`
	Requests int           `json:"requests"`
	Last     int64         `json:"last"`
	Tokens   core.TokenSum `json:"tokens"`
	Accounts []string      `json:"accounts"`         // accounts that served it in the period, most used first
	Origin   string        `json:"origin,omitempty"` // what ran it, as sessionInfo.Origin; "" for Claude Code's CLI
	Remote   bool          `json:"remote,omitempty"` // it ran on another device
	Device   string        `json:"device,omitempty"` // that device's name, where known
	// Mode all: the session's part of each provider's weekly quota, in that provider's unit.
	UsedBy map[string]float64 `json:"used_by,omitempty"`
	// Metered is false for a session known only by its tokens: none of its requests fell where
	// quota readings exist (before the log began, or an account not on the proxy).
	Metered   bool     `json:"metered"`
	Providers []string `json:"providers"` // the providers it used in the range
}

type usageProject struct {
	Name     string             `json:"name"`
	Path     string             `json:"path"`
	Used     float64            `json:"used"`
	UsedBy   map[string]float64 `json:"used_by,omitempty"`
	Metered  bool               `json:"metered"`
	Requests int                `json:"requests"`
	Last     int64              `json:"last"`
	Tokens   core.TokenSum      `json:"tokens"`
	Sessions []usageSession     `json:"sessions"`
}

// usageAccount is one account over its current window of the range: its week, or over 5h its 5-hour window.
type usageAccount struct {
	core.AccountInfo
	Order     int                `json:"order"`    // routing order; 1 is the account a new session gets
	Sessions  int                `json:"sessions"` // sessions bound to it now
	Used      float64            `json:"used"`
	Known     bool               `json:"known"` // a quota reading fell in the window; otherwise Used means nothing
	BeforeLog float64            `json:"before_log"`
	Outside   float64            `json:"outside"`
	Projects  map[string]float64 `json:"projects"`            // project name to its part of this account's week
	Covered   int64              `json:"covered_from"`        // when the log began to see this account; earlier use is before_log
	OffProxy  bool               `json:"off_proxy,omitempty"` // named by the log, not held by the proxy
	// RestartedAt is when its window started over before its reset (a plan change, a reset asked
	// for): the window counts from then.
	RestartedAt int64 `json:"restarted_at,omitempty"`
	NoWindow    bool  `json:"no_window,omitempty"` // 5h: the account has no 5-hour window (a Codex account may have only a weekly one)
}

type usageProvider struct {
	Provider string         `json:"provider"`
	Accounts []usageAccount `json:"accounts"` // accounts in use first, then routing order
}

// usageDoc answers one scope over one range: an account, a provider's accounts or every
// account; each account's current week or 5-hour window (each over its own), or the last 7 or 30
// local days. Figures are parts of one account's weekly quota (of its 5-hour window over "5h"),
// never added across providers. Every answer also carries every account's current window of the
// range, so the picker and the scope show one reading of the log.
type usageDoc struct {
	// Mode "account" and "provider": `used` is the scope's part, added across its accounts. Mode
	// "all": each provider's part is in Totals and `used_by`; `used` only orders the list.
	Mode     string `json:"mode"`
	Scope    string `json:"scope"`
	Range    string `json:"range"` // "week", "5h", "7d" or "30d"
	Provider string `json:"provider,omitempty"`
	Capacity int    `json:"capacity"` // accounts in the scope; in mode all see Totals
	From     int64  `json:"from"`     // range start; for "week" and "5h" the earliest window start in the scope
	To       int64  `json:"to"`
	// Week and 5h: `used` is the accounts' readings added. 7d and 30d: what the range used,
	// across the weeks it touches. Both hold before_log and outside.
	Used        float64                  `json:"used"`
	Known       bool                     `json:"known"` // a reading fell in the range for some account of the scope
	BeforeLog   float64                  `json:"before_log"`
	Unplaced    float64                  `json:"unplaced"`         // 7d and 30d: what may lie on either side of the range start; not in used
	Undated     float64                  `json:"undated"`          // the part of outside read across midnight: in used, on no day
	Unread      []string                 `json:"unread,omitempty"` // 7d and 30d: accounts with no reading in the range
	Outside     float64                  `json:"outside"`
	Totals      map[string]usageTotals   `json:"totals,omitempty"`
	Composition core.Composition         `json:"composition"`
	Projects    []usageProject           `json:"projects"`
	Providers   []usageProvider          `json:"providers"`
	Daily       map[string][]usageDay    `json:"daily,omitempty"`   // each provider's days, oldest first
	Windows     map[string][]usageWindow `json:"windows,omitempty"` // 5h: each provider's windows of the last day, oldest first
	// WindowsFrom is, over 5h, since when every reading of the scope that shows use names its 5-hour
	// reset, when that is within the last day: some windows that ended before it are not listed.
	WindowsFrom int64 `json:"windows_from,omitempty"`
}

// usageTotals is one provider's accounts in the range, in parts of one account's quota.
type usageTotals struct {
	Capacity  int      `json:"capacity"`
	Used      float64  `json:"used"`
	Known     bool     `json:"known"`
	BeforeLog float64  `json:"before_log"`
	Unplaced  float64  `json:"unplaced"`
	Undated   float64  `json:"undated"`
	Outside   float64  `json:"outside"`
	Unread    []string `json:"unread,omitempty"`
}

// usageDay is one provider's local day in the range.
type usageDay struct {
	Day      string             `json:"day"`
	Projects map[string]float64 `json:"projects,omitempty"`
	Outside  float64            `json:"outside,omitempty"`
	Metered  bool               `json:"metered"` // a quota reading fell on the day; without one only tokens are known
	// Undated: use read across midnight may lie on the day, so its figure may leave some out.
	Undated  bool          `json:"undated,omitempty"`
	Requests int           `json:"requests"`
	Tokens   core.TokenSum `json:"tokens"`
	Sessions []daySession  `json:"sessions"` // the day's largest, up to three
}

// daySession is one of a day's largest sessions: by its part of the weekly quota where readings
// tell it, else by its weight.
type daySession struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Used  *float64 `json:"used,omitempty"` // absent where no reading settled its requests that day
}

// dayUse is what a provider's requests in the scope ran on one local day.
type dayUse struct {
	requests int
	tokens   core.TokenSum
	weights  map[string]float64 // by session as the table lists it
}

// reading is the log read once for a report: every account's current window of the range (its
// week, or its 5-hour window) for the picker, and every account over the requested range.
type reading struct {
	rng       string
	from      int64 // range start for 7d and 30d
	entries   []core.LogEntry
	week      map[string]core.Attribution // each account's current window: its week, or over 5h its 5-hour window
	ranged    map[string]core.Attribution // each account over the range (the current window for "week" and "5h")
	froms     map[string]int64            // where each account's counting starts
	starts    map[string]int64            // where each account's period shown begins
	owner     map[string]string           // account to provider
	providers []usageProvider
	windows   map[string][]fiveWindow // 5h: each account's windows of the last day
	noWindow  map[string]bool         // 5h: accounts without a 5-hour window
	namedFrom map[string]int64        // 5h: since when each account's readings that show use name their 5-hour reset
	remote    map[string]bool         // sessions, as the table lists them, a request of which came from another device
	canonical map[string]string       // a credential to the one its account counts under
}

// scopeOf is the scope a report answers for one asked: an account counted under another
// credential is that one's.
func (u *reading) scopeOf(scope string) string {
	if to, ok := u.canonical[scope]; ok {
		return to
	}
	return scope
}

// validRange is the range a report covers: "week" unless "5h", "7d" or "30d" is asked.
func validRange(rng string) string {
	switch rng {
	case "5h", "7d", "30d":
		return rng
	}
	return "week"
}

// rangeDays is how many local days a range covers; 0 for "week" and "5h".
func rangeDays(rng string) int {
	switch rng {
	case "7d":
		return 7
	case "30d":
		return 30
	}
	return 0
}

// readUsage reads the log for a report over rng; keep names sessions whose settled requests are
// kept one by one (nil for none).
func readUsage(now time.Time, rng string, keep func(string) bool) *reading {
	entries, logStart := readLog(now.AddDate(0, 0, -usageDays))
	// One provider account read under two credentials (logged in again under a new one) is one
	// account: its lines count under one, read with the snapshot so the two agree.
	snap, canonical := state.BuildWithCanonical()
	for i := range entries {
		if to, ok := canonical[entries[i].Account]; ok {
			entries[i].Account = to
		}
	}
	// An account is watched from its first line: an account added later counts what it had used
	// by then as used before logging.
	firstSeen := map[string]int64{}
	for _, e := range entries {
		if s, ok := firstSeen[e.Account]; !ok || e.T < s {
			firstSeen[e.Account] = e.T
		}
	}
	startOf := func(id string) int64 {
		if s, ok := firstSeen[id]; ok {
			return s
		}
		return logStart
	}
	u := &reading{rng: rng, canonical: canonical, week: map[string]core.Attribution{}, ranged: map[string]core.Attribution{},
		froms: map[string]int64{}, starts: map[string]int64{}, owner: map[string]string{}, windows: map[string][]fiveWindow{}, noWindow: map[string]bool{},
		namedFrom: map[string]int64{}, remote: map[string]bool{}}
	if n := rangeDays(rng); n > 0 {
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		u.from = today.AddDate(0, 0, 1-n).UnixMilli()
	}
	u.entries = entries
	for _, e := range entries {
		if e.Remote {
			u.remote[core.ViewSession(e.Session)] = true
		}
	}
	// Each account's lines in time order, gathered once.
	lines := map[string][]core.LogEntry{}
	for _, e := range entries {
		if e.Account != "" {
			lines[e.Account] = append(lines[e.Account], e)
		}
	}
	for _, ls := range lines {
		sort.SliceStable(ls, func(i, j int) bool { return ls[i].T < ls[j].T })
	}
	// The proxy's credentials, then the accounts the log names that the proxy no longer holds:
	// their quota counts as well.
	type account struct {
		info            core.AccountInfo
		order, sessions int
		off             bool
	}
	byProvider := map[string][]account{}
	// A credential that logs in to the same account as another the proxy holds counts under that
	// one: one quota, its sessions with it.
	alsoBound := map[string]int{}
	for _, view := range snap.Providers {
		for _, cv := range view.Credentials {
			if cv.SameAs != "" {
				alsoBound[cv.SameAs] += cv.Sessions
			}
		}
	}
	for name, view := range snap.Providers {
		for _, cv := range view.Credentials {
			if cv.SameAs != "" {
				continue
			}
			cv.Sessions += alsoBound[cv.ID]
			if info, ok := state.Account(cv.ID); ok {
				info = windowOf(info, lines[cv.ID], now)
				byProvider[name] = append(byProvider[name], account{info: info, order: cv.Order, sessions: cv.Sessions})
			}
		}
	}
	held := map[string]bool{}
	for _, accounts := range byProvider {
		for _, a := range accounts {
			held[a.info.ID] = true
		}
	}
	for id, ls := range lines {
		// Its latest line, request or reading, which names its provider; and its latest weekly reading.
		var latest, weekly *core.LogEntry
		for i := range ls {
			if ls[i].Provider != "" {
				latest = &ls[i]
			}
			if ls[i].Used7d != nil {
				weekly = &ls[i]
			}
		}
		if held[id] || latest == nil || latest.Provider == "" {
			continue
		}
		info := core.AccountInfo{ID: id, Email: offProxyEmail(id), Provider: latest.Provider}
		if weekly != nil && weekly.Reset7 > 0 {
			info.ResetAt = time.UnixMilli(weekly.Reset7)
		}
		byProvider[latest.Provider] = append(byProvider[latest.Provider], account{info: info, order: math.MaxInt32, off: true})
	}
	// Each provider's accounts, those it holds and those gone, named apart from one another.
	for _, accounts := range byProvider {
		emails := map[string]string{}
		for _, a := range accounts {
			emails[a.info.ID] = a.info.Email
		}
		labels := core.UniqueLabels(emails)
		for i := range accounts {
			accounts[i].info.Label = labels[accounts[i].info.ID]
		}
	}
	if u.from > 0 {
		// Over a range a provider whose lines name no account it holds still shows, with its tokens.
		for _, e := range entries {
			if _, ok := byProvider[e.Provider]; !ok && e.Provider != "" && !e.Poll {
				byProvider[e.Provider] = nil
			}
		}
	}
	names := make([]string, 0, len(byProvider))
	for name := range byProvider {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		up := usageProvider{Provider: name, Accounts: []usageAccount{}}
		for _, a := range byProvider[name] {
			id := a.info.ID
			u.owner[id] = name
			if rng == "5h" {
				acct := u.fiveHour(a.info, lines[id], startOf(id), now, keep)
				acct.Order, acct.Sessions, acct.Covered, acct.OffProxy = a.order, a.sessions, startOf(id), a.off
				up.Accounts = append(up.Accounts, acct)
				continue
			}
			// The weekly schedule, when known, places readings that do not say their window.
			ws, schedule := weekStart(a.info, now).UnixMilli(), int64(0)
			if !a.off || !a.info.ResetAt.IsZero() {
				schedule = ws
			}
			if a.off && !a.info.ResetAt.After(now) {
				ws = now.UnixMilli() // its window is over, and the next one is not known
			}
			// The window's start is known to about a minute: the walk takes its first requests in.
			span := core.Span{From: ws - core.WindowJitter, To: now.UnixMilli(), CountFrom: ws - core.WindowJitter, LogStart: startOf(id), WindowStart: ws, Keep: keep, Loc: now.Location()}
			current := core.Attribute(lines[id], id, span)
			u.week[id] = current
			if u.from == 0 {
				// After a new window the period, and its tokens, start where it began.
				u.ranged[id], u.froms[id], u.starts[id] = current, max(span.From, current.Restart), max(ws, restartedAt(current))
			} else {
				// One walk across the windows the range touches, begun a week early so the reading
				// and the rate are known where the range begins.
				span = core.Span{From: u.from - 7*day, To: now.UnixMilli(), CountFrom: u.from, LogStart: startOf(id), WindowStart: schedule, Range: true, Keep: keep, Loc: now.Location()}
				u.ranged[id], u.froms[id], u.starts[id] = core.Attribute(lines[id], id, span), u.from, u.from
			}
			up.Accounts = append(up.Accounts, usageAccount{AccountInfo: a.info, Order: a.order, Sessions: a.sessions,
				Used: current.Used, Known: current.Seen, BeforeLog: current.BeforeLog, Outside: current.Outside, Covered: startOf(id),
				OffProxy: a.off, RestartedAt: restartedAt(current)})
		}
		sort.SliceStable(up.Accounts, func(i, j int) bool {
			a, b := up.Accounts[i], up.Accounts[j]
			if (a.Sessions > 0) != (b.Sessions > 0) {
				return a.Sessions > 0
			}
			return a.Order < b.Order || a.Order == b.Order && a.ID < b.ID
		})
		u.providers = append(u.providers, up)
	}
	return u
}

const day = 24 * 3600 * 1000

// covers tells which lines a scope counts and which accounts it holds: each account's own lines
// from where its counting starts. Over 7 or 30 days a provider or every provider also counts the
// lines whose account is not known (one the proxy no longer holds and never read), which add
// tokens without a part of any quota. False for an unknown scope.
func (u *reading) covers(scope string) (func(core.LogEntry) bool, []string, bool) {
	var accounts []string
	provider, isProvider := strings.CutPrefix(scope, "provider:")
	for id, p := range u.owner {
		if scope == "all" || (isProvider && p == provider) || id == scope {
			accounts = append(accounts, id)
		}
	}
	sort.Strings(accounts)
	listed := false
	for _, up := range u.providers {
		listed = listed || isProvider && up.Provider == provider
	}
	if len(accounts) == 0 && !listed && scope != "all" {
		return nil, nil, false
	}
	held := map[string]bool{}
	for _, id := range accounts {
		held[id] = true
	}
	unknownToo := u.from > 0 && (scope == "all" || isProvider)
	return func(e core.LogEntry) bool {
		if from, ok := u.froms[e.Account]; ok {
			return held[e.Account] && e.T >= from
		}
		return unknownToo && e.T >= u.from && (scope == "all" || e.Provider == provider)
	}, accounts, true
}

// warmReport reads the transcript of every session in the current weeks once, shortly after
// start, so the first report a page asks for does not wait on that: after a restart a cold report
// takes seconds per hundred sessions, longer than the page waits. What it reads is what the report
// would (see noteTranscript); a stop ends it between two transcripts.
func warmReport(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(10 * time.Second):
	}
	defer func() { _ = recover() }()
	for _, attr := range readUsage(time.Now(), "week", nil).week {
		for id := range attr.Sessions {
			if ctx.Err() != nil {
				return
			}
			sessionMeta(core.ViewSession(id))
		}
	}
}

// reportZone is the time zone a report's days are in: the page's, named as the IANA database
// names it, so its days and the times it shows agree; the proxy's when it names none it knows.
func reportZone(name string) *time.Location {
	if name == "" {
		return time.Local
	}
	loc, errLoad := time.LoadLocation(name)
	if errLoad != nil {
		return time.Local
	}
	return loc
}

func usageResponse(query url.Values) ([]byte, error) {
	now := time.Now().In(reportZone(query.Get("tz")))
	scope, rng := query.Get("account"), query.Get("range")
	if scope == "" {
		scope = "all"
	}
	rng = validRange(rng)
	u := readUsage(now, rng, nil)
	scope = u.scopeOf(scope)
	inScope, accounts, ok := u.covers(scope)
	if !ok {
		return httpResponse(http.StatusNotFound, []byte(`{"error":"unknown account or provider"}`))
	}
	doc := usageDoc{Scope: scope, Range: rng, To: now.UnixMilli(), From: now.UnixMilli(), Projects: []usageProject{}, Providers: u.providers}
	// combine adds the scope's accounts of one provider ("" for all of them), and names those
	// without a reading in the range, whose use is then not known.
	combine := func(provider string) (core.Attribution, int, []string) {
		var parts []core.Attribution
		var unread []string
		for _, id := range accounts {
			if (provider == "" || u.owner[id] == provider) && !u.noWindow[id] {
				parts = append(parts, u.ranged[id])
				doc.From = min(doc.From, u.starts[id])
				if rangeDays(rng) > 0 && !u.ranged[id].Seen {
					unread = append(unread, id)
				}
			}
		}
		return core.Combine(parts), len(parts), unread
	}
	used := func(a core.Attribution) float64 {
		if rangeDays(rng) == 0 {
			return a.Used
		}
		return a.Counted
	}

	var shares map[string]*core.Share
	var usedBy map[string]map[string]float64
	providersIn := []string{}
	if provider, isProvider := strings.CutPrefix(scope, "provider:"); isProvider || scope != "all" {
		all, n, unread := combine("")
		doc.Mode, doc.Capacity = "account", n
		if isProvider {
			doc.Mode, doc.Provider = "provider", provider
			providersIn = append(providersIn, provider)
		} else {
			providersIn = append(providersIn, u.owner[scope])
		}
		doc.Used, doc.Known, doc.BeforeLog, doc.Unplaced, doc.Undated, doc.Outside, doc.Unread, shares =
			used(all), all.Seen, all.BeforeLog, all.Unplaced, all.Undated, all.Outside, unread, all.Sessions
	} else {
		// Each provider in its own unit. The parts are never added across providers; a session's
		// place in the list weighs each part against its provider's capacity.
		doc.Mode, doc.Totals = "all", map[string]usageTotals{}
		shares, usedBy = map[string]*core.Share{}, map[string]map[string]float64{}
		for _, up := range u.providers {
			all, n, unread := combine(up.Provider)
			providersIn = append(providersIn, up.Provider)
			doc.Totals[up.Provider] = usageTotals{Capacity: n, Used: used(all), Known: all.Seen, BeforeLog: all.BeforeLog,
				Unplaced: all.Unplaced, Undated: all.Undated, Outside: all.Outside, Unread: unread}
			addProvider(shares, usedBy, up.Provider, all, n)
		}
	}
	switch {
	case u.from > 0:
		doc.From = u.from // over a range, the range, whatever accounts the scope holds
	case doc.From > now.UnixMilli():
		doc.From = now.UnixMilli()
	}

	served := map[string]map[string]float64{}     // session to account to weight
	usedProviders := map[string]map[string]bool{} // session to the providers it used
	used7 := map[string]map[string]*dayUse{}      // provider to day to what ran
	for _, e := range u.entries {
		if e.Poll || !inScope(e) {
			continue
		}
		doc.Composition.Add(e)
		id := core.ViewSession(e.Session)
		if used7[e.Provider] == nil {
			used7[e.Provider] = map[string]*dayUse{}
		}
		d := core.DayOf(e.T, now.Location())
		du := used7[e.Provider][d]
		if du == nil {
			du = &dayUse{weights: map[string]float64{}}
			used7[e.Provider][d] = du
		}
		du.requests++
		du.tokens.Add(e)
		du.weights[id] += e.Weight()
		if usedProviders[id] == nil {
			usedProviders[id] = map[string]bool{}
		}
		usedProviders[id][e.Provider] = true
		if served[id] == nil {
			served[id] = map[string]float64{}
		}
		served[id][e.Account] += e.Weight()
		// Lines no account's walk counted (an unknown account) add their tokens alone.
		if _, attributed := u.froms[e.Account]; !attributed {
			if shares[e.Session] == nil {
				shares[e.Session] = &core.Share{Session: e.Session}
			}
			sh := shares[e.Session]
			sh.Requests++
			sh.Tokens.Input += e.Input
			sh.Tokens.Output += e.Output
			sh.Tokens.CacheRead += e.CacheRead
			sh.Tokens.CacheWrite += e.CacheWrite
			sh.Last = max(sh.Last, e.T)
		}
	}
	// Each session's project is decided once for the whole report, so the accounts' parts, the
	// table and the days name projects alike.
	ids := map[string]bool{}
	for id := range shares {
		ids[core.ViewSession(id)] = true
	}
	for _, attr := range u.week {
		for id := range attr.Sessions {
			ids[core.ViewSession(id)] = true
		}
	}
	for _, list := range u.windows {
		for _, w := range list {
			for id := range w.Parts {
				ids[core.ViewSession(id)] = true
			}
		}
	}
	refs := placeProjects(ids)
	for i := range doc.Providers {
		for j := range doc.Providers[i].Accounts {
			a := &doc.Providers[i].Accounts[j]
			a.Projects = projectParts(u.week[a.ID], refs)
		}
	}
	doc.Projects = groupByProject(shares, served, usedBy, usedProviders, refs, u.remote)
	if rng == "5h" {
		// Each provider's windows of the last day, of the scope's accounts, oldest first.
		doc.Windows = map[string][]usageWindow{}
		for _, id := range accounts {
			doc.WindowsFrom = max(doc.WindowsFrom, u.namedFrom[id])
		}
		if doc.WindowsFrom <= now.UnixMilli()-day {
			doc.WindowsFrom = 0
		}
		for _, provider := range providersIn {
			list := []usageWindow{}
			for _, id := range accounts {
				if u.owner[id] == provider {
					for _, w := range u.windows[id] {
						list = append(list, windowDoc(id, w, refs))
					}
				}
			}
			sort.SliceStable(list, func(i, j int) bool { return list[i].From < list[j].From })
			doc.Windows[provider] = list
		}
		return marshalUsage(doc)
	}
	// Each provider's days: over a range, the range's; over the week, from the day its earliest
	// window in the scope began.
	doc.Daily = map[string][]usageDay{}
	for _, provider := range providersIn {
		all, _, _ := combine(provider)
		from := u.from
		if from == 0 {
			from = now.UnixMilli()
			for _, id := range accounts {
				if u.owner[id] == provider {
					from = min(from, u.starts[id])
				}
			}
		}
		doc.Daily[provider] = days(all, used7[provider], refs, from, now)
	}
	return marshalUsage(doc)
}

func marshalUsage(doc usageDoc) ([]byte, error) {
	body, errMarshal := json.Marshal(doc)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return httpResponse(http.StatusOK, body)
}

// addProvider adds a provider's sessions to mode all's: tokens and requests add up, each
// provider's part stays apart in its own unit, and a session's place in the list weighs each part
// against its provider's capacity.
func addProvider(shares map[string]*core.Share, usedBy map[string]map[string]float64, provider string, a core.Attribution, capacity int) {
	for id, sh := range a.Sessions {
		if shares[id] == nil {
			shares[id] = &core.Share{Session: id}
		}
		part := *sh
		part.Used = 0
		shares[id].Add(&part)
		shares[id].Used += sh.Used / float64(max(capacity, 1))
		if sh.Metered {
			// Keyed as the table lists sessions, where requests without one share a row.
			view := core.ViewSession(id)
			if usedBy[view] == nil {
				usedBy[view] = map[string]float64{}
			}
			usedBy[view][provider] += sh.Used
		}
	}
}

// days lays a provider's days out from the day of from, in now's time zone: each project's part,
// use elsewhere, whether any reading fell on the day, what its requests ran, and its largest sessions.
func days(a core.Attribution, use map[string]*dayUse, refs map[string]projectRef, from int64, now time.Time) []usageDay {
	var out []usageDay
	index := map[string]int{}
	f := time.UnixMilli(from).In(now.Location())
	for t := time.Date(f.Year(), f.Month(), f.Day(), 0, 0, 0, 0, f.Location()); !t.After(now); t = t.AddDate(0, 0, 1) {
		d := core.DayOf(t.UnixMilli(), now.Location())
		index[d] = len(out)
		out = append(out, usageDay{Day: d, Metered: a.ReadDays[d], Undated: a.UndatedDays[d], Outside: a.OutsideDays[d], Sessions: []daySession{}})
	}
	quota := map[string]map[string]float64{} // day to session to its part, where readings tell it
	for id, sh := range a.Sessions {
		view := core.ViewSession(id)
		for d, x := range sh.Days {
			i, ok := index[d]
			if !ok {
				continue
			}
			if quota[d] == nil {
				quota[d] = map[string]float64{}
			}
			quota[d][view] += x
			if x == 0 {
				continue
			}
			if out[i].Projects == nil {
				out[i].Projects = map[string]float64{}
			}
			out[i].Projects[refs[view].Name] += x
		}
	}
	for d, i := range index {
		du := use[d]
		if du == nil {
			continue
		}
		out[i].Requests, out[i].Tokens = du.requests, du.tokens
		// The largest sessions: those readings tell by their part, then the rest by weight.
		ids := make([]string, 0, len(du.weights))
		for id := range du.weights {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(x, y int) bool {
			qx, kx := quota[d][ids[x]]
			qy, ky := quota[d][ids[y]]
			switch {
			case kx != ky:
				return kx
			case kx && qx != qy:
				return qx > qy
			case du.weights[ids[x]] != du.weights[ids[y]]:
				return du.weights[ids[x]] > du.weights[ids[y]]
			}
			return ids[x] < ids[y]
		})
		for _, id := range ids[:min(3, len(ids))] {
			s := daySession{ID: id, Title: sessionMeta(id).Title}
			if q, ok := quota[d][id]; ok {
				s.Used = &q
			}
			out[i].Sessions = append(out[i].Sessions, s)
		}
	}
	return out
}

// usageSessionResponse describes one session within a scope and range; id "" is the requests
// that came without a session.
func usageSessionResponse(query url.Values) ([]byte, error) {
	if !query.Has("id") {
		return httpResponse(http.StatusBadRequest, []byte(`{"error":"id required"}`))
	}
	id, scope, rng := query.Get("id"), query.Get("account"), validRange(query.Get("range"))
	if scope == "" {
		scope = "all"
	}
	now := time.Now().In(reportZone(query.Get("tz")))
	u := readUsage(now, rng, func(s string) bool { return core.ViewSession(s) == id })
	scope = u.scopeOf(scope)
	inScope, accounts, ok := u.covers(scope)
	if !ok {
		return httpResponse(http.StatusNotFound, []byte(`{"error":"unknown account or provider"}`))
	}
	var lines []core.LogEntry
	for _, e := range u.entries {
		if !e.Poll && inScope(e) && core.ViewSession(e.Session) == id {
			lines = append(lines, e)
		}
	}
	type account struct {
		ID       string  `json:"id"`
		Label    string  `json:"label"` // "" when the account is no longer on the proxy
		Provider string  `json:"provider"`
		Weight   float64 `json:"weight"`
	}
	// The session's settled requests in the scope, each account's in its provider's unit.
	var pieces []core.Piece
	for _, acc := range accounts {
		for _, p := range u.ranged[acc].Pieces {
			p.Provider = u.owner[acc]
			pieces = append(pieces, p)
		}
	}
	detail := core.Detail(lines, pieces, now.Location())
	infos := map[string]core.AccountInfo{}
	for _, up := range u.providers {
		for _, a := range up.Accounts {
			infos[a.ID] = a.AccountInfo
		}
	}
	served := make([]account, 0, len(detail.Accounts))
	for _, p := range detail.Accounts {
		a := account{ID: p.Name, Weight: p.Weight}
		if info, ok := infos[p.Name]; ok {
			a.Label, a.Provider = info.Label, info.Provider
		}
		served = append(served, a)
	}
	meta := sessionMeta(id)
	body, errMarshal := json.Marshal(struct {
		ID      string `json:"id"`
		Title   string `json:"title"`
		Project string `json:"project"`
		Path    string `json:"path"`
		Origin  string `json:"origin,omitempty"`
		Remote  bool   `json:"remote,omitempty"`
		core.SessionDetail
		Accounts []account `json:"accounts"`
	}{ID: id, Title: meta.Title, Project: meta.Project, Path: meta.Path, Origin: meta.Origin, Remote: meta.Remote || u.remote[id], SessionDetail: detail, Accounts: served})
	if errMarshal != nil {
		return nil, errMarshal
	}
	return httpResponse(http.StatusOK, body)
}

// offProxyEmail is what a credential id tells of the email of an account the proxy no longer
// holds: the host names a credential file after it.
func offProxyEmail(id string) string {
	if local, _, ok := strings.Cut(id, "@"); ok {
		return local[strings.LastIndex(local, "-")+1:] + "@"
	}
	return id
}

// weekStart is when an account's current weekly window began.
// A window is 168 hours, whatever the clocks do in between.
// windowOf gives an account the weekly window its last reading named when the proxy has read
// none since it started (or could not read it): readings are logged as they come, so the log
// knows the window the state forgot. A window the log saw end rolls on by whole weeks.
func windowOf(info core.AccountInfo, lines []core.LogEntry, now time.Time) core.AccountInfo {
	if !info.ResetAt.IsZero() {
		return info
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if lines[i].Reset7 > 0 {
			info.ResetAt = core.NextWeeklyReset(time.UnixMilli(lines[i].Reset7), now)
			break
		}
	}
	return info
}

func weekStart(info core.AccountInfo, now time.Time) time.Time {
	if info.ResetAt.IsZero() {
		return now.Add(-7 * 24 * time.Hour)
	}
	return info.ResetAt.Add(-7 * 24 * time.Hour)
}

// projectRef is the project a session counts under in one report.
type projectRef struct {
	Name string // as shown; "" for sessions with no transcript here
	Path string
}

// placeProjects decides each session's project for one report. Sessions group by their
// project's folder, not its name: a repository gathers every session that ran inside it, and a
// folder outside any repository is a project of its own. Such a folder never joins one that
// holds it, since without a repository nothing says where a project begins: a session started in
// a folder of folders (~/Documents) would take every project under it. One that sits directly
// in another project's folder is named after both (web-app/docs). A project known only by
// its git remote (a removed worktree) joins the local project of the same name. A repository the
// band names by its remote is one project on every device, and a session in its folder that no
// band named, as a Codex session, joins it. Two projects left with one name are told apart by
// their parent folder.
func placeProjects(ids map[string]bool) map[string]projectRef {
	infos := map[string]sessionInfo{}
	for id := range ids {
		infos[id] = sessionMeta(id)
	}
	home, _ := os.UserHomeDir()
	return mergeProjects(infos, home)
}

func mergeProjects(infos map[string]sessionInfo, home string) map[string]projectRef {
	type project struct {
		name, path, device, addr string
		repo, here               bool
	}
	// A folder is a device's: two devices may each have a /home/me/app of their own.
	folderOf := func(info sessionInfo) string {
		device := ""
		if info.Remote {
			device = cmp.Or(info.addr, info.Device, "other")
		}
		return device + "\x00" + info.Path
	}
	repoAt := map[string]string{} // a repository's folder on a device to its remote
	for _, info := range infos {
		if info.Repository != "" && info.Path != "" {
			repoAt[folderOf(info)] = info.Repository
		}
	}
	keyOf := func(info sessionInfo) string {
		if repo := cmp.Or(info.Repository, repoAt[folderOf(info)]); repo != "" {
			return "repo:" + repo
		}
		if info.Repo && info.Remote {
			return "dev:" + folderOf(info) // a repository known by no remote is its device's own
		}
		if info.Path != "" {
			return info.Path
		}
		return "name:" + info.Project
	}
	byKey := map[string]project{}
	keys := map[string]string{}  // session to its project key
	folders := map[string]bool{} // every project's folder, on any device
	for id, info := range infos {
		k := keyOf(info)
		keys[id] = k
		folders[info.Path] = info.Path != ""
		// A repository on several devices is shown by its folder here, else by the first one.
		p := project{name: info.Project, path: info.Path, repo: info.Repo, here: !info.Remote}
		if info.Remote {
			p.device, p.addr = cmp.Or(info.Device, info.addr), info.addr
		}
		if old, ok := byKey[k]; !ok || p.here && !old.here || p.here == old.here && p.path < old.path {
			byKey[k] = p
		}
	}
	parent := map[string]string{}
	for k, p := range byKey {
		if p.path != "" {
			continue
		}
		// Known by name only: join the one local project of that name, if there is one.
		var match []string
		for k2, p2 := range byKey {
			if p2.path != "" && p2.name == p.name && p.name != "" {
				match = append(match, k2)
			}
		}
		if len(match) == 1 {
			parent[k] = match[0]
		}
	}
	// Only a project known by name points to another, and never on: one step finds its project.
	root := func(k string) string {
		if next, ok := parent[k]; ok {
			return next
		}
		return k
	}
	// A project's name with n of its parent folders before it; past the top, its whole path.
	withParents := func(k string, n int) string {
		p := byKey[k]
		dirs := strings.Split(strings.Trim(filepath.Dir(p.path), "/"), "/")
		if n > len(dirs) {
			return p.path
		}
		return strings.Join(append(dirs[len(dirs)-n:], p.name), "/")
	}
	// A folder outside any repository sitting directly in another project's folder (not home's, not
	// the root's) starts named after both: web-app/docs.
	shown, depth := map[string]string{}, map[string]int{}
	for k, p := range byKey {
		if root(k) != k {
			continue
		}
		shown[k] = p.name
		if dir := filepath.Dir(p.path); !p.repo && p.path != "" && dir != home && dir != "/" {
			if folders[dir] {
				depth[k], shown[k] = 1, withParents(k, 1)
			}
		}
	}
	// The report sums by name, so every name must be its own: projects that share one, however
	// it came, are told apart by as many parent folders as it takes, by the whole path at last.
	for clash := true; clash; {
		clash = false
		byName := map[string][]string{}
		for k, name := range shown {
			byName[name] = append(byName[name], k)
		}
		for name, ks := range byName {
			if len(ks) < 2 || name == "" {
				continue
			}
			for _, k := range ks {
				if p := byKey[k]; p.path != "" && shown[k] != p.path {
					depth[k]++
					shown[k], clash = withParents(k, depth[k]), true
				}
			}
		}
	}
	// Two repositories at one path, on two devices, are told apart by their remotes, else by the
	// device.
	byName := map[string]int{}
	for _, name := range shown {
		byName[name]++
	}
	for k, name := range shown {
		if byName[name] < 2 {
			continue
		}
		if repo, ok := strings.CutPrefix(k, "repo:"); ok {
			shown[k] = repo
		} else if p := byKey[k]; strings.HasPrefix(k, "dev:") && p.device != "" {
			shown[k] = p.name + " · " + p.device // parent folders cannot part one path
		}
	}
	// Two devices DNS names alike are told apart by their addresses.
	byName = map[string]int{}
	for _, name := range shown {
		byName[name]++
	}
	for k, name := range shown {
		if p := byKey[k]; byName[name] > 1 && strings.HasPrefix(k, "dev:") && p.addr != "" {
			shown[k] = p.name + " · " + p.addr
		}
	}
	out := map[string]projectRef{}
	for id, k := range keys {
		r := root(k)
		out[id] = projectRef{Name: shown[r], Path: byKey[r].path}
	}
	return out
}

// projectParts sums an account's attributed quota by project.
func projectParts(attr core.Attribution, refs map[string]projectRef) map[string]float64 {
	out := map[string]float64{}
	for id, sh := range attr.Sessions {
		if sh.Used > 0 {
			out[refs[core.ViewSession(id)].Name] += sh.Used
		}
	}
	return out
}

// groupByProject puts sessions under their project, largest first. Sessions with no folder known
// (Claude Code on another device without a band, or requests without a session) share the ""
// project. A session ran on another device when it said so, or when a request of it came from there.
func groupByProject(shares map[string]*core.Share, served, usedBy map[string]map[string]float64, providers map[string]map[string]bool, refs map[string]projectRef, remote map[string]bool) []usageProject {
	merged := map[string]*core.Share{}
	for id, sh := range shares {
		id = core.ViewSession(id)
		if merged[id] == nil {
			merged[id] = &core.Share{Session: id}
		}
		merged[id].Add(sh)
	}
	byName := map[string]*usageProject{}
	for id, sh := range merged {
		if sh.Requests == 0 {
			continue
		}
		meta, ref := sessionMeta(id), refs[id]
		p := byName[ref.Name]
		if p == nil {
			p = &usageProject{Name: ref.Name, Path: ref.Path}
			byName[ref.Name] = p
		}
		p.Used += sh.Used
		p.Requests += sh.Requests
		if sh.Last > p.Last {
			p.Last = sh.Last
		}
		p.Tokens.Input += sh.Tokens.Input
		p.Tokens.Output += sh.Tokens.Output
		p.Tokens.CacheRead += sh.Tokens.CacheRead
		p.Tokens.CacheWrite += sh.Tokens.CacheWrite
		accounts := []string{}
		for acct := range served[id] {
			accounts = append(accounts, acct)
		}
		sort.Slice(accounts, func(i, j int) bool {
			return served[id][accounts[i]] > served[id][accounts[j]] || (served[id][accounts[i]] == served[id][accounts[j]] && accounts[i] < accounts[j])
		})
		if usedBy[id] != nil && p.UsedBy == nil {
			p.UsedBy = map[string]float64{}
		}
		for provider, used := range usedBy[id] {
			p.UsedBy[provider] += used
		}
		p.Metered = p.Metered || sh.Metered
		used := []string{}
		for provider := range providers[id] {
			used = append(used, provider)
		}
		sort.Strings(used)
		p.Sessions = append(p.Sessions, usageSession{ID: id, Title: meta.Title, Used: sh.Used, Requests: sh.Requests, Last: sh.Last, Tokens: sh.Tokens, Accounts: accounts, Origin: meta.Origin, Remote: meta.Remote || remote[id], Device: meta.Device, UsedBy: usedBy[id], Metered: sh.Metered, Providers: used})
	}
	out := make([]usageProject, 0, len(byName))
	for _, p := range byName {
		sort.Slice(p.Sessions, func(i, j int) bool {
			a, b := p.Sessions[i], p.Sessions[j]
			return a.Used > b.Used || (a.Used == b.Used && a.Last > b.Last)
		})
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		return a.Used > b.Used || (a.Used == b.Used && a.Last > b.Last)
	})
	return out
}
