package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

func bad(msg string) error { return &httpError{400, msg} }

var (
	mediaTypes = map[string]string{".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska"}
	staticFile = map[string]string{"/": "index.html", "/main.js": "main.js", "/style.css": "style.css"}
	staticType = map[string]string{".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}

	soundTypes = map[string]string{".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg"}

	versionRoute  = regexp.MustCompile(`^/media/version/([^/]+)$`)
	snapshotRoute = regexp.MustCompile(`^/notes/([^/]+)$`)
	analysisRoute = regexp.MustCompile(`^/api/analysis/([^/]+)$`)
	noteRoute     = regexp.MustCompile(`^/api/notes/([^/]+)/(propose|answer|done)$`)
	colorPattern  = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
	pngMagic      = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
)

const maxJSON = 64 * 1024 * 1024

// Body fields stay loose until checked, so each bad value gets its own message.
func field(body any, key string) (any, bool) {
	m, ok := body.(map[string]any)
	if !ok {
		return nil, false
	}
	v, ok := m[key]
	return v, ok
}

func asInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
		return 0, false
	}
	return int(f), true
}

func checkPoints(v any, name string) ([]Pt, error) {
	refused := bad(name + " は 0〜1 の [x, y] の配列にしてください")
	list, ok := v.([]any)
	if !ok || len(list) == 0 {
		return nil, refused
	}
	out := make([]Pt, len(list))
	for i, item := range list {
		p, ok := item.([]any)
		if !ok || len(p) != 2 {
			return nil, refused
		}
		for j := range p {
			c, ok := p[j].(float64)
			if !ok || c < 0 || c > 1 {
				return nil, refused
			}
			out[i][j] = c
		}
	}
	return out, nil
}

func checkRange(v any, frames int) ([2]int, error) {
	refused := bad(fmt.Sprintf("コマの範囲は 0〜%d の [先頭, 末尾] にしてください", frames-1))
	list, ok := v.([]any)
	if !ok || len(list) != 2 {
		return [2]int{}, refused
	}
	a, okA := asInt(list[0])
	b, okB := asInt(list[1])
	if !okA || !okB || a < 0 || b >= frames || a > b {
		return [2]int{}, refused
	}
	return [2]int{a, b}, nil
}

func checkAnchor(v any, frames int) (Anchor, error) {
	raw, _ := field(v, "frame")
	frame, ok := asInt(raw)
	if !ok || frame < 0 || frame >= frames {
		return Anchor{}, bad("anchor.frame が範囲の外です")
	}
	shape, _ := field(v, "shape")
	if list, ok := shape.([]any); ok && len(list) == 0 {
		return Anchor{Frame: frame, Shape: []Pt{}}, nil
	}
	points, err := checkPoints(shape, "anchor.shape")
	return Anchor{Frame: frame, Shape: points}, err
}

// checkTiming validates everything first, and returns what to apply.
func checkTiming(body any) (func(*Timing), error) {
	var apply []func(*Timing)
	if v, ok := field(body, "bpm"); ok {
		bpm, isNum := v.(float64)
		if v != nil && (!isNum || bpm <= 0) {
			return nil, bad("bpm は正の数にしてください")
		}
		apply = append(apply, func(t *Timing) {
			t.BPM = nil
			if v != nil {
				t.BPM = &bpm
			}
		})
	}
	if v, ok := field(body, "offset"); ok {
		offset, isNum := v.(float64)
		if !isNum {
			return nil, bad("offset は秒の数値にしてください")
		}
		apply = append(apply, func(t *Timing) { t.Offset = offset })
	}
	if v, ok := field(body, "source"); ok {
		source, _ := v.(string)
		if source != "auto" && source != "manual" && source != "agent" {
			return nil, bad("source が不正です")
		}
		apply = append(apply, func(t *Timing) { t.Source = source })
	}
	if v, ok := field(body, "cues"); ok {
		refused := bad("cues は { time, label? } の配列にしてください")
		list, isList := v.([]any)
		if !isList {
			return nil, refused
		}
		cues := make([]Cue, len(list))
		for i, item := range list {
			raw, _ := field(item, "time")
			at, isNum := raw.(float64)
			if !isNum {
				return nil, refused
			}
			cues[i].Time = at
			if rawLabel, has := field(item, "label"); has {
				label, isText := rawLabel.(string)
				if !isText {
					return nil, refused
				}
				cues[i].Label = &label
			}
		}
		apply = append(apply, func(t *Timing) { t.Cues = cues })
	}
	return func(t *Timing) {
		for _, fn := range apply {
			fn(t)
		}
	}, nil
}

