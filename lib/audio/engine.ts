type Voice = {
  osc: OscillatorNode;
  gain: GainNode;
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private voices = new Map<number, Voice>();

  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  private started = false;

  isStarted() {
    return this.started;
  }

  async start() {
    if (this.started) return;

    const Ctx =
      window.AudioContext ||
      ((window as unknown as Record<string, typeof AudioContext>)
        .webkitAudioContext as typeof AudioContext);
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 900;
    this.filter.Q.value = 0.7;

    this.lfo = this.ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 5.0;

    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.value = 0;

    this.lfo.connect(this.lfoGain);

    this.filter.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.lfo.start();

    await this.ctx.resume();
    this.started = true;
  }

  private midiToHz(midi: number) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  noteOn(midi: number, velocity = 0.9) {
    if (!this.ctx || !this.filter) return;
    if (this.voices.has(midi)) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.value = this.midiToHz(midi);

    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.05, velocity) * 0.25,
      t + 0.02
    );

    osc.connect(gain);
    gain.connect(this.filter);

    if (this.lfoGain) {
      this.lfoGain.connect(osc.detune);
    }

    osc.start();
    this.voices.set(midi, { osc, gain });
  }

  noteOff(midi: number) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;

    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(Math.max(v.gain.gain.value, 0.0001), t);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

    v.osc.stop(t + 0.08);
    this.voices.delete(midi);
  }

  allOff() {
    for (const midi of this.voices.keys()) this.noteOff(midi);
  }

  setMotion(tiltX: number, tiltY: number) {
    if (!this.ctx || !this.filter || !this.lfoGain) return;

    const y = Math.max(-1, Math.min(1, tiltY));
    const norm = (y + 1) * 0.5;
    const cutoff = 200 * Math.pow(20, norm);
    this.filter.frequency.setTargetAtTime(
      cutoff,
      this.ctx.currentTime,
      0.05
    );

    const x = Math.max(-1, Math.min(1, tiltX));
    const vibNorm = Math.abs(x);
    const cents = vibNorm * 35;
    this.lfoGain.gain.setTargetAtTime(cents, this.ctx.currentTime, 0.05);
  }
}
