export type ControlTarget =
  | "filter-cutoff"
  | "volume"
  | "wave-blend"
  | "vibrato-depth"
  | "resonance"
  | "reverb"
  | "distortion"
  | "pan"
  | "delay-feedback"
  | "pitch-bend";

export type AxisMappings = {
  beta: ControlTarget;
  gamma: ControlTarget;
  alpha: ControlTarget;
};

export const DEFAULT_MAPPINGS: AxisMappings = {
  beta: "filter-cutoff",
  gamma: "vibrato-depth",
  alpha: "pan",
};

export const BETA_TARGETS: ControlTarget[] = [
  "filter-cutoff",
  "wave-blend",
  "volume",
];

export const GAMMA_TARGETS: ControlTarget[] = [
  "vibrato-depth",
  "resonance",
  "reverb",
  "distortion",
];

export const ALPHA_TARGETS: ControlTarget[] = [
  "pan",
  "delay-feedback",
  "pitch-bend",
];

export const TARGET_LABELS: Record<ControlTarget, string> = {
  "filter-cutoff": "Filter Cutoff",
  volume: "Volume",
  "wave-blend": "Wave Blend",
  "vibrato-depth": "Vibrato",
  resonance: "Resonance",
  reverb: "Reverb",
  distortion: "Distortion",
  pan: "Pan",
  "delay-feedback": "Delay FB",
  "pitch-bend": "Pitch Bend",
};

type Voice = {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  gainA: GainNode;
  gainB: GainNode;
  voiceGain: GainNode;
};