// waiter is one held GET /api/wait.
type waiter struct{ event chan GakuyaEvent }

// server is the only writer of the review, shared by the page and the CLI.
type server struct {
	store *Store
	web   fs.FS
	token string
	port  int
	http  *http.Server

	mu       sync.Mutex
	waiters  []*waiter
	inflight bool // an event has been handed to a waiter and is not yet written
	streams  map[chan struct{}]struct{}

	// The renderer, when there is one. See live.go.
	liveURL     *url.URL
	liveRelay   *httputil.ReverseProxy
	liveProblem string
	liveKnobs   []string
}

func startServer(store *Store, web fs.FS) (*server, error) {
	key := make([]byte, 24)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &server{
		store: store, web: web, token: hex.EncodeToString(key),
		port: listener.Addr().(*net.TCPAddr).Port, streams: map[chan struct{}]struct{}{},
	}
	s.http = &http.Server{Handler: s}
	store.OnChange(func() { s.broadcast(); s.pump() })
	go s.http.Serve(listener)
	return s, nil
}

func (s *server) close() { s.http.Close() }

// broadcast wakes the streams. Each sends the latest state when it wakes, so changes in a burst collapse into one.
func (s *server) broadcast() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.streams {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// pump hands the oldest event to the oldest waiter. It counts as delivered only once the response is written.
func (s *server) pump() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight || len(s.waiters) == 0 {
		return
	}
	event := s.store.NextEvent()
	if event == nil {
		return
	}
	w := s.waiters[0]
	s.waiters = s.waiters[1:]
	s.inflight = true
	w.event <- *event
}

func (s *server) finishDelivery() {
	s.mu.Lock()
	s.inflight = false
	s.mu.Unlock()
	s.pump()
}

func (s *server) state() ([]byte, error) {
	s.mu.Lock()
	waiting := len(s.waiters)
	var live *liveState
	if s.liveURL != nil {
		live = &liveState{Problem: s.liveProblem}
	}
	s.mu.Unlock()
	return encodeJSON(struct {
		Review  Review     `json:"review"`
		Waiting int        `json:"waiting"`
		Live    *liveState `json:"live"`
	}{s.store.Review(), waiting, live}, false)
}

type liveState struct {
	Problem string `json:"problem"`
}

func (s *server) sameToken(t string) bool {
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *server) authed(r *http.Request) bool {
	if bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && s.sameToken(bearer) {
		return true
	}
	cookie, err := r.Cookie(fmt.Sprintf("gakuya_%d", s.port))
	return err == nil && s.sameToken(cookie.Value)
}

func (s *server) localOrigin(r *http.Request) bool {
	hosts := []string{fmt.Sprintf("127.0.0.1:%d", s.port), fmt.Sprintf("localhost:%d", s.port)}
	if r.Host != hosts[0] && r.Host != hosts[1] {
		return false
	}
	origin := r.Header.Get("Origin")
	return origin == "" || origin == "http://"+hosts[0] || origin == "http://"+hosts[1]
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.localOrigin(r) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, "forbidden")
		return
	}
	if err := s.route(w, r); err != nil {
		status := http.StatusInternalServerError
		var known *httpError
		if errors.As(err, &known) {
			status = known.status
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		writeJSON(w, map[string]string{"error": err.Error()})
	}
}

func writeJSON(w http.ResponseWriter, v any) error {
	data, err := encodeJSON(v, false)
	if err != nil {
		return err
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	_, err = w.Write(data)
	return err
}

func sendFile(w http.ResponseWriter, r *http.Request, path, kind string) error {
	file, err := os.Open(path)
	if err != nil {
		return &httpError{404, "見つかりません"}
	}
	defer file.Close()
	w.Header().Set("Content-Type", kind)
	http.ServeContent(w, r, "", time.Time{}, file)
	return nil
}

func mediaType(path string) string {
	if kind, ok := mediaTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return kind
	}
	return "application/octet-stream"
}

