import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource, VideoSampleSink } from 'mediabunny';

/** Frame-exact access to a video file. A frame's number is its rank in presentation order, never fps × time. */
export class FrameSource {
  private constructor(
    private input: Input,
    private sink: VideoSampleSink,
    private times: Float64Array,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Throws if the file holds no video track the browser can decode. */
  static async open(url: string): Promise<FrameSource> {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    if (!(await track.canDecode())) throw new Error('codec not decodable');
    const stamps: number[] = [];
    const packets = new EncodedPacketSink(track);
    for await (const p of packets.packets(undefined, undefined, { metadataOnly: true })) stamps.push(p.timestamp);
    const times = Float64Array.from(stamps).sort();
    return new FrameSource(input, new VideoSampleSink(track), times, track.displayWidth, track.displayHeight);
  }

  get frames(): number { return this.times.length; }
  get duration(): number { return this.frames ? this.times[this.frames - 1] - this.times[0] : 0; }
  /** Average, for display only. */
  get fps(): number { return this.frames > 1 ? (this.frames - 1) / this.duration : 0; }

  timeOf(frame: number): number { return this.times[frame]; }

  /** The frame showing at `time`: the last one starting at or before it. */
  frameAt(time: number): number {
    let lo = 0, hi = this.frames - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= time + 1e-6) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  async draw(frame: number, target: CanvasRenderingContext2D): Promise<void> {
    const sample = await this.sink.getSample(this.times[frame]);
    if (!sample) throw new Error(`no sample for frame ${frame}`);
    try { sample.draw(target, 0, 0, target.canvas.width, target.canvas.height); } finally { sample.close(); }
  }

  /** Every frame in order, drawn to `target`. Far cheaper than draw() per frame when reading a whole video. */
  async *scan(target: CanvasRenderingContext2D): AsyncGenerator<number> {
    let i = 0;
    for await (const sample of this.sink.samples()) {
      try { sample.draw(target, 0, 0, target.canvas.width, target.canvas.height); } finally { sample.close(); }
      yield i++;
    }
  }

  /** When the audio starts on the video's clock, or null if there is no audio. */
  async audioStart(): Promise<number | null> {
    const track = await this.input.getPrimaryAudioTrack();
    return track ? track.getFirstTimestamp() : null;
  }

  close(): void { this.input.dispose?.(); }
}
