"use client";

/**
 * Procedural WebAudio for the 747 — no audio assets shipped. The engine is
 * filtered looping noise (turbine wash) over a detuned sawtooth pair (spool
 * whine + rumble); the crash is a lowpass-swept noise boom with a sub thump
 * and a crackle tail. Call primePlaneAudio() from a user gesture (the
 * take-off button) so the AudioContext is allowed to start.
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

  // turbine wash — bandpassed noise
  const wash = c.createBufferSource();
  wash.buffer = noise();
  wash.loop = true;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 320;
  bp.Q.value = 0.6;
  const washGain = c.createGain();
  washGain.gain.value = 0.05;
  wash.connect(bp).connect(washGain).connect(master);

  // spool whine — two detuned saws through a lowpass
  const whineA = c.createOscillator();
  whineA.type = "sawtooth";
  whineA.frequency.value = 62;
  const whineB = c.createOscillator();
  whineB.type = "sawtooth";
  whineB.frequency.value = 62 * 1.01;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 180;
  const whineGain = c.createGain();
  whineGain.gain.value = 0.03;
  whineA.connect(lp);
  whineB.connect(lp);
  lp.connect(whineGain).connect(master);

  wash.start();
  whineA.start();
  whineB.start();

  let stopped = false;
  return {
    update(throttle, speed) {
      if (stopped) return;
      const t = c.currentTime;
      washGain.gain.setTargetAtTime(0.04 + 0.16 * throttle, t, 0.15);
      bp.frequency.setTargetAtTime(260 + speed * 38 + throttle * 320, t, 0.2);
      whineGain.gain.setTargetAtTime(0.02 + 0.075 * throttle, t, 0.15);
      const f = 54 + throttle * 44;
      whineA.frequency.setTargetAtTime(f, t, 0.3);
      whineB.frequency.setTargetAtTime(f * 1.013, t, 0.3);
      lp.frequency.setTargetAtTime(150 + throttle * 420 + speed * 8, t, 0.25);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      master.gain.setTargetAtTime(0, c.currentTime, 0.2);
      window.setTimeout(() => {
        try {
          wash.stop();
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
