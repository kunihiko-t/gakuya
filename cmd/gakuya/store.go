package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

// The shapes on disk and on the wire. src/shared/types.ts is the same thing for the page: change them together.
type (
	NoteStatus string
	Pt         [2]float64

	VideoVersion struct {
		ID           string `json:"id"`
		OriginalPath string `json:"originalPath"`
		File         string `json:"file"`
		SHA256       string `json:"sha256"`
		VideoInfo
	}
	Proposal struct {
		Frames [2]int `json:"frames"`
		Region []Pt   `json:"region"`
		Text   string `json:"text"`
	}
	Anchor struct {
		Frame int  `json:"frame"`
		Shape []Pt `json:"shape"`
	}
	Note struct {
		ID        string     `json:"id"`
		Version   string     `json:"version"`
		Status    NoteStatus `json:"status"`
		Frames    [2]int     `json:"frames"`
		Anchor    Anchor     `json:"anchor"`
		Text      string     `json:"text"`
		Color     *string    `json:"color"`
		Snapshots []string   `json:"snapshots"`
		Proposal  *Proposal  `json:"proposal"`
		Reason    *string    `json:"reason"`
	}
	Cue struct {
		Time  float64 `json:"time"`
		Label *string `json:"label,omitempty"`
	}
	Timing struct {
		BPM    *float64 `json:"bpm"`
		Offset float64  `json:"offset"`
		Source string   `json:"source"`
		Cues   []Cue    `json:"cues"`
	}
	Reference struct {
		Path          string  `json:"path"`
		OffsetSeconds float64 `json:"offsetSeconds"`
	}
	GakuyaEvent struct {
		Seq    int    `json:"seq"`
		Type   string `json:"type"`
		NoteID string `json:"noteId"`
		Reason string `json:"reason,omitempty"`
	}
	Review struct {
		Name      string         `json:"name"`
		Versions  []VideoVersion `json:"versions"`
		Reference *Reference     `json:"reference"`
		Timing    Timing         `json:"timing"`
		Notes     []Note         `json:"notes"`
		Events    []GakuyaEvent  `json:"events"`
		NextSeq   int            `json:"nextSeq"`
	}
	NewNote struct {
		Frames  [2]int
		Anchor  Anchor
		Text    string
		Color   *string
		Version string
	}
	AnswerEdit struct {
		Frames    *[2]int
		Anchor    *Anchor
		Snapshots []string
	}
	Answer struct {
		Answer string
		Reason *string
		Edit   *AnswerEdit
	}
)

// encodeJSON is json.Marshal without HTML escaping, so review.json reads the way it did.
func encodeJSON(v any, indent bool) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if indent {
		enc.SetIndent("", "  ")
	}
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func readReview(file string) (Review, error) {
	var r Review
	data, err := os.ReadFile(file)
	if err == nil {
		err = json.Unmarshal(data, &r)
	}
	if err != nil {
		return r, fmt.Errorf("%s: review.json is unreadable, fix or remove it (%w)", file, err)
	}
	return r, nil
}

// findReviewBySha names the review under root holding a version with this hash, or "".
func findReviewBySha(root, sha string) (string, error) {
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		file := filepath.Join(root, entry.Name(), "review.json")
		if _, err := os.Stat(file); err != nil {
			continue
		}
		r, err := readReview(file)
		if err != nil {
			return "", err
		}
		for _, v := range r.Versions {
			if v.SHA256 == sha {
				return entry.Name(), nil
			}
		}
	}
	return "", nil
}

// Store is the single writer of review.json. Every change is on disk before the method returns.
type Store struct {
	Dir       string
	file      string
	mu        sync.Mutex
	addMu     sync.Mutex // one AddVersion at a time: hashing and copying happen outside mu
	review    Review
	listeners []func()
}