// segment is a matched path part, percent-decoded only now: an encoded slash must not reach a file path as a slash.
func segment(escaped string) (string, error) {
	part, err := url.PathUnescape(escaped)
	if err != nil {
		return "", &httpError{404, "見つかりません"}
	}
	return part, nil
}

func (s *server) route(w http.ResponseWriter, r *http.Request) error {
	path := r.URL.EscapedPath()
	if key := r.URL.Query(); path == "/" && key.Has("key") {
		if !s.sameToken(key.Get("key")) {
			return &httpError{401, "鍵が違います"}
		}
		w.Header().Set("Set-Cookie", fmt.Sprintf("gakuya_%d=%s; HttpOnly; SameSite=Strict; Path=/", s.port, s.token))
		w.Header().Set("Location", "/")
		w.WriteHeader(http.StatusFound)
		return nil
	}
	if !s.authed(r) {
		return &httpError{401, "トークンが必要です"}
	}
	if strings.HasPrefix(path, "/live/") {
		return s.relayLive(w, r, path)
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		return s.routeGet(w, r, path)
	case http.MethodPost:
		return s.routePost(w, r, path)
	}
	return &httpError{405, "この操作はできません"}
}

func (s *server) routeGet(w http.ResponseWriter, r *http.Request, path string) error {
	if name, ok := staticFile[path]; ok {
		data, err := fs.ReadFile(s.web, name)
		if err != nil {
			return &httpError{404, "見つかりません"}
		}
		w.Header().Set("Content-Type", staticType[filepath.Ext(name)])
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
		return nil
	}
	switch path {
	case "/api/review":
		return writeJSON(w, s.store.Review())
	case "/api/stream":
		return s.handleStream(w, r)
	case "/api/wait":
		return s.handleWait(w, r)
	case "/media/sound":
		review := s.store.Review()
		if review.Sound == nil || (review.Sound.Reference && review.Reference == nil) {
			return &httpError{404, "音がありません"}
		}
		path := review.Sound.Path
		if review.Sound.Reference {
			path = review.Reference.Path
		}
		return sendFile(w, r, path, soundType(path))
	case "/media/reference":
		ref := s.store.Review().Reference
		if ref == nil {
			return &httpError{404, "見本がありません"}
		}
		return sendFile(w, r, ref.Path, mediaType(ref.Path))
	}
	if m := versionRoute.FindStringSubmatch(path); m != nil {
		id, err := segment(m[1])
		if err != nil {
			return err
		}
		v, err := s.store.Version(id)
		if err != nil {
			return &httpError{404, "版がありません"}
		}
		return sendFile(w, r, s.store.VersionPath(v), mediaType(v.File))
	}
	if m := snapshotRoute.FindStringSubmatch(path); m != nil {
		name, err := segment(m[1])
		if err != nil {
			return err
		}
		for _, n := range s.store.Review().Notes {
			for _, file := range n.Snapshots {
				if file == name {
					return sendFile(w, r, filepath.Join(s.store.Dir, "notes", name), "image/png")
				}
			}
		}
		return &httpError{404, "見つかりません"}
	}
	if m := analysisRoute.FindStringSubmatch(path); m != nil {
		file, err := s.analysisFile(m[1])
		if err != nil {
			return err
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return &httpError{404, "まだ解析していません"}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, err = w.Write(data)
		return err
	}
	return &httpError{404, "見つかりません"}
}

func (s *server) analysisFile(escaped string) (string, error) {
	id, err := segment(escaped)
	if err != nil {
		return "", err
	}
	if _, err := s.store.Version(id); err != nil {
		return "", &httpError{404, "版がありません"}
	}
	return filepath.Join(s.store.Dir, "analysis", id+".json"), nil
}

func (s *server) handleStream(w http.ResponseWriter, r *http.Request) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("streaming is not supported")
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	wake := make(chan struct{}, 1)
	s.mu.Lock()
	s.streams[wake] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.streams, wake)
		s.mu.Unlock()
	}()
	for {
		state, err := s.state()
		if err != nil {
			return nil
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", state); err != nil {
			return nil
		}
		flusher.Flush()
		select {
		case <-wake:
		case <-r.Context().Done():
			return nil
		}
	}
}

