package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"
)

// The renderer is a separate program that draws the picture. The contract is in docs/live-renderer.md.

const (
	notResponding = "描画側が応答していません"
	liveCheck     = time.Second
)

// relayed is the whole contract: nothing else on the renderer can be reached through the page's token.
var relayed = map[string]string{"/live/info": http.MethodGet, "/live/frame": http.MethodGet, "/live/knobs": http.MethodPost, "/live/reload": http.MethodPost}

// checkLiveURL takes only this machine: the relay would otherwise let the page reach other hosts.
func checkLiveURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	refused := fmt.Errorf("--live には手元のアドレス（http://127.0.0.1:ポート）を指定してください：%s", raw)
	if err != nil || u.Scheme != "http" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return nil, refused
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, refused
	}
	return u, nil
}

// connectLive points the relay at a renderer. Calling it again moves the relay; the one watcher follows.
func (s *server) connectLive(target *url.URL) {
	relay := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, "/live")
			// The token, the cookie and where the request came from are between the page and this server.
			for _, name := range []string{"Authorization", "Cookie", "Origin", "Referer"} {
				r.Out.Header.Del(name)
			}
		},
		Transport: &http.Transport{ResponseHeaderTimeout: 5 * time.Second},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			writeJSON(w, map[string]string{"error": notResponding})
		},
	}
	s.mu.Lock()
	first := s.liveURL == nil
	s.liveURL, s.liveRelay, s.liveProblem, s.liveKnobs = target, relay, notResponding, nil
	s.mu.Unlock()
	s.broadcast()
	if first {
		go s.watchLive()
	}
}

type rendererInfo struct {
	VideoInfo
	Knobs []string `json:"knobs"`
}

// watchLive says when the renderer stops answering, or stops matching the video. The page shows whatever this finds.
func (s *server) watchLive() {
	client := &http.Client{Timeout: liveCheck, Transport: &http.Transport{}}
	for {
		s.mu.Lock()
		target := s.liveURL
		s.mu.Unlock()
		problem, knobs := s.checkRenderer(client, target)
		s.mu.Lock()
		changed := s.liveURL == target && s.liveProblem != problem
		if s.liveURL == target {
			s.liveProblem, s.liveKnobs = problem, knobs
		}
		s.mu.Unlock()
		if changed {
			s.broadcast()
		}
		time.Sleep(liveCheck)
	}
}

func (s *server) checkRenderer(client *http.Client, target *url.URL) (string, []string) {
	res, err := client.Get(target.JoinPath("info").String())
	if err != nil {
		return notResponding, nil
	}
	defer res.Body.Close()
	var info rendererInfo
	if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&info) != nil {
		return notResponding, nil
	}
	versions := s.store.Review().Versions
	if len(versions) == 0 {
		return "", info.Knobs
	}
	v := versions[len(versions)-1]
	if v.Frames != info.Frames {
		return fmt.Sprintf("コマ数が動画と違います（動画 %d、描画側 %d）", v.Frames, info.Frames), info.Knobs
	}
	if math.Abs(v.FPS-info.FPS) > 0.01 {
		return fmt.Sprintf("fps が動画と違います（動画 %g、描画側 %g）", v.FPS, info.FPS), info.Knobs
	}
	return "", info.Knobs
}

func (s *server) relayLive(w http.ResponseWriter, r *http.Request, path string) error {
	if method, ok := relayed[path]; !ok || method != r.Method {
		return &httpError{404, "見つかりません"}
	}
	s.mu.Lock()
	relay := s.liveRelay
	s.mu.Unlock()
	if relay == nil {
		return &httpError{409, "描画側につながっていません"}
	}
	relay.ServeHTTP(w, r)
	return nil
}

