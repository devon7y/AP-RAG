"use client";

/**
 * Procedural WebAudio for the 747 — no audio assets shipped. The engine is a
 * turbofan, not a prop: a broadband turbine roar (bandpassed noise that opens
 * with throttle), a high exhaust hiss (highpassed noise), and a thin spool
 * whine way up at 2–5 kHz with a harmonic — no low sawtooth drone anywhere.
 * The crash is a lowpass-swept noise boom with a sub thump and crackle tail.
 * Call primePlaneAudio() from a user gesture (the take-off button) so the
 * AudioContext is allowed to start.
 */

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

const MASTER = 0.8;

export function primePlaneAudio(): void {
  if (typeof window === "undefined") return;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  void ctx.resume();
}

function noise(): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const c = ctx!;
  const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

export interface EngineSound {
  /** throttle 0..1, speed in world units/s */
  update(throttle: number, speed: number): void;
  stop(): void;
}

export function startEngine(): EngineSound | null {
  // a suspended context is fine — scheduled nodes sound once resume() lands
  if (!ctx) return null;
  const c = ctx;
  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);
  master.gain.setTargetAtTime(0.9 * MASTER, c.currentTime, 0.6);

  // turbine roar — broadband noise that opens up with N1
  const roar = c.createBufferSource();
  roar.buffer = noise();
  roar.loop = true;
  const roarBp = c.createBiquadFilter();
  roarBp.type = "bandpass";
  roarBp.frequency.value = 700;
  roarBp.Q.value = 0.45;
  const roarGain = c.createGain();
  roarGain.gain.value = 0.05;
  roar.connect(roarBp).connect(roarGain).connect(master);

  // exhaust hiss — the jet's high white rush
  const hiss = c.createBufferSource();
  hiss.buffer = noise();
  hiss.loop = true;
  const hissHp = c.createBiquadFilter();
  hissHp.type = "highpass";
  hissHp.frequency.value = 2600;
  const hissGain = c.createGain();
  hissGain.gain.value = 0.01;
  hiss.connect(hissHp).connect(hissGain).connect(master);

  // spool whine — thin tones far above any prop, with one harmonic
  const whineA = c.createOscillator();
  whineA.type = "sine";
  whineA.frequency.value = 2100;
  const whineB = c.createOscillator();
  whineB.type = "sine";
  whineB.frequency.value = 2100 * 1.52;
  const whineBGain = c.createGain();
  whineBGain.gain.value = 0.45;
  const whineGain = c.createGain();
  whineGain.gain.value = 0.006;
  whineA.connect(whineGain);
  whineB.connect(whineBGain).connect(whineGain);
  whineGain.connect(master);

  roar.start();
  hiss.start();
  whineA.start();
  whineB.start();

  let stopped = false;
  return {
    update(throttle, speed) {
      if (stopped) return;
      const t = c.currentTime;
      roarGain.gain.setTargetAtTime(0.05 + 0.2 * throttle, t, 0.15);
      roarBp.frequency.setTargetAtTime(650 + throttle * 900 + speed * 40, t, 0.2);
      hissGain.gain.setTargetAtTime(
        0.008 + 0.05 * throttle + speed * 0.0015,
        t,
        0.15,
      );
      const f = 1900 + throttle * 3300;
      whineA.frequency.setTargetAtTime(f, t, 0.35);
      whineB.frequency.setTargetAtTime(f * 1.52, t, 0.35);
      whineGain.gain.setTargetAtTime(0.005 + 0.015 * throttle, t, 0.2);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      master.gain.setTargetAtTime(0, c.currentTime, 0.2);
      window.setTimeout(() => {
        try {
          roar.stop();
          hiss.stop();
          whineA.stop();
          whineB.stop();
          master.disconnect();
        } catch {
          /* already gone */
        }
      }, 900);
    },
  };
}

export interface WarningSound {
  stop(): void;
}

/** GPWS-style terrain siren — a rising whoop on loop while too low. */
export function startAltitudeWarning(): WarningSound | null {
  if (!ctx) return null;
  const c = ctx;
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(c.destination);
  g.gain.setTargetAtTime(0.13 * MASTER, c.currentTime, 0.05);

  const osc = c.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 620;
  // sawtooth LFO sweeps the pitch up ~2.4× per second: whoop, whoop, whoop
  const lfo = c.createOscillator();
  lfo.type = "sawtooth";
  lfo.frequency.value = 2.4;
  const depth = c.createGain();
  depth.gain.value = 330;
  lfo.connect(depth).connect(osc.frequency);
  osc.connect(g);
  osc.start();
  lfo.start();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      g.gain.setTargetAtTime(0, c.currentTime, 0.06);
      window.setTimeout(() => {
        try {
          osc.stop();
          lfo.stop();
          g.disconnect();
        } catch {
          /* already gone */
        }
      }, 400);
    },
  };
}

export function playExplosion(): void {
  if (!ctx) return;
  const c = ctx;
  const t0 = c.currentTime;

  // the boom — noise swept from open roar down to rumble
  const boom = c.createBufferSource();
  boom.buffer = noise();
  const blp = c.createBiquadFilter();
  blp.type = "lowpass";
  blp.frequency.setValueAtTime(2400, t0);
  blp.frequency.exponentialRampToValueAtTime(110, t0 + 2.2);
  const bg = c.createGain();
  bg.gain.setValueAtTime(1.0 * MASTER, t0);
  bg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.6);
  boom.connect(blp).connect(bg).connect(c.destination);
  boom.start(t0);
  boom.stop(t0 + 2.7);

  // sub thump
  const sub = c.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(64, t0);
  sub.frequency.exponentialRampToValueAtTime(34, t0 + 0.7);
  const sg = c.createGain();
  sg.gain.setValueAtTime(0.9 * MASTER, t0);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
  sub.connect(sg).connect(c.destination);
  sub.start(t0);
  sub.stop(t0 + 1.1);

  // crackle tail — highpassed noise, delayed a touch
  const crack = c.createBufferSource();
  crack.buffer = noise();
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1500;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, t0);
  cg.gain.exponentialRampToValueAtTime(0.28 * MASTER, t0 + 0.12);
  cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.9);
  crack.connect(hp).connect(cg).connect(c.destination);
  crack.start(t0 + 0.05);
  crack.stop(t0 + 2.0);
}