// handleWait holds the request until there is an event. Headers go out at once, so the client knows it got through.
func (s *server) handleWait(w http.ResponseWriter, r *http.Request) error {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("streaming is not supported")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	me := &waiter{event: make(chan GakuyaEvent, 1)}
	s.mu.Lock()
	s.waiters = append(s.waiters, me)
	s.mu.Unlock()
	defer s.broadcast()
	s.broadcast()
	s.pump()

	select {
	case event := <-me.event:
		s.deliver(w, flusher, event)
	case <-r.Context().Done():
		s.mu.Lock()
		queued := false
		for i, other := range s.waiters {
			if other == me {
				s.waiters = append(s.waiters[:i:i], s.waiters[i+1:]...)
				queued = true
				break
			}
		}
		s.mu.Unlock()
		if !queued { // pump handed this waiter an event just as it went away
			s.finishDelivery()
		}
	}
	return nil
}

// deliver writes the event and only then marks it delivered. If the client is gone the event stays for the next wait.
// The response ends when the handler returns, so the client sees the end only after the mark is on disk.
func (s *server) deliver(w http.ResponseWriter, flusher http.Flusher, event GakuyaEvent) {
	defer s.finishDelivery()
	if event.Type == "settled" {
		s.deliverSettled(w, flusher, event)
		return
	}
	note, err := s.store.Note(event.NoteID)
	if err != nil {
		return
	}
	version, err := s.store.Version(note.Version)
	if err != nil {
		return
	}
	shots := make([]string, len(note.Snapshots))
	for i, file := range note.Snapshots {
		shots[i] = filepath.Join(s.store.Dir, "notes", file)
	}
	if err := writeJSON(w, map[string]any{"event": event, "note": note, "snapshots": shots, "video": s.store.VersionPath(version)}); err != nil {
		return
	}
	flusher.Flush()
	s.store.MarkDelivered(event.Seq)
}

// saveSnapshots validates every upload first, so a refused note leaves no files.
func (s *server) saveSnapshots(id string, uploads any) ([]string, error) {
	files := []string{}
	if uploads == nil {
		return files, nil
	}
	list, ok := uploads.([]any)
	if !ok {
		return nil, bad("snapshots は配列にしてください")
	}
	contents := make([][]byte, len(list))
	for i, item := range list {
		raw, _ := field(item, "frame")
		frame, ok := asInt(raw)
		if !ok || frame < 0 {
			return nil, bad("スナップショットの frame が不正です")
		}
		rawKind, _ := field(item, "kind")
		kind, _ := rawKind.(string)
		if kind != "raw" && kind != "marked" {
			return nil, bad("スナップショットの kind が不正です")
		}
		rawData, _ := field(item, "data")
		text, _ := rawData.(string)
		data, _ := base64.StdEncoding.DecodeString(text)
		if !bytes.HasPrefix(data, pngMagic) {
			return nil, bad("スナップショットが PNG ではありません")
		}
		contents[i] = data
		files = append(files, fmt.Sprintf("%s-%d-%s.png", id, frame, kind))
	}
	for i, file := range files {
		if err := os.WriteFile(filepath.Join(s.store.Dir, "notes", file), contents[i], 0o644); err != nil {
			return nil, err
		}
	}
	return files, nil
}

func (s *server) routePost(w http.ResponseWriter, r *http.Request, path string) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSON))
	if err != nil {
		return &httpError{413, "大きすぎます"}
	}
	var body any
	if json.Unmarshal(raw, &body) != nil {
		return bad("JSON が読めません")
	}
	switch path {
	case "/api/notes":
		return s.createNote(w, body)
	case "/api/timing":
		apply, err := checkTiming(body)
		if err != nil {
			return err
		}
		if err := s.store.SetTiming(apply); err != nil {
			return err
		}
		return writeJSON(w, s.store.Review().Timing)
	case "/api/reference":
		ref, err := s.applyReference(body)
		if err != nil {
			return err
		}
		return writeJSON(w, ref)
	case "/api/sound":
		sound, err := s.applySound(body)
		if err != nil {
			return err
		}
		return writeJSON(w, sound)
	case "/api/knobs":
		return s.applyKnobs(w, body)
	case "/api/settled":
		return s.settle(w, body)
	case "/api/live":
		return s.applyLive(w, body)
	case "/api/versions":
		return s.addRender(w, body)
	}
	if m := noteRoute.FindStringSubmatch(path); m != nil {
		id, err := segment(m[1])
		if err != nil {
			return err
		}
		return s.changeNote(w, id, m[2], body)
	}
	if m := analysisRoute.FindStringSubmatch(path); m != nil {
		file, err := s.analysisFile(m[1])
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(file, raw, 0o644); err != nil {
			return err
		}
		return writeJSON(w, nil)
	}
	return &httpError{404, "見つかりません"}
}