function generateImpulse(ctx: AudioContext, duration: number, decay: number) {
  const len = ctx.sampleRate * duration;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 44100;
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const k = amount;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

const T = 0.04; // smoothing time constant for setTargetAtTime

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private panner: StereoPannerNode | null = null;
  private distNode: WaveShaperNode | null = null;
  private delayNode: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private delayDry: GainNode | null = null;
  private delayWet: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbDry: GainNode | null = null;
  private reverbWet: GainNode | null = null;

  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  private voices = new Map<number, Voice>();
  private waveBlend = 0;
  private started = false;
  private mappings: AxisMappings = { ...DEFAULT_MAPPINGS };

  isStarted() {
    return this.started;
  }

  getMappings() {
    return { ...this.mappings };
  }

  setMappings(m: AxisMappings) {
    this.mappings = { ...m };
  }

  async start() {
    if (this.started) return;

    const Ctx =
      window.AudioContext ||
      ((window as unknown as Record<string, typeof AudioContext>)
        .webkitAudioContext as typeof AudioContext);
    this.ctx = new Ctx();
    const now = this.ctx.currentTime;

    // Master output
    this.master = this.ctx.createGain();
    this.master.gain.setValueAtTime(0.7, now);

    // Panner
    this.panner = this.ctx.createStereoPanner();
    this.panner.pan.setValueAtTime(0, now);

    // Lowpass filter
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.setValueAtTime(900, now);
    this.filter.Q.setValueAtTime(0.7, now);

    // Distortion (bypassed by default — curve = null means passthrough)
    this.distNode = this.ctx.createWaveShaper();
    this.distNode.oversample = "4x";

    // Delay with feedback loop
    this.delayNode = this.ctx.createDelay(1.0);
    this.delayNode.delayTime.setValueAtTime(0.3, now);
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.setValueAtTime(0, now);
    this.delayDry = this.ctx.createGain();
    this.delayDry.gain.setValueAtTime(1, now);
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.setValueAtTime(0.3, now);

    // Delay feedback loop
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);

    // Reverb (convolver)
    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = generateImpulse(this.ctx, 2.0, 2.5);
    this.reverbDry = this.ctx.createGain();
    this.reverbDry.gain.setValueAtTime(1, now);
    this.reverbWet = this.ctx.createGain();
    this.reverbWet.gain.setValueAtTime(0, now);

    // LFO for vibrato
    this.lfo = this.ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.setValueAtTime(5.0, now);
    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.setValueAtTime(0, now);
    this.lfo.connect(this.lfoGain);

    // Signal chain:
    // voices → filter → distortion → [delay dry/wet] → [reverb dry/wet] → panner → master → dest
    this.filter.connect(this.distNode);

    // Distortion splits into delay dry + delay input
    this.distNode.connect(this.delayDry);
    this.distNode.connect(this.delayNode);

    // Merge delay dry + wet into reverb split
    const postDelay = this.ctx.createGain();
    postDelay.gain.setValueAtTime(1, now);
    this.delayDry.connect(postDelay);
    this.delayWet.connect(postDelay);

    // Reverb split
    postDelay.connect(this.reverbDry);
    postDelay.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbWet);

    // Merge reverb dry + wet into panner
    this.reverbDry.connect(this.panner);
    this.reverbWet.connect(this.panner);

    this.panner.connect(this.master);
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

    const t = this.ctx.currentTime;
    const hz = this.midiToHz(midi);
    const vol = Math.max(0.05, velocity) * 0.2;

    // Two oscillators for wave blending (sawtooth ↔ square)
    const oscA = this.ctx.createOscillator();
    oscA.type = "sawtooth";
    oscA.frequency.setValueAtTime(hz, t);

    const oscB = this.ctx.createOscillator();
    oscB.type = "square";
    oscB.frequency.setValueAtTime(hz, t);

    const gainA = this.ctx.createGain();
    const gainB = this.ctx.createGain();
    gainA.gain.setValueAtTime(1 - this.waveBlend, t);
    gainB.gain.setValueAtTime(this.waveBlend, t);

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.setValueAtTime(0.0001, t);
    voiceGain.gain.exponentialRampToValueAtTime(vol, t + 0.02);

    oscA.connect(gainA);
    oscB.connect(gainB);
    gainA.connect(voiceGain);
    gainB.connect(voiceGain);
    voiceGain.connect(this.filter);

    if (this.lfoGain) {
      this.lfoGain.connect(oscA.detune);
      this.lfoGain.connect(oscB.detune);
    }

    oscA.start(t);
    oscB.start(t);
    this.voices.set(midi, { oscA, oscB, gainA, gainB, voiceGain });
  }

  noteOff(midi: number) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;

    const t = this.ctx.currentTime;
    v.voiceGain.gain.cancelScheduledValues(t);
    v.voiceGain.gain.setValueAtTime(Math.max(v.voiceGain.gain.value, 0.0001), t);
    v.voiceGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

    v.oscA.stop(t + 0.08);
    v.oscB.stop(t + 0.08);
    this.voices.delete(midi);
  }

  allOff() {
    for (const midi of this.voices.keys()) this.noteOff(midi);
  }

  /**
   * Apply a normalized -1..1 value to a control target.
   * Each target interprets the range appropriately.
   */
  private applyControl(target: ControlTarget, value: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.max(-1, Math.min(1, value));

    switch (target) {
      case "filter-cutoff": {
        if (!this.filter) return;
        const norm = (v + 1) * 0.5; // 0..1
        const cutoff = 200 * Math.pow(20, norm); // ~200..4000
        this.filter.frequency.setTargetAtTime(cutoff, t, T);
        break;
      }
      case "volume": {
        if (!this.master) return;
        const vol = 0.15 + ((v + 1) * 0.5) * 0.75; // 0.15..0.9
        this.master.gain.setTargetAtTime(vol, t, T);
        break;
      }
      case "wave-blend": {
        const blend = (v + 1) * 0.5; // 0..1 (sawtooth → square)
        this.waveBlend = blend;
        for (const voice of this.voices.values()) {
          voice.gainA.gain.setTargetAtTime(1 - blend, t, T);
          voice.gainB.gain.setTargetAtTime(blend, t, T);
        }
        break;
      }
      case "vibrato-depth": {
        if (!this.lfoGain) return;
        const cents = Math.abs(v) * 40; // 0..40 cents
        this.lfoGain.gain.setTargetAtTime(cents, t, T);
        break;
      }
      case "resonance": {
        if (!this.filter) return;
        const q = 0.5 + Math.abs(v) * 14; // 0.5..14.5
        this.filter.Q.setTargetAtTime(q, t, T);
        break;
      }
      case "reverb": {
        if (!this.reverbDry || !this.reverbWet) return;
        const mix = Math.abs(v); // 0..1
        this.reverbWet.gain.setTargetAtTime(mix * 0.8, t, T);
        this.reverbDry.gain.setTargetAtTime(1 - mix * 0.3, t, T);
        break;
      }
      case "distortion": {
        if (!this.distNode) return;
        const amount = Math.abs(v);
        if (amount < 0.05) {
          this.distNode.curve = null;
        } else {
          this.distNode.curve = makeDistortionCurve(amount * 50);
        }
        break;
      }
      case "pan": {
        if (!this.panner) return;
        this.panner.pan.setTargetAtTime(v, t, T);
        break;
      }
      case "delay-feedback": {
        if (!this.delayFeedback || !this.delayWet) return;
        const fb = Math.abs(v) * 0.75; // 0..0.75 (safe, no runaway)
        this.delayFeedback.gain.setTargetAtTime(fb, t, T);
        this.delayWet.gain.setTargetAtTime(Math.min(fb + 0.1, 0.5), t, T);
        break;
      }
      case "pitch-bend": {
        const cents = v * 200; // ±200 cents (±2 semitones)
        for (const voice of this.voices.values()) {
          voice.oscA.detune.setTargetAtTime(cents, t, T);
          voice.oscB.detune.setTargetAtTime(cents, t, T);
        }
        break;
      }
    }
  }

  /**
   * Called from motion handler with normalized -1..1 values for each axis.
   */
  setMotion(alpha: number, beta: number, gamma: number) {
    this.applyControl(this.mappings.beta, beta);
    this.applyControl(this.mappings.gamma, gamma);
    this.applyControl(this.mappings.alpha, alpha);
  }
}
