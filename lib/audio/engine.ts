// E minor pentatonic, 2 octaves
export const SCALE_MIDI = [52, 55, 57, 59, 62, 64, 67, 69, 71, 74, 76];
export const MIDI_LOW = 52;
export const MIDI_HIGH = 76;

const CHROMATIC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

export function midiToNoteName(midi: number): string {
  const r = Math.round(midi);
  return CHROMATIC[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

export function yNormToMidi(yNorm: number, quantized: boolean): number {
  const cont = MIDI_HIGH - yNorm * (MIDI_HIGH - MIDI_LOW);
  if (!quantized) return cont;
  let best = SCALE_MIDI[0];
  let bestD = Infinity;
  for (const n of SCALE_MIDI) {
    const d = Math.abs(cont - n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

export function midiToYNorm(midi: number): number {
  return (MIDI_HIGH - midi) / (MIDI_HIGH - MIDI_LOW);
}

function midiToHz(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function generateImpulse(ctx: AudioContext, dur: number, decay: number) {
  const len = ctx.sampleRate * dur;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

const T_FAST = 0.015;
const T_MED  = 0.03;
const T_SLOW = 0.05;

/**
 * Monophonic violin-like engine.
 *
 * Signal chain:
 *   oscSaw + oscTri → bodyGain → filter ─┐
 *   noise → noiseBP → noiseGain ─────────┤→ dryGain ──→ master → dest
 *                                         └→ convolver → wetGain → master
 *   lfo → lfoGain → osc.detune
 *
 * bodyGain / noiseGain are driven by gate * bowEnergy.
 * filter.frequency driven by bowEnergy + beta tilt + direction bias.
 */
export class ViolinEngine {
  private ctx: AudioContext | null = null;

  private oscSaw: OscillatorNode | null = null;
  private oscTri: OscillatorNode | null = null;

  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseBP: BiquadFilterNode | null = null;
  private noiseGain: GainNode | null = null;

  private bodyGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;

  private dryGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wetGain: GainNode | null = null;

  private delayNode: DelayNode | null = null;
  private delayFB: GainNode | null = null;
  private delayWet: GainNode | null = null;

  private master: GainNode | null = null;

  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;

  private started = false;
  private gateOpen = false;
  private bowEnergy = 0;
  private bowDir = 1;
  private brightness = 0.5;
  private currentMidi = 64;

  isStarted() { return this.started; }

  async start() {
    if (this.started) return;
    const Ctx = window.AudioContext ||
      (window as unknown as Record<string, typeof AudioContext>).webkitAudioContext;
    this.ctx = new Ctx();
    const t = this.ctx.currentTime;

    // --- Oscillators (run continuously, gated by bodyGain) ---
    this.oscSaw = this.ctx.createOscillator();
    this.oscSaw.type = "sawtooth";
    this.oscSaw.frequency.setValueAtTime(midiToHz(this.currentMidi), t);

    this.oscTri = this.ctx.createOscillator();
    this.oscTri.type = "triangle";
    this.oscTri.frequency.setValueAtTime(midiToHz(this.currentMidi), t);

    // --- Noise ---
    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = createNoiseBuffer(this.ctx);
    this.noiseSource.loop = true;

    this.noiseBP = this.ctx.createBiquadFilter();
    this.noiseBP.type = "bandpass";
    this.noiseBP.frequency.setValueAtTime(2000, t);
    this.noiseBP.Q.setValueAtTime(0.8, t);

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0, t);

    // --- Body gain (gate * bowEnergy for oscillators) ---
    this.bodyGain = this.ctx.createGain();
    this.bodyGain.gain.setValueAtTime(0, t);

    // --- Filter ---
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.setValueAtTime(800, t);
    this.filter.Q.setValueAtTime(1.2, t);

    // --- Mix bus ---
    const mixBus = this.ctx.createGain();
    mixBus.gain.setValueAtTime(1, t);

    // --- Reverb ---
    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = generateImpulse(this.ctx, 1.8, 2.8);
    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.setValueAtTime(1, t);
    this.wetGain = this.ctx.createGain();
    this.wetGain.gain.setValueAtTime(0.18, t);

    // --- Delay ---
    this.delayNode = this.ctx.createDelay(1.0);
    this.delayNode.delayTime.setValueAtTime(0.22, t);
    this.delayFB = this.ctx.createGain();
    this.delayFB.gain.setValueAtTime(0.2, t);
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.setValueAtTime(0.12, t);

    // --- Master ---
    this.master = this.ctx.createGain();
    this.master.gain.setValueAtTime(0.85, t);

    // --- LFO (vibrato) ---
    this.lfo = this.ctx.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.setValueAtTime(5.5, t);
    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.setValueAtTime(0, t);
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.oscSaw.detune);
    this.lfoGain.connect(this.oscTri.detune);

    // --- Wiring ---
    // Oscillators → bodyGain → filter
    this.oscSaw.connect(this.bodyGain);
    this.oscTri.connect(this.bodyGain);
    this.bodyGain.connect(this.filter);

    // Noise → bandpass → noiseGain → filter
    this.noiseSource.connect(this.noiseBP);
    this.noiseBP.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);

    // Filter → mixBus
    this.filter.connect(mixBus);

    // MixBus → dry path
    mixBus.connect(this.dryGain);
    // MixBus → delay → delayWet (+ feedback loop)
    mixBus.connect(this.delayNode);
    this.delayNode.connect(this.delayFB);
    this.delayFB.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);

    // Dry + delayWet → reverb split
    const preReverb = this.ctx.createGain();
    preReverb.gain.setValueAtTime(1, t);
    this.dryGain.connect(preReverb);
    this.delayWet.connect(preReverb);

    preReverb.connect(this.master); // dry reverb path
    preReverb.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.master);

    this.master.connect(this.ctx.destination);

    // Start sources
    this.oscSaw.start(t);
    this.oscTri.start(t);
    this.noiseSource.start(t);
    this.lfo.start(t);

    await this.ctx.resume();
    this.started = true;
  }

  // --- Gate (finger on/off string) ---

  setGate(on: boolean) {
    this.gateOpen = on;
    this.updateLevels();
  }

  // --- Pitch ---

  setPitch(midi: number) {
    if (!this.ctx) return;
    this.currentMidi = midi;
    const hz = midiToHz(midi);
    const t = this.ctx.currentTime;
    this.oscSaw!.frequency.setTargetAtTime(hz, t, T_FAST);
    this.oscTri!.frequency.setTargetAtTime(hz, t, T_FAST);
    // Noise bandpass tracks pitch (centered around 3rd harmonic area)
    this.noiseBP!.frequency.setTargetAtTime(
      Math.min(hz * 3, 8000), t, T_MED
    );
  }

  // --- Bow (from acceleration-based velocity integration) ---

  setBow(energy: number, direction: number) {
    this.bowEnergy = energy;
    this.bowDir = direction;
    this.updateLevels();
    this.updateFilter();
  }

  triggerOnset() {
    if (!this.ctx || !this.gateOpen) return;
    const t = this.ctx.currentTime;

    // Gain bump
    if (this.bodyGain) {
      const cur = Math.max(this.bodyGain.gain.value, 0.001);
      this.bodyGain.gain.cancelScheduledValues(t);
      this.bodyGain.gain.setValueAtTime(cur * 1.5, t);
      this.bodyGain.gain.setTargetAtTime(cur, t + 0.01, T_MED);
    }

    // Filter bump
    if (this.filter) {
      const curF = this.filter.frequency.value;
      this.filter.frequency.cancelScheduledValues(t);
      this.filter.frequency.setValueAtTime(curF + 900, t);
      this.filter.frequency.setTargetAtTime(curF, t + 0.01, T_SLOW);
    }

    // Noise burst
    if (this.noiseGain) {
      const curN = Math.max(this.noiseGain.gain.value, 0.001);
      this.noiseGain.gain.cancelScheduledValues(t);
      this.noiseGain.gain.setValueAtTime(Math.min(curN * 3, 0.5), t);
      this.noiseGain.gain.setTargetAtTime(curN, t + 0.01, T_MED);
    }
  }

  // --- Tilt controls ---

  setBrightness(v: number) {
    this.brightness = Math.max(0, Math.min(1, v));
    this.updateFilter();
  }

  setVibratoDepth(v: number) {
    if (!this.ctx || !this.lfoGain) return;
    const cents = Math.abs(v) * 40; // 0..40 cents
    this.lfoGain.gain.setTargetAtTime(cents, this.ctx.currentTime, T_SLOW);
  }

  // --- All off ---

  allOff() {
    this.gateOpen = false;
    this.bowEnergy = 0;
    this.updateLevels();
  }

  // --- Internal ---

  private updateLevels() {
    if (!this.ctx || !this.bodyGain || !this.noiseGain) return;
    const t = this.ctx.currentTime;

    if (this.gateOpen) {
      // Curve the energy so low-bow is still clearly audible
      const curved = Math.pow(this.bowEnergy, 0.6);
      const bodyLevel = 0.05 + curved * 0.55;
      const noiseLevel = curved * curved * 0.25;
      this.bodyGain.gain.setTargetAtTime(bodyLevel, t, T_FAST);
      this.noiseGain.gain.setTargetAtTime(noiseLevel, t, T_FAST);
    } else {
      this.bodyGain.gain.setTargetAtTime(0, t, T_MED);
      this.noiseGain.gain.setTargetAtTime(0, t, T_MED);
    }
  }

  private updateFilter() {
    if (!this.ctx || !this.filter) return;
    const t = this.ctx.currentTime;

    const BASE = 600;
    const RANGE = 5000;
    const dirBias = this.bowDir > 0 ? 1.12 : 0.9;
    const cutoff =
      (BASE + (this.bowEnergy * 0.55 + this.brightness * 0.45) * RANGE) * dirBias;

    this.filter.frequency.setTargetAtTime(
      Math.min(cutoff, 12000), t, T_MED
    );
  }
}
