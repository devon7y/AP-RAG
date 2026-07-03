"use client";

/**
 * Ambient sonification for Radio Westbury — a tiny generative drone rig built
 * once and steered entirely by parameter ramps:
 *
 *   cluster identity → chord (pentatonic root + major/minor color, portamento)
 *   local density    → voice count + lowpass brightness (dense = rich, sparse = airy)
 *   map x position   → stereo pan (the walk literally moves across the room)
 *   station signal   → radio static bed (off-station = noisy, locked-on = clean)
 *   each hop         → soft bell ping · retune → static sweep
 *
 * Everything routes through a compressor at conservative gains — wall-monitor safe.
 */

const ROOTS = [110.0, 130.81, 146.83, 164.81, 196.0]; // A2 C3 D3 E3 G3 — global pentatonic
const VOICE_BASE = [0.11, 0.085, 0.07, 0.05];
const VOICE_THRESH = [0, 0.22, 0.45, 0.68];

function hashCluster(id: number): number {
  let h = (id + 1) * 2654435761;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
}

export class RadioAudio {
  private ctx: AudioContext;
  private master: GainNode;
  private duckGain: GainNode;
  private pauseGain: GainNode;
  private panner: StereoPannerNode;
  private lowpass: BiquadFilterNode;
  private chordBus: GainNode;
  private voices: Voice[] = [];
  private noiseGain: GainNode;
  private lfo: OscillatorNode;
  private disposed = false;
  private enabled = true;
  private volume = 0.6;
  private staticTarget = 0.04;
  private cutoffTarget = 900;
  private rootHz = ROOTS[0];
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error("Web Audio unavailable");
    this.ctx = new AC();
    const now = this.ctx.currentTime;

    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, now);
    compressor.ratio.setValueAtTime(6, now);
    compressor.connect(this.ctx.destination);

    this.master = this.ctx.createGain();
    this.master.gain.setValueAtTime(0, now); // fades in on start()
    this.master.connect(compressor);

    this.duckGain = this.ctx.createGain();
    this.duckGain.connect(this.master);
    this.pauseGain = this.ctx.createGain();
    this.pauseGain.connect(this.duckGain);

    this.panner = this.ctx.createStereoPanner();
    this.panner.connect(this.pauseGain);

    this.lowpass = this.ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.setValueAtTime(this.cutoffTarget, now);
    this.lowpass.Q.setValueAtTime(0.4, now);
    this.lowpass.connect(this.panner);

    this.chordBus = this.ctx.createGain();
    this.chordBus.gain.setValueAtTime(0.9, now);
    this.chordBus.connect(this.lowpass);

    const waves: OscillatorType[] = ["sine", "sine", "triangle", "sine"];
    const detunes = [0, 4, -3, 7];
    for (let i = 0; i < 4; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = waves[i];
      osc.frequency.setValueAtTime(ROOTS[0] * [1, 1.5, 2, 2.4][i], now);
      osc.detune.setValueAtTime(detunes[i], now);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      osc.connect(gain);
      gain.connect(this.chordBus);
      osc.start();
      this.voices.push({ osc, gain });
    }

    // slow shimmer: one LFO wobbling two voices' detune in opposite directions
    this.lfo = this.ctx.createOscillator();
    this.lfo.frequency.setValueAtTime(0.07, now);
    const lfoUp = this.ctx.createGain();
    lfoUp.gain.setValueAtTime(5, now);
    const lfoDown = this.ctx.createGain();
    lfoDown.gain.setValueAtTime(-6, now);
    this.lfo.connect(lfoUp);
    this.lfo.connect(lfoDown);
    lfoUp.connect(this.voices[1].osc.detune);
    lfoDown.connect(this.voices[3].osc.detune);
    this.lfo.start();

    // radio static: looped white noise through a bandpass
    const seconds = 2;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = buf;
    noiseSrc.loop = true;
    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(1500, now);
    bandpass.Q.setValueAtTime(0.7, now);
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.setValueAtTime(0, now);
    noiseSrc.connect(bandpass);
    bandpass.connect(this.noiseGain);
    this.noiseGain.connect(this.panner);
    noiseSrc.start();
  }

  private ramp(param: AudioParam, value: number, tc: number): void {
    if (this.disposed) return;
    param.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  private masterTarget(): number {
    return this.enabled ? Math.pow(this.volume, 1.6) * 0.9 : 0;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.ctx.resume();
    } catch {
      /* stays suspended — setters are still safe */
    }
    this.ramp(this.master.gain, this.masterTarget(), 1.2);
    this.ramp(this.noiseGain.gain, this.staticTarget, 1.5);
  }

  /** Chord for a cluster: deterministic pentatonic root + color tone, slow glide. */
  setChord(clusterId: number): void {
    if (this.disposed) return;
    const h = hashCluster(clusterId);
    const root = ROOTS[h % ROOTS.length];
    const color = (h & 16) === 0 ? 2.4 : 2.5; // minor vs major tenth on top
    const fifth = (h & 32) === 0 ? 1.5 : 1.335; // occasional sus4 flavor
    this.rootHz = root;
    const freqs = [root, root * fifth, root * 2, root * color];
    for (let i = 0; i < this.voices.length; i++) {
      this.ramp(this.voices[i].osc.frequency, freqs[i], 1.6);
    }
  }

  /** Local corpus density 0..1 → voice richness + filter brightness. */
  setDensity(d: number): void {
    if (this.disposed) return;
    this.cutoffTarget = 260 + 2600 * Math.pow(Math.min(1, Math.max(0, d)), 1.35);
    this.ramp(this.lowpass.frequency, this.cutoffTarget, 2.2);
    for (let i = 0; i < this.voices.length; i++) {
      const on = smoothstep(VOICE_THRESH[i] - 0.14, VOICE_THRESH[i] + 0.14, d);
      this.ramp(this.voices[i].gain.gain, VOICE_BASE[i] * (i === 0 ? 1 : on), 2.0);
    }
  }

  /** Map x (0..1) → stereo position. */
  setPan(x01: number): void {
    if (this.disposed) return;
    this.ramp(this.panner.pan, (Math.min(1, Math.max(0, x01)) * 2 - 1) * 0.8, 1.5);
  }

  /** Station signal 0..1 → static bed (tuned) or a faint carrier hiss (free drift). */
  setStatic(signal: number, tuned: boolean): void {
    if (this.disposed) return;
    this.staticTarget = tuned ? 0.012 + Math.pow(1 - signal, 1.5) * 0.055 : 0.03;
    this.ramp(this.noiseGain.gain, this.staticTarget, 1.8);
  }

  /** Soft bell on each hop of the walk. */
  ping(): void {
    if (this.disposed || !this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(this.rootHz * 3, t);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.05, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    osc.connect(env);
    env.connect(this.panner);
    osc.start(t);
    osc.stop(t + 1.8);
  }

  /** Retune gesture: brief static burst + filter sweep, then settle back. */
  sweep(): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime;
    this.noiseGain.gain.setTargetAtTime(0.22, t, 0.04);
    this.noiseGain.gain.setTargetAtTime(this.staticTarget, t + 0.4, 0.5);
    this.lowpass.frequency.setTargetAtTime(3600, t, 0.08);
    this.lowpass.frequency.setTargetAtTime(this.cutoffTarget, t + 0.45, 0.9);
  }

  /** Pull the bed down while the voice reads. */
  duck(on: boolean): void {
    this.ramp(this.duckGain.gain, on ? 0.35 : 1, 0.5);
  }

  setPaused(paused: boolean): void {
    this.ramp(this.pauseGain.gain, paused ? 0.1 : 1, 0.6);
  }

  setMaster(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.ramp(this.master.gain, this.masterTarget(), 0.3);
  }

  /** Tones toggle: fade out and suspend the context (battery), or wake it. */
  setEnabled(on: boolean): void {
    if (this.disposed) return;
    this.enabled = on;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (on) {
      void this.ctx.resume().catch(() => {});
      this.ramp(this.master.gain, this.masterTarget(), 0.8);
    } else {
      this.ramp(this.master.gain, 0, 0.25);
      this.suspendTimer = setTimeout(() => {
        if (!this.disposed && !this.enabled) void this.ctx.suspend().catch(() => {});
      }, 900);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    try {
      this.lfo.stop();
      for (const v of this.voices) v.osc.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx.close().catch(() => {});
  }
}
