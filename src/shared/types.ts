export type NoteStatus = 'open' | 'proposed' | 'confirmed' | 'fixed' | 'resolved';
export type Pt = [number, number];
export interface VideoInfo { fps: number; frames: number; width: number; height: number }
export interface VideoVersion extends VideoInfo { id: string; originalPath: string; file: string; sha256: string }
export interface Proposal { frames: [number, number]; region: Pt[]; text: string }
export interface Anchor { frame: number; shape: Pt[] }
export interface Note {
  id: string; version: string; status: NoteStatus; frames: [number, number]; anchor: Anchor; text: string;
  color: string | null; snapshots: string[]; proposal: Proposal | null; reason: string | null;
}
export interface Cue { time: number; label?: string }
export interface Timing { bpm: number | null; offset: number; source: 'auto' | 'manual' | 'agent'; cues: Cue[] }
export interface Reference { path: string; offsetSeconds: number }
export interface GakuyaEvent {
  seq: number; type: 'note' | 'yes' | 'no' | 'not_yet' | 'settled'; noteId: string; reason?: string;
  /** Only for 'settled'. */
  values?: Record<string, number | null>; frames?: [number, number]; frame?: number;
}
/** One slider the agent put on screen. `min` is the left end and may be the larger number. */
export interface Knob {
  id: string; label: string; min: number; max: number; default: number | null;
  scale: 'linear' | 'log'; scope: 'global' | 'range'; reset?: string;
}
/** Plays instead of the video's own sound. The reference uses the reference's offset. */
export interface Sound { reference?: boolean; path?: string; offsetSeconds?: number }
export interface Review {
  name: string; versions: VideoVersion[]; reference: Reference | null; sound: Sound | null; timing: Timing;
  notes: Note[]; events: GakuyaEvent[]; nextSeq: number; knobs: Knob[]; knobsRev: number;
}
export interface NewNote { frames: [number, number]; anchor: Anchor; text: string; color?: string | null; version?: string; snapshots?: string[] }
export interface Answer {
  answer: 'yes' | 'no' | 'not_yet' | 'resolved'; reason?: string;
  edit?: { frames?: [number, number]; anchor?: Anchor; snapshots?: string[] };
}
/** What GET /api/stream sends. */
export interface StreamState { review: Review; waiting: number; live: { problem: string } | null }
/** A PNG sent along with a note, so the images exist before the agent hears of it. */
export interface SnapshotUpload { frame: number; kind: 'raw' | 'marked'; data: string }
/** What GET /api/wait returns. Snapshot paths are absolute, ready to read. */
export interface WaitResult { event: GakuyaEvent; note: Note; snapshots: string[]; video: string }
