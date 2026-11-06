package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var testInfo = VideoInfo{FPS: 30, Frames: 300, Width: 640, Height: 360}
var testNote = NewNote{Frames: [2]int{10, 20}, Anchor: Anchor{Frame: 12, Shape: []Pt{{0.4, 0.6}}}, Text: "sleeve shows skin"}
var testProposal = Proposal{Frames: [2]int{1, 2}, Region: []Pt{}, Text: "?"}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func ok(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func refused(t *testing.T, err error, what string) {
	t.Helper()
	if err == nil {
		t.Errorf("%s should have been refused", what)
	}
}

func write(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	ok(t, os.WriteFile(path, []byte(content), 0o644))
	return path
}

func withVideo(t *testing.T) (*Store, string, string) {
	t.Helper()
	dir := t.TempDir()
	video := write(t, dir, "a.mp4", "video-one")
	store := must(OpenStore(filepath.Join(dir, ".gakuya"), "a"))
	must(store.AddVersion(video, testInfo))
	return store, dir, video
}

func status(t *testing.T, s *Store, id string) NoteStatus {
	t.Helper()
	return must(s.Note(id)).Status
}

func TestWholeFlow(t *testing.T) {
	store, dir, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	if n.Status != "open" {
		t.Fatal(n.Status)
	}
	ok(t, store.Propose(n.ID, Proposal{Frames: [2]int{11, 19}, Region: []Pt{{0.1, 0.1}}, Text: "here?"}))
	if status(t, store, n.ID) != "proposed" {
		t.Fatal("not proposed")
	}
	ok(t, store.Answer(n.ID, Answer{Answer: "yes"}))
	if status(t, store, n.ID) != "confirmed" {
		t.Fatal("not confirmed")
	}
	v2 := must(store.AddVersion(write(t, dir, "b.mp4", "video-two"), testInfo))
	ok(t, store.Done(n.ID, v2.ID))
	got := must(store.Note(n.ID))
	if got.Status != "fixed" || got.Version != v2.ID {
		t.Fatalf("%+v", got)
	}
	reason := "still there"
	ok(t, store.Answer(n.ID, Answer{Answer: "not_yet", Reason: &reason}))
	got = must(store.Note(n.ID))
	if got.Status != "confirmed" || got.Reason == nil || *got.Reason != reason {
		t.Fatalf("%+v", got)
	}
	ok(t, store.Done(n.ID, v2.ID))
	ok(t, store.Answer(n.ID, Answer{Answer: "resolved"}))
	if status(t, store, n.ID) != "resolved" {
		t.Fatal("not resolved")
	}
}

func TestNoSendsBackAndAppliesEdit(t *testing.T) {
	store, _, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	ok(t, store.Propose(n.ID, testProposal))
	reason := "the other arm"
	ok(t, store.Answer(n.ID, Answer{Answer: "no", Reason: &reason, Edit: &AnswerEdit{Frames: &[2]int{30, 40}}}))
	after := must(store.Note(n.ID))
	if after.Status != "open" || *after.Reason != reason || after.Frames != [2]int{30, 40} || after.Proposal != nil {
		t.Fatalf("%+v", after)
	}
}

func TestIllegalTransitions(t *testing.T) {
	store, _, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	v := store.Review().Versions[0].ID
	refused(t, store.Done(n.ID, v), "done before yes")
	refused(t, store.Answer(n.ID, Answer{Answer: "yes"}), "yes without a proposal")
	refused(t, store.Answer(n.ID, Answer{Answer: "resolved"}), "resolved while open")
	refused(t, store.Done("nope", v), "done on a missing note")
	ok(t, store.Propose(n.ID, testProposal))
	refused(t, store.Done(n.ID, v), "a fix must wait for yes")
	refused(t, store.Answer(n.ID, Answer{Answer: "not_yet"}), "not_yet while proposed")
	if status(t, store, n.ID) != "proposed" {
		t.Fatal("status moved")
	}
}

func eventTypes(s *Store) []string {
	out := []string{}
	for _, e := range s.Review().Events {
		out = append(out, e.Type)
	}
	return out
}

func TestNoYesEventBeforeYes(t *testing.T) {
	store, _, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	ok(t, store.Propose(n.ID, testProposal))
	if got := strings.Join(eventTypes(store), ","); got != "note" {
		t.Fatal(got)
	}
	ok(t, store.Answer(n.ID, Answer{Answer: "yes"}))
	if got := strings.Join(eventTypes(store), ","); got != "note,yes" {
		t.Fatal(got)
	}
}

func TestEventStaysUntilDelivered(t *testing.T) {
	store, _, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	e := store.NextEvent()
	if e == nil || e.Type != "note" || e.NoteID != n.ID {
		t.Fatalf("%+v", e)
	}
	if store.NextEvent().Seq != e.Seq {
		t.Fatal("next event moved")
	}
	ok(t, store.MarkDelivered(e.Seq))
	if store.NextEvent() != nil {
		t.Fatal("delivered event is still next")
	}
}

func TestSurvivesReopening(t *testing.T) {
	store, dir, _ := withVideo(t)
	n := must(store.CreateNote(testNote, nil))
	again := must(OpenStore(filepath.Join(dir, ".gakuya"), "a"))
	if must(again.Note(n.ID)).Text != testNote.Text || again.NextEvent().NoteID != n.ID {
		t.Fatal("lost on reopen")
	}
}

func TestCorruptReviewStopsOpen(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".gakuya")
	store := must(OpenStore(root, "a"))
	bpm := 120.0
	ok(t, store.SetTiming(func(x *Timing) { x.BPM = &bpm }))
	file := filepath.Join(root, "a", "review.json")
	ok(t, os.WriteFile(file, []byte("{ broken"), 0o644))
	_, err := OpenStore(root, "a")
	if err == nil || !strings.Contains(err.Error(), "review.json") {
		t.Fatal(err)
	}
	if got := must(os.ReadFile(file)); string(got) != "{ broken" {
		t.Fatal("overwritten")
	}
}

