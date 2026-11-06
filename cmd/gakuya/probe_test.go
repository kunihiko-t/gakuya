package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

const bits = "format=gray,geq=lum='255*mod(floor(N/pow(2,floor(X/(W/16)))),2)'"

// ffmpeg writes dir/name; the expected values were read from mediabunny, which the page itself uses.
func ffmpeg(t *testing.T, dir, name string, args ...string) string {
	t.Helper()
	out := filepath.Join(dir, name)
	all := append([]string{"-y", "-loglevel", "error"}, args...)
	if b, err := exec.Command("ffmpeg", append(all, out)...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg %s: %v\n%s", name, err, b)
	}
	return out
}

func TestProbe(t *testing.T) {
	dir := t.TempDir()
	src := []string{"-f", "lavfi", "-i", "color=black:s=640x360:r=30", "-frames:v", "60"}
	x264 := []string{"-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-bf", "2"}
	gen := func(name string, extra ...string) string {
		return ffmpeg(t, dir, name, append(append(append([]string{}, src...), "-vf", bits), append(x264, extra...)...)...)
	}
	plain := gen("plain.mp4")
	want := VideoInfo{FPS: 30, Frames: 60, Width: 640, Height: 360}
	webm := VideoInfo{FPS: 29.995, Frames: 60, Width: 640, Height: 360} // millisecond timestamps round the rate

	cases := []struct {
		name string
		path string
		want VideoInfo
	}{
		{"moov after mdat", plain, want},
		{"moov first", gen("faststart.mp4", "-movflags", "+faststart"), want},
		{"timestamps do not start at zero", gen("offset.mp4", "-output_ts_offset", "2"), want},
		{"fragmented", gen("frag.mp4", "-movflags", "frag_keyframe+empty_moov"), want},
		{"fragmented with default-base-is-moof", gen("dbm.mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"), want},
		{"uneven frame spacing", ffmpeg(t, dir, "vfr.mp4", append(append(append([]string{}, src...), "-vf", bits+",setpts='N/30/TB+0.02*mod(N,3)/TB'"), append(x264, "-fps_mode", "vfr")...)...), VideoInfo{FPS: 29.5, Frames: 60, Width: 640, Height: 360}},
		{"prores in mov", ffmpeg(t, dir, "prores.mov", append(append([]string{}, src...), "-vf", bits, "-c:v", "prores_ks", "-pix_fmt", "yuv422p10le")...), want},
		{"rotated", ffmpeg(t, dir, "rot.mp4", "-display_rotation", "90", "-i", plain, "-c", "copy"), VideoInfo{FPS: 30, Frames: 60, Width: 360, Height: 640}},
		{"webm", ffmpeg(t, dir, "vp9.webm", append(append([]string{}, src...), "-vf", bits, "-c:v", "libvpx-vp9", "-b:v", "200k", "-cpu-used", "8")...), webm},
		{"mkv", gen("h264.mkv"), webm},
		{"mkv with clusters of unknown size", ffmpeg(t, dir, "live.mkv", "-i", plain, "-c", "copy", "-f", "matroska", "-live", "1"), webm},
		{"one frame has no rate", ffmpeg(t, dir, "one.mp4", "-f", "lavfi", "-i", "color=black:s=64x36:r=30", "-frames:v", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"), VideoInfo{FPS: 0, Frames: 1, Width: 64, Height: 36}},
	}
	for _, c := range cases {
		got, err := probeVideo(c.path)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
		} else if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}

	audio := ffmpeg(t, dir, "audio.m4a", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac")
	junk := filepath.Join(dir, "junk.mp4")
	os.WriteFile(junk, []byte("not a video at all"), 0o644)
	full, _ := os.ReadFile(plain)
	truncated := filepath.Join(dir, "truncated.mp4")
	os.WriteFile(truncated, full[:5000], 0o644)
	for _, bad := range []string{audio, junk, truncated, filepath.Join(dir, "none.mp4")} {
		if got, err := probeVideo(bad); err == nil {
			t.Errorf("%s: expected an error, got %+v", filepath.Base(bad), got)
		}
	}
}