func (s *server) createNote(w http.ResponseWriter, body any) error {
	review := s.store.Review()
	rawVersion, _ := field(body, "version")
	version, isText := rawVersion.(string)
	if !isText && len(review.Versions) > 0 {
		version = review.Versions[len(review.Versions)-1].ID
	}
	v, err := s.store.Version(version)
	if err != nil {
		return bad("その版はありません")
	}
	rawFrames, _ := field(body, "frames")
	frames, err := checkRange(rawFrames, v.Frames)
	if err != nil {
		return err
	}
	rawAnchor, _ := field(body, "anchor")
	anchor, err := checkAnchor(rawAnchor, v.Frames)
	if err != nil {
		return err
	}
	rawText, _ := field(body, "text")
	text, isText := rawText.(string)
	if !isText {
		return bad("text は文字列にしてください")
	}
	var color *string
	if rawColor, _ := field(body, "color"); rawColor != nil {
		c, isText := rawColor.(string)
		if !isText || !colorPattern.MatchString(c) {
			return bad("color は #rrggbb にしてください")
		}
		color = &c
	}
	uploads, _ := field(body, "snapshots")
	note, err := s.store.CreateNote(NewNote{Frames: frames, Anchor: anchor, Text: text, Color: color, Version: version}, func(id string) ([]string, error) {
		return s.saveSnapshots(id, uploads)
	})
	if err != nil {
		return err
	}
	return writeJSON(w, note)
}

// changeNote is the one place a note moves. Anything the store refuses is a conflict with the note's status.
func (s *server) changeNote(w http.ResponseWriter, id, action string, body any) error {
	note, err := s.store.Note(id)
	if err != nil {
		return &httpError{404, fmt.Sprintf("指摘 %s はありません", id)}
	}
	v, err := s.store.Version(note.Version)
	if err != nil {
		return err
	}
	switch action {
	case "propose":
		err = s.propose(id, body, v.Frames)
	case "answer":
		err = s.answer(id, body, v.Frames)
	case "done":
		err = s.done(id, body, note)
	}
	if err != nil {
		var known *httpError
		if errors.As(err, &known) {
			return err
		}
		return &httpError{409, err.Error()}
	}
	updated, err := s.store.Note(id)
	if err != nil {
		return err
	}
	return writeJSON(w, updated)
}

func (s *server) propose(id string, body any, frames int) error {
	rawText, _ := field(body, "text")
	text, isText := rawText.(string)
	if !isText {
		return bad("text は文字列にしてください")
	}
	rawFrames, _ := field(body, "frames")
	span, err := checkRange(rawFrames, frames)
	if err != nil {
		return err
	}
	rawRegion, _ := field(body, "region")
	region, err := checkPoints(rawRegion, "region")
	if err != nil {
		return err
	}
	return s.store.Propose(id, Proposal{Frames: span, Region: region, Text: text})
}

func (s *server) answer(id string, body any, frames int) error {
	rawAnswer, _ := field(body, "answer")
	answer, _ := rawAnswer.(string)
	if _, ok := answerFrom[answer]; !ok {
		return bad("answer が不正です")
	}
	a := Answer{Answer: answer}
	if rawReason, _ := field(body, "reason"); rawReason != nil {
		reason, isText := rawReason.(string)
		if !isText {
			return bad("reason は文字列にしてください")
		}
		a.Reason = &reason
	}
	if edit, _ := field(body, "edit"); edit != nil {
		a.Edit = &AnswerEdit{}
		if raw, _ := field(edit, "frames"); raw != nil {
			span, err := checkRange(raw, frames)
			if err != nil {
				return err
			}
			a.Edit.Frames = &span
		}
		if raw, _ := field(edit, "anchor"); raw != nil {
			anchor, err := checkAnchor(raw, frames)
			if err != nil {
				return err
			}
			a.Edit.Anchor = &anchor
		}
		if raw, _ := field(edit, "snapshots"); raw != nil {
			files, err := s.saveSnapshots(id, raw)
			if err != nil {
				return err
			}
			a.Edit.Snapshots = files
		}
	}
	return s.store.Answer(id, a)
}