// checkKnobs validates the list before it replaces the one on screen.
func checkKnobs(body any, known []string) ([]Knob, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, bad("つまみは配列にしてください")
	}
	var list []Knob
	if _, isList := body.([]any); !isList || json.Unmarshal(data, &list) != nil {
		return nil, bad("つまみは { id, label, min, max, default, scale, scope } の配列にしてください")
	}
	seen := map[string]bool{}
	for _, k := range list {
		name := fmt.Sprintf("つまみ %q ", k.ID)
		switch {
		case k.ID == "" || k.Label == "":
			return nil, bad(name + "には id と label が要ります")
		case seen[k.ID]:
			return nil, bad(name + "の id が重なっています")
		case k.Min == k.Max:
			return nil, bad(name + "の min と max が同じです")
		case k.Scale != "linear" && k.Scale != "log":
			return nil, bad(name + "の scale は linear か log にしてください")
		case k.Scale == "log" && (k.Min <= 0 || k.Max <= 0):
			return nil, bad(name + "は log なので min と max を正の数にしてください")
		case k.Scope != "global" && k.Scope != "range":
			return nil, bad(name + "の scope は global か range にしてください")
		case k.Default != nil && !k.holds(*k.Default):
			return nil, bad(name + "の default が min と max の外です")
		case known != nil && !slices.Contains(known, k.ID):
			return nil, bad(name + "を描画側は知りません。描画側に足してから出してください")
		}
		seen[k.ID] = true
	}
	return list, nil
}

func (k Knob) holds(v float64) bool {
	return v >= math.Min(k.Min, k.Max) && v <= math.Max(k.Min, k.Max)
}

func (s *server) applyKnobs(w http.ResponseWriter, body any) error {
	s.mu.Lock()
	known := s.liveKnobs
	s.mu.Unlock()
	list, err := checkKnobs(body, known)
	if err != nil {
		return err
	}
	if err := s.store.SetKnobs(list); err != nil {
		return err
	}
	return writeJSON(w, list)
}

// settle is the person saying "about this much". Nothing reaches the agent before it.
func (s *server) settle(w http.ResponseWriter, body any) error {
	review := s.store.Review()
	if len(review.Versions) == 0 {
		return bad("動画がありません")
	}
	frames := review.Versions[len(review.Versions)-1].Frames
	raw, _ := field(body, "values")
	entries, isMap := raw.(map[string]any)
	if !isMap {
		return bad("values は { id: 値 } にしてください")
	}
	values := make(map[string]*float64, len(entries))
	for id, entry := range entries {
		i := slices.IndexFunc(review.Knobs, func(k Knob) bool { return k.ID == id })
		if i < 0 {
			return bad(fmt.Sprintf("つまみ %q はありません", id))
		}
		values[id] = nil
		if entry == nil {
			continue
		}
		v, isNum := entry.(float64)
		if !isNum || !review.Knobs[i].holds(v) {
			return bad(fmt.Sprintf("つまみ %q の値が範囲の外です", id))
		}
		values[id] = &v
	}
	var span *[2]int
	if rawFrames, _ := field(body, "frames"); rawFrames != nil {
		checked, err := checkRange(rawFrames, frames)
		if err != nil {
			return err
		}
		span = &checked
	}
	rawFrame, _ := field(body, "frame")
	frame, isInt := asInt(rawFrame)
	if !isInt || frame < 0 || frame >= frames {
		return bad("frame が範囲の外です")
	}
	if err := s.store.PushSettled(values, span, frame); err != nil {
		return err
	}
	return writeJSON(w, nil)
}

// deliverSettled has no note behind it: the agent gets the values, the video and the tempo to turn beats into frames.
func (s *server) deliverSettled(w http.ResponseWriter, flusher http.Flusher, event GakuyaEvent) {
	review := s.store.Review()
	if len(review.Versions) == 0 {
		return
	}
	video := s.store.VersionPath(review.Versions[len(review.Versions)-1])
	if err := writeJSON(w, map[string]any{"event": event, "video": video, "timing": review.Timing}); err != nil {
		return
	}
	flusher.Flush()
	s.store.MarkDelivered(event.Seq)
}

// addRender takes a new render when the work began in conversation, with no note to close.
func (s *server) addRender(w http.ResponseWriter, body any) error {
	raw, _ := field(body, "video")
	video, isText := raw.(string)
	if !isText || !strings.HasPrefix(video, "/") {
		return bad("video は絶対パスにしてください")
	}
	info, err := probeVideo(video)
	if err != nil {
		return bad(fmt.Sprintf("動画を読めません：%s（%v）", video, err))
	}
	v, err := s.store.AddVersion(video, info)
	if err != nil {
		return err
	}
	return writeJSON(w, v)
}

func (s *server) applyLive(w http.ResponseWriter, body any) error {
	raw, _ := field(body, "url")
	text, _ := raw.(string)
	target, err := checkLiveURL(text)
	if err != nil {
		return bad(err.Error())
	}
	s.connectLive(target)
	return writeJSON(w, nil)
}
