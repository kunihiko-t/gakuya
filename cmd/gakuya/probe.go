package main

import (
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
)

// VideoInfo is what the container says, without decoding anything.
type VideoInfo struct {
	FPS    float64 `json:"fps"`
	Frames int     `json:"frames"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
}

var errNoVideo = errors.New("no video track")

// frameTimes keeps the count and the span of presentation times, which is all the frame rate needs.
type frameTimes struct {
	frames      int
	first, last float64
}

func (f *frameTimes) add(seconds float64) {
	if f.frames == 0 || seconds < f.first {
		f.first = seconds
	}
	if f.frames == 0 || seconds > f.last {
		f.last = seconds
	}
	f.frames++
}

func (f *frameTimes) info(width, height int) (VideoInfo, error) {
	if f.frames == 0 {
		return VideoInfo{}, errors.New("no frames")
	}
	fps := 0.0
	if f.frames > 1 && f.last > f.first {
		fps = math.Round(float64(f.frames-1)/(f.last-f.first)*1000) / 1000
	}
	return VideoInfo{FPS: fps, Frames: f.frames, Width: width, Height: height}, nil
}

// probeVideo reads the frame count and display size of an MP4, MOV, WebM or MKV.
func probeVideo(path string) (VideoInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return VideoInfo{}, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return VideoInfo{}, err
	}
	var magic [4]byte
	if _, err := file.ReadAt(magic[:], 0); err != nil {
		return VideoInfo{}, errors.New("unrecognizable format")
	}
	if magic == [4]byte{0x1a, 0x45, 0xdf, 0xa3} {
		return probeMatroska(file, stat.Size())
	}
	return probeMP4(file, stat.Size())
}

// --- MP4 and MOV ---

type mp4Box struct {
	kind       string
	start, end int64 // the payload
}

// eachBox walks the boxes in [start, end). A box running past the end, as in a file cut short, is clamped: whatever
// is missing shows up later as no moov or no frames.
func eachBox(r io.ReaderAt, start, end int64, fn func(mp4Box) error) error {
	var head [16]byte
	for pos := start; pos+8 <= end; {
		if _, err := r.ReadAt(head[:8], pos); err != nil {
			return err
		}
		size, hdr := int64(binary.BigEndian.Uint32(head[:4])), int64(8)
		switch size {
		case 0:
			size = end - pos
		case 1:
			if _, err := r.ReadAt(head[8:16], pos+8); err != nil {
				return err
			}
			size, hdr = int64(binary.BigEndian.Uint64(head[8:16])), 16
		}
		if size < hdr {
			return errors.New("malformed box")
		}
		boxEnd := pos + size
		if boxEnd > end || boxEnd < pos {
			boxEnd = end
		}
		if err := fn(mp4Box{string(head[4:8]), pos + hdr, boxEnd}); err != nil {
			return err
		}
		pos = boxEnd
	}
	return nil
}

func readBox(r io.ReaderAt, b mp4Box) ([]byte, error) {
	data := make([]byte, b.end-b.start)
	_, err := r.ReadAt(data, b.start)
	return data, err
}

// mp4Track is the part of a trak the probe needs.
type mp4Track struct {
	id            uint32
	isVideo       bool
	width, height int
	timescale     uint32
	stts, ctts    []byte
}

func parseTrack(r io.ReaderAt, trak mp4Box) (*mp4Track, error) {
	t := &mp4Track{}
	var walk func(mp4Box) error
	walk = func(b mp4Box) error {
		switch b.kind {
		case "mdia", "minf", "stbl":
			return eachBox(r, b.start, b.end, walk)
		case "tkhd", "mdhd", "hdlr", "stts", "ctts":
			data, err := readBox(r, b)
			if err != nil {
				return err
			}
			return t.read(b.kind, data)
		}
		return nil
	}
	if err := eachBox(r, trak.start, trak.end, walk); err != nil {
		return nil, err
	}
	return t, nil
}

func (t *mp4Track) read(kind string, d []byte) error {
	short := errors.New("short " + kind)
	if len(d) < 4 {
		return short
	}
	v1 := d[0] == 1
	switch kind {
	case "tkhd":
		// Version 1 has 64-bit times. After them: reserved, layer, group, volume, reserved, matrix, width, height.
		idAt, matrixAt := 12, 40
		if v1 {
			idAt, matrixAt = 20, 52
		}
		if len(d) < matrixAt+44 {
			return short
		}
		t.id = binary.BigEndian.Uint32(d[idAt:])
		t.width = int(binary.BigEndian.Uint32(d[matrixAt+36:]) >> 16)
		t.height = int(binary.BigEndian.Uint32(d[matrixAt+40:]) >> 16)
		// A zero first matrix term means a quarter turn.
		if binary.BigEndian.Uint32(d[matrixAt:]) == 0 {
			t.width, t.height = t.height, t.width
		}
	case "mdhd":
		at := 12
		if v1 {
			at = 20
		}
		if len(d) < at+4 {
			return short
		}
		t.timescale = binary.BigEndian.Uint32(d[at:])
	case "hdlr":
		if len(d) < 12 {
			return short
		}
		// QuickTime has a second hdlr under minf, for the data reference: it must not undo this one.
		t.isVideo = t.isVideo || string(d[8:12]) == "vide"
	case "stts":
		t.stts = d
	case "ctts":
		t.ctts = d
	}
	return nil
}

// addSamples walks the run-length tables of a plain (not fragmented) track.
func (t *mp4Track) addSamples(f *frameTimes) (dts uint64, err error) {
	if len(t.stts) < 8 {
		return 0, nil
	}
	n := int(binary.BigEndian.Uint32(t.stts[4:]))
	if len(t.stts) < 8+n*8 {
		return 0, errors.New("short stts")
	}
	var ctts []byte
	var ctRun uint32
	var ctOffset int32
	if len(t.ctts) >= 8 {
		ctts = t.ctts[8:]
	}
	nextOffset := func() {
		for ctRun == 0 && len(ctts) >= 8 {
			ctRun, ctOffset = binary.BigEndian.Uint32(ctts), int32(binary.BigEndian.Uint32(ctts[4:]))
			ctts = ctts[8:]
		}
		if ctRun == 0 {
			ctOffset = 0
		} else {
			ctRun--
		}
	}
	scale := float64(t.timescale)
	for i := 0; i < n; i++ {
		count := binary.BigEndian.Uint32(t.stts[8+i*8:])
		delta := binary.BigEndian.Uint32(t.stts[12+i*8:])
		for j := uint32(0); j < count; j++ {
			nextOffset()
			f.add((float64(dts) + float64(ctOffset)) / scale)
			dts += uint64(delta)
		}
	}
	return dts, nil
}

func probeMP4(r io.ReaderAt, size int64) (VideoInfo, error) {
	var moov *mp4Box
	var moofs []mp4Box
	err := eachBox(r, 0, size, func(b mp4Box) error {
		switch b.kind {
		case "moov":
			if moov == nil {
				moov = &mp4Box{b.kind, b.start, b.end}
			}
		case "moof":
			moofs = append(moofs, b)
		}
		return nil
	})
	if err != nil || moov == nil {
		return VideoInfo{}, errNoVideo
	}

	var track *mp4Track
	fragmented := false
	trex := map[uint32]uint32{} // default sample duration by track
	var walk func(mp4Box) error
	walk = func(b mp4Box) error {
		switch b.kind {
		case "trak":
			if track != nil {
				return nil
			}
			t, err := parseTrack(r, b)
			if err != nil {
				return err
			}
			if t.isVideo {
				track = t
			}
		case "mvex":
			fragmented = true
			return eachBox(r, b.start, b.end, walk)
		case "trex":
			data, err := readBox(r, b)
			if err != nil {
				return err
			}
			if len(data) >= 16 {
				trex[binary.BigEndian.Uint32(data[4:])] = binary.BigEndian.Uint32(data[12:])
			}
		}
		return nil
	}
	if err := eachBox(r, moov.start, moov.end, walk); err != nil {
		return VideoInfo{}, err
	}
	if track == nil || track.timescale == 0 {
		return VideoInfo{}, errNoVideo
	}

	var times frameTimes
	dts, err := track.addSamples(&times)
	if err != nil {
		return VideoInfo{}, err
	}
	// A finished hybrid recording has moof boxes beside a complete moov without mvex; those moofs do not count.
	if fragmented {
		for _, moof := range moofs {
			if err := eachBox(r, moof.start, moof.end, func(b mp4Box) error {
				if b.kind != "traf" {
					return nil
				}
				return addFragment(r, b, track, trex[track.id], &dts, &times)
			}); err != nil {
				return VideoInfo{}, err
			}
		}
	}
	return times.info(track.width, track.height)
}

// addFragment reads one traf of a fragmented file. dts carries on from the end of the last run.
func addFragment(r io.ReaderAt, traf mp4Box, track *mp4Track, trackDuration uint32, dts *uint64, times *frameTimes) error {
	duration, mine := trackDuration, false
	short := errors.New("short track fragment")
	return eachBox(r, traf.start, traf.end, func(b mp4Box) error {
		if b.kind != "tfhd" && (!mine || b.kind != "tfdt" && b.kind != "trun") {
			return nil
		}
		d, err := readBox(r, b)
		if err != nil {
			return err
		}
		if len(d) < 8 {
			return short
		}
		flags := binary.BigEndian.Uint32(d) & 0xffffff
		switch b.kind {
		case "tfhd":
			mine = binary.BigEndian.Uint32(d[4:]) == track.id
			at := 8
			if flags&0x1 != 0 {
				at += 8 // base data offset
			}
			if flags&0x2 != 0 {
				at += 4 // sample description index
			}
			if flags&0x8 != 0 {
				if len(d) < at+4 {
					return short
				}
				duration = binary.BigEndian.Uint32(d[at:])
			}
		case "tfdt":
			if d[0] == 1 {
				if len(d) < 12 {
					return short
				}
				*dts = binary.BigEndian.Uint64(d[4:])
			} else {
				*dts = uint64(binary.BigEndian.Uint32(d[4:]))
			}
		case "trun":
			at := 8
			if flags&0x1 != 0 {
				at += 4 // data offset
			}
			if flags&0x4 != 0 {
				at += 4 // first sample flags
			}
			perSample := 4 * bits32(flags&0xf00)
			count := int(binary.BigEndian.Uint32(d[4:]))
			if len(d) < at+count*perSample {
				return short
			}
			for i := 0; i < count; i++ {
				sample, offset := duration, int32(0)
				if flags&0x100 != 0 {
					sample = binary.BigEndian.Uint32(d[at:])
					at += 4
				}
				if flags&0x200 != 0 {
					at += 4 // size
				}
				if flags&0x400 != 0 {
					at += 4 // flags
				}
				if flags&0x800 != 0 {
					offset = int32(binary.BigEndian.Uint32(d[at:]))
					at += 4
				}
				times.add((float64(*dts) + float64(offset)) / float64(track.timescale))
				*dts += uint64(sample)
			}
		}
		return nil
	})
}

func bits32(v uint32) int {
	n := 0
	for ; v != 0; v &= v - 1 {
		n++
	}
	return n
}

// --- WebM and MKV ---

const (
	ebmlSegment      = 0x18538067
	ebmlInfo         = 0x1549a966
	ebmlTimecodeUnit = 0x2ad7b1
	ebmlTracks       = 0x1654ae6b
	ebmlTrackEntry   = 0xae
	ebmlTrackNumber  = 0xd7
	ebmlTrackType    = 0x83
	ebmlVideo        = 0xe0
	ebmlPixelWidth   = 0xb0
	ebmlPixelHeight  = 0xba
	ebmlDisplayW     = 0x54b0
	ebmlDisplayH     = 0x54ba
	ebmlCluster      = 0x1f43b675
	ebmlTimecode     = 0xe7
	ebmlSimpleBlock  = 0xa3
	ebmlBlockGroup   = 0xa0
	ebmlBlock        = 0xa1
)

// ebmlNumber reads a variable-length number. keepMarker is for element ids. unknown reports an all-ones size.
func ebmlNumber(r io.ReaderAt, pos int64, keepMarker bool) (value uint64, length int64, unknown bool, err error) {
	var buf [8]byte
	if _, err = r.ReadAt(buf[:1], pos); err != nil {
		return
	}
	length = 1
	for mask := byte(0x80); mask != 0 && buf[0]&mask == 0; mask >>= 1 {
		length++
	}
	if length > 8 {
		return 0, 0, false, errors.New("bad EBML number")
	}
	if _, err = r.ReadAt(buf[:length], pos); err != nil {
		return
	}
	if !keepMarker {
		buf[0] &= byte(0xff >> length)
	}
	for _, b := range buf[:length] {
		value = value<<8 | uint64(b)
	}
	return value, length, !keepMarker && value == 1<<(7*length)-1, nil
}

func ebmlUint(r io.ReaderAt, pos, size int64) (uint64, error) {
	if size > 8 {
		return 0, errors.New("EBML integer too long")
	}
	var buf [8]byte
	if _, err := r.ReadAt(buf[:size], pos); err != nil {
		return 0, err
	}
	var v uint64
	for _, b := range buf[:size] {
		v = v<<8 | uint64(b)
	}
	return v, nil
}

// probeMatroska scans the file flat: it steps into the parents it knows and over everything else, so a segment or
// cluster of unknown size needs no special care. A file cut short counts what it holds.
func probeMatroska(r io.ReaderAt, size int64) (VideoInfo, error) {
	type track struct{ number, kind, pixelW, pixelH, dispW, dispH uint64 }
	var tracks []*track
	video := func() *track {
		for _, t := range tracks {
			if t.kind == 1 {
				return t
			}
		}
		return nil
	}
	unit, cluster := uint64(1000000), uint64(0)
	var times frameTimes

	for pos := int64(0); pos < size; {
		id, idLen, _, err := ebmlNumber(r, pos, true)
		if err != nil {
			break
		}
		length, sizeLen, unknown, err := ebmlNumber(r, pos+idLen, false)
		if err != nil {
			break
		}
		payload := pos + idLen + sizeLen
		pos = payload
		switch id {
		case ebmlSegment, ebmlInfo, ebmlTracks, ebmlVideo, ebmlCluster, ebmlBlockGroup:
			continue
		case ebmlTrackEntry:
			tracks = append(tracks, &track{})
			continue
		}
		if unknown {
			return VideoInfo{}, errors.New("EBML element of unknown size")
		}
		pos += int64(length)
		var field *uint64
		if len(tracks) > 0 {
			t := tracks[len(tracks)-1]
			switch id {
			case ebmlTrackNumber:
				field = &t.number
			case ebmlTrackType:
				field = &t.kind
			case ebmlPixelWidth:
				field = &t.pixelW
			case ebmlPixelHeight:
				field = &t.pixelH
			case ebmlDisplayW:
				field = &t.dispW
			case ebmlDisplayH:
				field = &t.dispH
			}
		}
		switch {
		case id == ebmlTimecodeUnit:
			field = &unit
		case id == ebmlTimecode:
			field = &cluster
		}
		if field != nil {
			v, err := ebmlUint(r, payload, int64(length))
			if err != nil {
				break
			}
			*field = v
		}
		if id == ebmlSimpleBlock || id == ebmlBlock {
			v := video()
			number, n, _, err := ebmlNumber(r, payload, false)
			if err != nil {
				break
			}
			if v == nil || number != v.number {
				continue
			}
			var rel [2]byte
			if _, err := r.ReadAt(rel[:], payload+n); err != nil {
				break
			}
			times.add((float64(cluster) + float64(int16(binary.BigEndian.Uint16(rel[:])))) * float64(unit) / 1e9)
		}
	}
	v := video()
	if v == nil {
		return VideoInfo{}, errNoVideo
	}
	width, height := v.pixelW, v.pixelH
	if v.dispW > 0 && v.dispH > 0 {
		width, height = v.dispW, v.dispH
	}
	return times.info(int(width), int(height))
}
