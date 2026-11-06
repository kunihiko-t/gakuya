// Command gakuya pauses a rendered video in the browser, lets a person point at what looks wrong, and hands that to the
// AI agent that started it. The agent runs `gakuya <video>` in the background and listens with `gakuya wait`.
package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// web holds the page, built by build.mjs. The .gitkeep lets the package compile before that.
//
//go:embed all:web
var web embed.FS

const root = ".gakuya"

const usage = `使い方：
  gakuya <動画> [--review 名前] [--reference 見本の動画] [--audio 音声か動画か reference] [--live 描画側のURL] [--no-open]
  gakuya wait [--review 名前]
  gakuya propose <指摘ID> --frames 先頭-末尾 --region '<[[x,y],…] 0〜1>' --text '<文>'
  gakuya done <指摘ID> --video <書き出し直した動画>
  gakuya timing [--bpm 数] [--offset 秒] [--cues <JSONファイル>]
  gakuya live <描画側のURL>
  gakuya knobs --file <JSONファイル>
  gakuya reload
  gakuya render --video <書き出し直した動画>`

func die(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

// parseArgs allows flags and positionals in any order. takesValue lists the flags with a value; others are switches.
func parseArgs(args []string, takesValue, switches []string) (map[string]string, []string) {
	values, positionals := map[string]string{}, []string{}
	contains := func(list []string, s string) bool {
		for _, item := range list {
			if item == s {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positionals = append(positionals, args[i+1:]...)
			break
		}
		name, ok := strings.CutPrefix(arg, "--")
		if !ok {
			if strings.HasPrefix(arg, "-") {
				die(fmt.Sprintf("知らないオプションです：%s\n%s", arg, usage))
			}
			positionals = append(positionals, arg)
			continue
		}
		name, inline, hasInline := strings.Cut(name, "=")
		switch {
		case contains(switches, name):
			values[name] = "true"
		case !contains(takesValue, name):
			die(fmt.Sprintf("知らないオプションです：%s\n%s", arg, usage))
		case hasInline:
			values[name] = inline
		case i+1 < len(args):
			i++
			values[name] = args[i]
		default:
			die(fmt.Sprintf("%s に値がありません", arg))
		}
	}
	return values, positionals
}

type serverInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func alive(pid int) bool {
	process, err := os.FindProcess(pid)
	return err == nil && process.Signal(syscall.Signal(0)) == nil
}

func readServer(name string) *serverInfo {
	data, err := os.ReadFile(filepath.Join(root, name, "server.json"))
	if err != nil {
		return nil
	}
	var info serverInfo
	if json.Unmarshal(data, &info) != nil || !alive(info.PID) {
		return nil
	}
	return &info
}

func findServer(review string) *serverInfo {
	const notRunning = "動いているレビューがありません。先に `gakuya <動画>` で起動してください。"
	if review != "" {
		info := readServer(review)
		if info == nil {
			die(notRunning)
		}
		return info
	}
	entries, _ := os.ReadDir(root)
	running := []string{}
	for _, entry := range entries {
		if readServer(entry.Name()) != nil {
			running = append(running, entry.Name())
		}
	}
	if len(running) == 0 {
		die(notRunning)
	}
	if len(running) > 1 {
		die("レビューが複数動いています。--review で選んでください：\n" + strings.Join(running, "\n"))
	}
	return readServer(running[0])
}

// call has no timeout: `gakuya wait` holds for as long as the person takes. No proxy either: this is always loopback.
func call(info *serverInfo, path string, body any) ([]byte, error) {
	method, payload := http.MethodGet, io.Reader(nil)
	if body != nil {
		data, err := encodeJSON(body, false)
		if err != nil {
			return nil, err
		}
		method, payload = http.MethodPost, bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", info.Port, path), payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	res, err := (&http.Client{Transport: &http.Transport{}}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("サーバーに接続できません：%w", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("サーバーとの接続が切れました：%w", err)
	}
	if res.StatusCode != http.StatusOK || !json.Valid(data) {
		var refused struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &refused) == nil && refused.Error != "" {
			return nil, errors.New(refused.Error)
		}
		return nil, fmt.Errorf("サーバーの応答が不正です（%d）", res.StatusCode)
	}
	return data, nil
}

func openBrowser(target string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if cmd.Start() == nil {
		go cmd.Wait()
	}
}

func serve(args []string) {
	values, positionals := parseArgs(args, []string{"review", "reference", "audio", "live"}, []string{"no-open"})
	if len(positionals) != 1 {
		die(usage)
	}
	video, err := filepath.Abs(positionals[0])
	if err != nil {
		die(err.Error())
	}
	if _, err := os.Stat(video); err != nil {
		die("動画が見つかりません：" + video)
	}
	var live *url.URL
	if raw, ok := values["live"]; ok {
		if live, err = checkLiveURL(raw); err != nil {
			die(err.Error())
		}
	}
	name := values["review"]
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		die("--review の名前にパスの区切りは使えません")
	}
	info, err := probeVideo(video)
	if err != nil {
		die(fmt.Sprintf("動画を読めません：%s（%v）", video, err))
	}
	if name == "" {
		sha, err := hashFile(video)
		if err != nil {
			die(err.Error())
		}
		if name, err = findReviewBySha(root, sha); err != nil {
			die(err.Error())
		}
		if name == "" {
			base := filepath.Base(video)
			name = strings.TrimSuffix(base, filepath.Ext(base))
		}
	}

	if running := readServer(name); running != nil {
		page := fmt.Sprintf("http://127.0.0.1:%d/?key=%s", running.Port, running.Token)
		fmt.Println("すでに動いています：" + page)
		if live != nil {
			fmt.Println("描画側につなぐには `gakuya live <URL>` を使ってください。")
		}
		if values["no-open"] == "" {
			openBrowser(page)
		}
		return
	}

	page, err := fs.Sub(web, "web")
	if err != nil {
		die(err.Error())
	}
	if _, err := fs.Stat(page, "index.html"); err != nil {
		die("画面が埋め込まれていません。`npm run build` で作り直してください。")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		die(err.Error())
	}
	store, err := OpenStore(absRoot, name)
	if err != nil {
		die(err.Error())
	}
	if _, err := store.AddVersion(video, info); err != nil {
		die(err.Error())
	}
	srv, err := startServer(store, page)
	if err != nil {
		die(err.Error())
	}
	if reference := values["reference"]; reference != "" {
		abs, err := filepath.Abs(reference)
		if err == nil {
			_, err = srv.applyReference(map[string]any{"path": abs})
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	if audio := values["audio"]; audio == "reference" {
		if _, err := srv.applySound(map[string]any{"reference": true}); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	} else if audio != "" {
		abs, err := filepath.Abs(audio)
		if err == nil {
			_, err = srv.applySound(map[string]any{"path": abs})
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	if live != nil {
		srv.connectLive(live)
	}
	serverFile := filepath.Join(store.Dir, "server.json")
	data, err := encodeJSON(serverInfo{srv.port, srv.token, os.Getpid()}, false)
	if err == nil {
		err = writeAtomic(serverFile, data, 0o600)
	}
	if err != nil {
		die(err.Error())
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	link := fmt.Sprintf("http://127.0.0.1:%d/?key=%s", srv.port, srv.token)
	fmt.Printf("レビュー「%s」を開きました：%s\n止めるには Ctrl+C を押してください。\n", name, link)
	if values["no-open"] == "" {
		openBrowser(link)
	}
	<-stop
	os.Remove(serverFile)
	srv.close()
}

var framesPattern = regexp.MustCompile(`^(\d+)-(\d+)$`)

func runPropose(args []string) {
	values, positionals := parseArgs(args, []string{"review", "frames", "region", "text"}, nil)
	text, hasText := values["text"]
	if len(positionals) != 1 || values["frames"] == "" || values["region"] == "" || !hasText {
		die(usage)
	}
	m := framesPattern.FindStringSubmatch(values["frames"])
	if m == nil {
		die("--frames は 1218-1252 の形にしてください")
	}
	var region any
	if json.Unmarshal([]byte(values["region"]), &region) != nil {
		die("--region は [[x,y],…] の JSON にしてください")
	}
	first, errFirst := strconv.Atoi(m[1])
	last, errLast := strconv.Atoi(m[2])
	if errFirst != nil || errLast != nil {
		die("--frames は 1218-1252 の形にしてください")
	}
	_, err := call(findServer(values["review"]), "/api/notes/"+url.PathEscape(positionals[0])+"/propose", map[string]any{"frames": []int{first, last}, "region": region, "text": text})
	if err != nil {
		die(err.Error())
	}
	fmt.Println("送りました。「はい」が来るまで修正に入らないでください。")
}

func runDone(args []string) {
	values, positionals := parseArgs(args, []string{"review", "video"}, nil)
	if len(positionals) != 1 || values["video"] == "" {
		die(usage)
	}
	video, err := filepath.Abs(values["video"])
	if err != nil {
		die(err.Error())
	}
	if _, err := call(findServer(values["review"]), "/api/notes/"+url.PathEscape(positionals[0])+"/done", map[string]any{"video": video}); err != nil {
		die(err.Error())
	}
	fmt.Println("新しい版を渡しました。")
}

func runTiming(args []string) {
	values, _ := parseArgs(args, []string{"review", "bpm", "offset", "cues"}, nil)
	body := map[string]any{"source": "agent"}
	number := func(flag, message string) {
		text, ok := values[flag]
		if !ok {
			return
		}
		n, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			die(message)
		}
		body[flag] = n
	}
	number("bpm", "--bpm は数にしてください")
	number("offset", "--offset は秒の数値にしてください")
	if file, ok := values["cues"]; ok {
		data, err := os.ReadFile(file)
		var cues any
		if err == nil {
			err = json.Unmarshal(data, &cues)
		}
		if err != nil {
			die("--cues を読めません：" + err.Error())
		}
		body["cues"] = cues
	}
	if _, err := call(findServer(values["review"]), "/api/timing", body); err != nil {
		die(err.Error())
	}
	fmt.Println("更新しました。")
}

func runLive(args []string) {
	values, positionals := parseArgs(args, []string{"review"}, nil)
	if len(positionals) != 1 {
		die(usage)
	}
	if _, err := call(findServer(values["review"]), "/api/live", map[string]any{"url": positionals[0]}); err != nil {
		die(err.Error())
	}
	fmt.Println("描画側につなぎました。")
}

func runKnobs(args []string) {
	values, _ := parseArgs(args, []string{"review", "file"}, nil)
	if values["file"] == "" {
		die(usage)
	}
	data, err := os.ReadFile(values["file"])
	var list any
	if err == nil {
		err = json.Unmarshal(data, &list)
	}
	if err != nil {
		die("--file を読めません：" + err.Error())
	}
	if _, err := call(findServer(values["review"]), "/api/knobs", list); err != nil {
		die(err.Error())
	}
	fmt.Println("つまみを出しました。")
}

func runReload(args []string) {
	values, _ := parseArgs(args, []string{"review"}, nil)
	if _, err := call(findServer(values["review"]), "/live/reload", map[string]any{}); err != nil {
		die(err.Error())
	}
	fmt.Println("描画側が設定を読み直しました。")
}

func runRender(args []string) {
	values, _ := parseArgs(args, []string{"review", "video"}, nil)
	if values["video"] == "" {
		die(usage)
	}
	video, err := filepath.Abs(values["video"])
	if err != nil {
		die(err.Error())
	}
	if _, err := call(findServer(values["review"]), "/api/versions", map[string]any{"video": video}); err != nil {
		die(err.Error())
	}
	fmt.Println("新しい版を渡しました。")
}

func runWait(args []string) {
	values, _ := parseArgs(args, []string{"review"}, nil)
	data, err := call(findServer(values["review"]), "/api/wait", nil)
	if err != nil {
		die(err.Error())
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, data, "", "  "); err != nil {
		die(err.Error())
	}
	fmt.Println(pretty.String())
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Println(usage)
		return
	}
	switch args[0] {
	case "wait":
		runWait(args[1:])
	case "propose":
		runPropose(args[1:])
	case "done":
		runDone(args[1:])
	case "timing":
		runTiming(args[1:])
	case "live":
		runLive(args[1:])
	case "knobs":
		runKnobs(args[1:])
	case "reload":
		runReload(args[1:])
	case "render":
		runRender(args[1:])
	default:
		serve(args)
	}
}