func OpenStore(root, name string) (*Store, error) {
	dir := filepath.Join(root, name)
	for _, sub := range []string{"versions", "notes"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	s := &Store{Dir: dir, file: filepath.Join(dir, "review.json")}
	if _, err := os.Stat(s.file); err == nil {
		r, err := readReview(s.file)
		if err != nil {
			return nil, err
		}
		s.review = r
	} else {
		s.review = Review{
			Name: name, Versions: []VideoVersion{}, Notes: []Note{}, Events: []GakuyaEvent{}, NextSeq: 1,
			Timing: Timing{Source: "auto", Cues: []Cue{}},
		}
	}
	return s, nil
}

// OnChange registers a callback run after each saved change, outside the lock: it may read the store.
func (s *Store) OnChange(cb func()) { s.listeners = append(s.listeners, cb) }

func (s *Store) save() error {
	data, err := encodeJSON(s.review, true)
	if err != nil {
		return err
	}
	return writeAtomic(s.file, data, 0o644)
}

// writeAtomic lets a reader see the old file or the whole new one, never a partly written one.
func writeAtomic(file string, data []byte, mode os.FileMode) error {
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil { // a leftover .tmp keeps its old mode through WriteFile
		return err
	}
	return os.Rename(tmp, file)
}

// change runs fn under the lock and saves. An error from fn means nothing changed.
func (s *Store) change(fn func() error) error {
	s.mu.Lock()
	err := fn()
	if err == nil {
		err = s.save()
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	for _, cb := range s.listeners {
		cb()
	}
	return nil
}

func (s *Store) push(kind, noteID string, reason *string) {
	e := GakuyaEvent{Seq: s.review.NextSeq, Type: kind, NoteID: noteID}
	if reason != nil {
		e.Reason = *reason
	}
	s.review.NextSeq++
	s.review.Events = append(s.review.Events, e)
}

func (s *Store) note(id string) (*Note, error) {
	for i := range s.review.Notes {
		if s.review.Notes[i].ID == id {
			return &s.review.Notes[i], nil
		}
	}
	return nil, fmt.Errorf("no note %s", id)
}

func (s *Store) version(id string) (*VideoVersion, error) {
	for i := range s.review.Versions {
		if s.review.Versions[i].ID == id {
			return &s.review.Versions[i], nil
		}
	}
	return nil, fmt.Errorf("no version %s", id)
}

// Review is a copy. The slices inside its elements are only ever replaced, never edited, so sharing them is safe.
func (s *Store) Review() Review {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.review
	r.Versions, r.Notes, r.Events = slices.Clone(r.Versions), slices.Clone(r.Notes), slices.Clone(r.Events)
	return r
}

func (s *Store) Note(id string) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, err := s.note(id)
	if err != nil {
		return Note{}, err
	}
	return *n, nil
}

func (s *Store) Version(id string) (VideoVersion, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, err := s.version(id)
	if err != nil {
		return VideoVersion{}, err
	}
	return *v, nil
}

func (s *Store) VersionPath(v VideoVersion) string { return filepath.Join(s.Dir, "versions", v.File) }

// AddVersion copies the video in, so a later overwrite of the original cannot take the old version away.
func (s *Store) AddVersion(path string, info VideoInfo) (VideoVersion, error) {
	s.addMu.Lock()
	defer s.addMu.Unlock()
	sha, err := hashFile(path)
	if err != nil {
		return VideoVersion{}, err
	}
	r := s.Review()
	for _, v := range r.Versions {
		if v.SHA256 == sha {
			return v, nil
		}
	}
	id := fmt.Sprintf("v%d", len(r.Versions)+1)
	version := VideoVersion{ID: id, OriginalPath: path, File: id + filepath.Ext(path), SHA256: sha, VideoInfo: info}
	if err := copyFile(path, s.VersionPath(version)); err != nil {
		return VideoVersion{}, err
	}
	err = s.change(func() error {
		s.review.Versions = append(s.review.Versions, version)
		return nil
	})
	return version, err
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(to)
	}
	return err
}

// CreateNote gives the note its id. snapshots, if given, runs with that id before the note exists, so the images are
// on disk before anyone hears of the note, and a refusal leaves no note behind.
func (s *Store) CreateNote(input NewNote, snapshots func(id string) ([]string, error)) (Note, error) {
	var note Note
	err := s.change(func() error {
		id := fmt.Sprintf("n%d", len(s.review.Notes)+1)
		files := []string{}
		if snapshots != nil {
			var err error
			if files, err = snapshots(id); err != nil {
				return err
			}
		}
		version := input.Version
		if version == "" && len(s.review.Versions) > 0 {
			version = s.review.Versions[len(s.review.Versions)-1].ID
		}
		note = Note{
			ID: id, Version: version, Status: "open", Frames: input.Frames, Anchor: input.Anchor,
			Text: input.Text, Color: input.Color, Snapshots: files,
		}
		s.review.Notes = append(s.review.Notes, note)
		s.push("note", id, nil)
		return nil
	})
	return note, err
}

func (s *Store) Propose(id string, p Proposal) error {
	return s.change(func() error {
		n, err := s.note(id)
		if err != nil {
			return err
		}
		if n.Status != "open" && n.Status != "proposed" {
			return fmt.Errorf("cannot propose on a %s note", n.Status)
		}
		n.Status, n.Proposal = "proposed", &p
		return nil
	})
}

var answerFrom = map[string]NoteStatus{"yes": "proposed", "no": "proposed", "not_yet": "fixed", "resolved": "fixed"}

func (s *Store) Answer(id string, a Answer) error {
	return s.change(func() error {
		n, err := s.note(id)
		if err != nil {
			return err
		}
		if n.Status != answerFrom[a.Answer] {
			return fmt.Errorf("cannot answer %s on a %s note", a.Answer, n.Status)
		}
		n.Reason = a.Reason
		switch a.Answer {
		case "yes":
			n.Status = "confirmed"
			s.push("yes", id, a.Reason)
		case "no":
			n.Status, n.Proposal = "open", nil
			if a.Edit != nil {
				if a.Edit.Frames != nil {
					n.Frames = *a.Edit.Frames
				}
				if a.Edit.Anchor != nil {
					n.Anchor = *a.Edit.Anchor
				}
				if a.Edit.Snapshots != nil {
					n.Snapshots = a.Edit.Snapshots
				}
			}
			s.push("no", id, a.Reason)
		case "not_yet":
			n.Status = "confirmed"
			s.push("not_yet", id, a.Reason)
		case "resolved":
			n.Status = "resolved"
		}
		return nil
	})
}

func (s *Store) Done(id, versionID string) error {
	return s.change(func() error {
		n, err := s.note(id)
		if err != nil {
			return err
		}
		if n.Status != "confirmed" {
			return fmt.Errorf("cannot finish a %s note: it needs a yes first", n.Status)
		}
		if _, err := s.version(versionID); err != nil {
			return err
		}
		n.Status, n.Version = "fixed", versionID
		return nil
	})
}

func (s *Store) SetTiming(apply func(*Timing)) error {
	return s.change(func() error { apply(&s.review.Timing); return nil })
}

func (s *Store) SetReference(r *Reference) error {
	return s.change(func() error { s.review.Reference = r; return nil })
}

func (s *Store) NextEvent() *GakuyaEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.review.Events) == 0 {
		return nil
	}
	e := s.review.Events[0]
	return &e
}

func (s *Store) MarkDelivered(seq int) error {
	return s.change(func() error {
		s.review.Events = slices.DeleteFunc(s.review.Events, func(e GakuyaEvent) bool { return e.Seq == seq })
		return nil
	})
}