func (s *server) done(id string, body any, note Note) error {
	rawVideo, _ := field(body, "video")
	video, isText := rawVideo.(string)
	if !isText || !filepath.IsAbs(video) {
		return bad("video は絶対パスにしてください")
	}
	if note.Status != "confirmed" {
		return fmt.Errorf("%s の指摘は完了にできません。先に「はい」が要ります", note.Status)
	}
	info, err := probeVideo(video)
	if err != nil {
		return bad(fmt.Sprintf("動画を読めません：%s（%v）", video, err))
	}
	v, err := s.store.AddVersion(video, info)
	if err != nil {
		return err
	}
	return s.store.Done(id, v.ID)
}

// soundType also refuses anything that is not sound or video, so the page cannot read other files through this.
func soundType(path string) string {
	if kind, ok := soundTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return kind
	}
	return mediaTypes[strings.ToLower(filepath.Ext(path))]
}

// applySound chooses the sound from an API body: null is the video's own, a missing field keeps its current value.
func (s *server) applySound(body any) (*Sound, error) {
	if body == nil {
		return nil, s.store.SetSound(nil)
	}
	if raw, _ := field(body, "reference"); raw == true {
		if s.store.Review().Reference == nil {
			return nil, bad("見本がありません")
		}
		sound := Sound{Reference: true}
		return &sound, s.store.SetSound(&sound)
	}
	sound := Sound{}
	if current := s.store.Review().Sound; current != nil && !current.Reference {
		sound = *current
	}
	if raw, _ := field(body, "offsetSeconds"); raw != nil {
		offset, isNum := raw.(float64)
		if !isNum {
			return nil, bad("offsetSeconds は秒の数値にしてください")
		}
		sound.OffsetSeconds = offset
	}
	if raw, _ := field(body, "path"); raw != nil {
		path, isText := raw.(string)
		if !isText {
			return nil, bad("音のパスは絶対パスにしてください")
		}
		sound.Path = path
	}
	if !filepath.IsAbs(sound.Path) {
		return nil, bad("音のパスは絶対パスにしてください")
	}
	if soundType(sound.Path) == "" {
		return nil, bad(fmt.Sprintf("音声か動画のファイルを指定してください：%s", sound.Path))
	}
	if info, err := os.Stat(sound.Path); err != nil || info.IsDir() {
		return nil, bad(fmt.Sprintf("音のファイルを読めません：%s", sound.Path))
	}
	return &sound, s.store.SetSound(&sound)
}

// applyReference sets the reference video from an API body: null clears it, a missing field keeps its current value.
func (s *server) applyReference(body any) (*Reference, error) {
	if body == nil {
		return nil, s.store.SetReference(nil)
	}
	current := s.store.Review().Reference
	ref := Reference{}
	if current != nil {
		ref = *current
	}
	if raw, _ := field(body, "offsetSeconds"); raw != nil {
		offset, isNum := raw.(float64)
		if !isNum {
			return nil, bad("offsetSeconds は秒の数値にしてください")
		}
		ref.OffsetSeconds = offset
	}
	if raw, _ := field(body, "path"); raw != nil {
		path, isText := raw.(string)
		if !isText {
			return nil, bad("見本のパスは絶対パスにしてください")
		}
		ref.Path = path
	}
	if !filepath.IsAbs(ref.Path) {
		return nil, bad("見本のパスは絶対パスにしてください")
	}
	if current == nil || ref.Path != current.Path {
		if _, err := probeVideo(ref.Path); err != nil {
			return nil, bad(fmt.Sprintf("見本の動画を読めません：%s（%v）", ref.Path, err))
		}
	}
	return &ref, s.store.SetReference(&ref)
}