func TestSameHashIsOneVersionAndCopyOutlivesOverwrite(t *testing.T) {
	store, dir, video := withVideo(t)
	v := must(store.AddVersion(write(t, dir, "renamed.mp4", "video-one"), testInfo))
	if len(store.Review().Versions) != 1 || v.ID != "v1" {
		t.Fatalf("%+v", store.Review().Versions)
	}
	write(t, dir, filepath.Base(video), "video-overwritten")
	if got := must(os.ReadFile(store.VersionPath(v))); string(got) != "video-one" {
		t.Fatal(string(got))
	}
}

func TestDoneMovesOnlyThatNote(t *testing.T) {
	store, dir, _ := withVideo(t)
	a := must(store.CreateNote(testNote, nil))
	b := must(store.CreateNote(testNote, nil))
	ok(t, store.Propose(a.ID, testProposal))
	ok(t, store.Answer(a.ID, Answer{Answer: "yes"}))
	v2 := must(store.AddVersion(write(t, dir, "b.mp4", "video-two"), testInfo))
	ok(t, store.Done(a.ID, v2.ID))
	if must(store.Note(a.ID)).Version != "v2" || must(store.Note(b.ID)).Version != "v1" {
		t.Fatal("wrong versions")
	}
}

func TestFindReviewBySha(t *testing.T) {
	_, dir, video := withVideo(t)
	root := filepath.Join(dir, ".gakuya")
	sha := must(hashFile(video))
	if got := must(findReviewBySha(root, sha)); got != "a" {
		t.Fatal(got)
	}
	if got := must(findReviewBySha(root, "nope")); got != "" {
		t.Fatal(got)
	}
	if got := must(findReviewBySha(filepath.Join(dir, "missing"), "nope")); got != "" {
		t.Fatal(got)
	}
}

func TestConcurrentVersionsGetTheirOwnIDs(t *testing.T) {
	dir := t.TempDir()
	store := must(OpenStore(filepath.Join(dir, ".gakuya"), "r"))
	a, b := write(t, dir, "a.mp4", "first render"), write(t, dir, "b.mp4", "second render")
	var wg sync.WaitGroup
	got := make([]VideoVersion, 4)
	for i, path := range []string{a, b, a, b} {
		wg.Add(1)
		go func(i int, path string) {
			defer wg.Done()
			v, err := store.AddVersion(path, testInfo)
			if err != nil {
				t.Error(err)
			}
			got[i] = v
		}(i, path)
	}
	wg.Wait()
	if len(store.Review().Versions) != 2 {
		t.Fatalf("%+v", store.Review().Versions)
	}
	if got[0].ID != got[2].ID || got[1].ID != got[3].ID || got[0].ID == got[1].ID {
		t.Fatalf("%+v", got)
	}
	if body := must(os.ReadFile(store.VersionPath(got[0]))); string(body) != "first render" {
		t.Fatal(string(body))
	}
	if body := must(os.ReadFile(store.VersionPath(got[1]))); string(body) != "second render" {
		t.Fatal(string(body))
	}
}

func TestConcurrentNotesGetTheirOwnIDs(t *testing.T) {
	store, _, _ := withVideo(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); must(store.CreateNote(testNote, nil)) }()
	}
	wg.Wait()
	seen := map[string]bool{}
	for _, n := range store.Review().Notes {
		seen[n.ID] = true
	}
	if len(seen) != 20 {
		t.Fatalf("%d distinct ids", len(seen))
	}
}

func TestChangeListenerMayReadTheStore(t *testing.T) {
	store, _, _ := withVideo(t)
	var seen *GakuyaEvent
	store.OnChange(func() { seen = store.NextEvent() })
	must(store.CreateNote(testNote, nil))
	if seen == nil || seen.Type != "note" {
		t.Fatalf("%+v", seen)
	}
}

func TestReviewFileHasTheSameShapeAsBefore(t *testing.T) {
	store, dir, _ := withVideo(t)
	must(store.CreateNote(testNote, nil))
	ok(t, store.MarkDelivered(store.NextEvent().Seq))
	body := string(must(os.ReadFile(filepath.Join(dir, ".gakuya", "a", "review.json"))))
	for _, want := range []string{`"events": []`, `"reference": null`, `"bpm": null`, `"cues": []`, `"snapshots": []`, `"proposal": null`, `"nextSeq": 2`} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %s in\n%s", want, body)
		}
	}
}
