"use client";

/**
 * Procedural WebAudio for the hangar — no audio assets shipped. Every engine is
 * a jet, never a prop: filtered-noise layers (rumble, body roar, exhaust hiss)
 * over tonal spool whine, mixed differently per airframe (see EngineVoice).
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

/**
 * Two engine voices. "turbofan" is the airliner: a deep rumble and sub carry
 * it, the whine stays a shimmer. "fighter" trades the mass for aggression —
 * far less sub, a hard mid-range rasp, and a dominant turbine scream that
 * climbs a full octave with throttle, so it reads as thrust rather than bulk.
 */
export type EngineVoice = "turbofan" | "fighter";

export function startEngine(voice: EngineVoice = "turbofan"): EngineSound | null {
  // a suspended context is fine — scheduled nodes sound once resume() lands
  if (!ctx) return null;
  const c = ctx;
  const fighter = voice === "fighter";
  const master = c.createGain();
  master.gain.value = 0;
  master.connect(c.destination);
  master.gain.setTargetAtTime(0.9 * MASTER, c.currentTime, fighter ? 0.25 : 0.6);

  // deep rumble — the bass foundation of a huge turbofan. Low-passed noise
  // with a resonant cutoff gives throaty body WITHOUT a tonal propeller buzz
  // (it's noise, not an oscillator, so there's no blade-passing pitch).
  const rumble = c.createBufferSource();
  rumble.buffer = noise();
  rumble.loop = true;
  const rumbleLp = c.createBiquadFilter();
  rumbleLp.type = "lowpass";
  rumbleLp.frequency.value = 130;
  rumbleLp.Q.value = 1.7;
  const rumbleGain = c.createGain();
  rumbleGain.gain.value = 0.14;
  rumble.connect(rumbleLp).connect(rumbleGain).connect(master);

  // sub weight — a very low sine for the chest-thump of 60,000 lbf of thrust
  const sub = c.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 44;
  const subGain = c.createGain();
  subGain.gain.value = 0.06;
  sub.connect(subGain).connect(master);

  // body roar — band-passed noise in the low-mid, bridges rumble and air
  const roar = c.createBufferSource();
  roar.buffer = noise();
  roar.loop = true;
  const roarBp = c.createBiquadFilter();
  roarBp.type = "bandpass";
  roarBp.frequency.value = 230;
  roarBp.Q.value = 0.7;
  const roarGain = c.createGain();
  roarGain.gain.value = 0.08;
  roar.connect(roarBp).connect(roarGain).connect(master);

  // spool whine — a subtle shimmer far on top, NOT the dominant voice; kept
  // low in both level and pitch so the engine never reads as a toy
  const whineA = c.createOscillator();
  whineA.type = "sine";
  whineA.frequency.value = 520;
  const whineB = c.createOscillator();
  whineB.type = "sine";
  whineB.frequency.value = 520 * 1.5;
  const whineBGain = c.createGain();
  whineBGain.gain.value = 0.4;
  const whineGain = c.createGain();
  whineGain.gain.value = 0.004;
  whineA.connect(whineGain);
  whineB.connect(whineBGain).connect(whineGain);
  whineGain.connect(master);

  // exhaust hiss — a thin layer of air over the top
  const hiss = c.createBufferSource();
  hiss.buffer = noise();
  hiss.loop = true;
  const hissHp = c.createBiquadFilter();
  hissHp.type = "highpass";
  hissHp.frequency.value = 3400;
  const hissGain = c.createGain();
  hissGain.gain.value = 0.004;
  hiss.connect(hissHp).connect(hissGain).connect(master);

  // fighter only: a hard band-passed rasp in the upper mid — the crackle that
  // makes a military engine sound angry rather than merely large
  const rasp = c.createBufferSource();
  rasp.buffer = noise();
  rasp.loop = true;
  const raspBp = c.createBiquadFilter();
  raspBp.type = "bandpass";
  raspBp.frequency.value = 1700;
  raspBp.Q.value = 0.9;
  const raspGain = c.createGain();
  raspGain.gain.value = 0;
  rasp.connect(raspBp).connect(raspGain).connect(master);

  rumble.start();
  sub.start();
  roar.start();
  rasp.start();
  whineA.start();
  whineB.start();
  hiss.start();

  let stopped = false;
  return {
    update(throttle, speed) {
      if (stopped) return;
      const t = c.currentTime;
      if (fighter) {
        // thin the bottom end, push the scream: the whine leads the mix and
        // sweeps 900 Hz -> 2.6 kHz, an octave and a half on the throttle
        rumbleGain.gain.setTargetAtTime(0.05 + 0.12 * throttle, t, 0.1);
        rumbleLp.frequency.setTargetAtTime(150 + throttle * 260, t, 0.15);
        subGain.gain.setTargetAtTime(0.015 + 0.03 * throttle, t, 0.15);
        sub.frequency.setTargetAtTime(58 + throttle * 34, t, 0.2);
        roarGain.gain.setTargetAtTime(0.05 + 0.19 * throttle, t, 0.1);
        roarBp.frequency.setTargetAtTime(420 + throttle * 700 + speed * 12, t, 0.15);
        raspGain.gain.setTargetAtTime(0.012 + 0.055 * throttle, t, 0.12);
        raspBp.frequency.setTargetAtTime(1500 + throttle * 1500, t, 0.18);
        const f = 900 + throttle * 1700;
        whineA.frequency.setTargetAtTime(f, t, 0.16);
        whineB.frequency.setTargetAtTime(f * 1.5, t, 0.16);
        whineGain.gain.setTargetAtTime(0.012 + 0.05 * throttle, t, 0.12);
        hissGain.gain.setTargetAtTime(
          0.006 + 0.05 * throttle + speed * 0.0009,
          t,
          0.1,
        );
        return;
      }
      // the rumble & sub carry the mass — they grow most with throttle and
      // stay deep (105–225 Hz), so spooling up reads as sheer power
      rumbleGain.gain.setTargetAtTime(0.11 + 0.28 * throttle, t, 0.15);
      rumbleLp.frequency.setTargetAtTime(105 + throttle * 120 + speed * 6, t, 0.2);
      subGain.gain.setTargetAtTime(0.05 + 0.1 * throttle, t, 0.2);
      sub.frequency.setTargetAtTime(40 + throttle * 22, t, 0.3);
      roarGain.gain.setTargetAtTime(0.06 + 0.17 * throttle, t, 0.15);
      roarBp.frequency.setTargetAtTime(200 + throttle * 240 + speed * 14, t, 0.2);
      const f = 440 + throttle * 760;
      whineA.frequency.setTargetAtTime(f, t, 0.35);
      whineB.frequency.setTargetAtTime(f * 1.5, t, 0.35);
      whineGain.gain.setTargetAtTime(0.003 + 0.008 * throttle, t, 0.2);
      hissGain.gain.setTargetAtTime(
        0.003 + 0.02 * throttle + speed * 0.001,
        t,
        0.15,
      );
    },
    stop() {
      if (stopped) return;
      stopped = true;
      master.gain.setTargetAtTime(0, c.currentTime, 0.2);
      window.setTimeout(() => {
        try {
          rumble.stop();
          sub.stop();
          roar.stop();
          rasp.stop();
          whineA.stop();
          whineB.stop();
          hiss.stop();
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

/* ---------------- ordnance ---------------- */

/** Weapon release: a missile rips away on a rising whoosh; a crate just
 *  clunks off the rails. Both are short — they punctuate, never linger. */
export function playLaunch(missile: boolean): void {
  if (!ctx) return;
  const c = ctx;
  const t0 = c.currentTime;

  if (!missile) {
    // a crate just drops off the rails: a short muted clunk
    const air = c.createBufferSource();
    air.buffer = noise();
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, t0);
    lp.frequency.exponentialRampToValueAtTime(180, t0 + 0.18);
    const g = c.createGain();
    g.gain.setValueAtTime(0.34 * MASTER, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    air.connect(lp).connect(g).connect(c.destination);
    air.start(t0);
    air.stop(t0 + 0.3);
    const thump = c.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(96, t0);
    thump.frequency.exponentialRampToValueAtTime(44, t0 + 0.16);
    const tg = c.createGain();
    tg.gain.setValueAtTime(0.42 * MASTER, t0);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    thump.connect(tg).connect(c.destination);
    thump.start(t0);
    thump.stop(t0 + 0.25);
    return;
  }

  // A rocket launcher has three parts: the IGNITION crack, the motor ROAR
  // while it burns, and the roar dropping in pitch as the missile runs away
  // from you. The old single rising sweep had none of that shape.
  const crack = c.createBufferSource();
  crack.buffer = noise();
  const ch = c.createBiquadFilter();
  ch.type = "highpass";
  ch.frequency.value = 1800;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.85 * MASTER, t0);
  cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
  crack.connect(ch).connect(cg).connect(c.destination);
  crack.start(t0);
  crack.stop(t0 + 0.15);

  // the motor: broad and loud, its band falling 1.5 kHz -> 260 Hz as it goes
  const motor = c.createBufferSource();
  motor.buffer = noise();
  const mb = c.createBiquadFilter();
  mb.type = "bandpass";
  mb.Q.value = 0.5;
  mb.frequency.setValueAtTime(1500, t0 + 0.02);
  mb.frequency.exponentialRampToValueAtTime(260, t0 + 1.05);
  const mg = c.createGain();
  mg.gain.setValueAtTime(0.0001, t0);
  mg.gain.exponentialRampToValueAtTime(0.72 * MASTER, t0 + 0.06);
  mg.gain.setValueAtTime(0.72 * MASTER, t0 + 0.3);
  mg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.25);
  motor.connect(mb).connect(mg).connect(c.destination);
  motor.start(t0);
  motor.stop(t0 + 1.3);

  // the low chuff of the launch tube
  const thump = c.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(190, t0);
  thump.frequency.exponentialRampToValueAtTime(52, t0 + 0.3);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.7 * MASTER, t0);
  tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
  thump.connect(tg).connect(c.destination);
  thump.start(t0);
  thump.stop(t0 + 0.45);
}

/** Impact. A hit gets a real detonation plus a rising two-tone confirmation
 *  chime — the "target neutralised" sting; a miss gets a dull thud only. */
export function playImpact(ok: boolean): void {
  if (!ctx) return;
  const c = ctx;
  const t0 = c.currentTime;

  const blast = c.createBufferSource();
  blast.buffer = noise();
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(ok ? 1800 : 700, t0);
  lp.frequency.exponentialRampToValueAtTime(ok ? 120 : 90, t0 + (ok ? 1.1 : 0.4));
  const bg = c.createGain();
  bg.gain.setValueAtTime((ok ? 0.7 : 0.26) * MASTER, t0);
  bg.gain.exponentialRampToValueAtTime(0.0001, t0 + (ok ? 1.3 : 0.45));
  blast.connect(lp).connect(bg).connect(c.destination);
  blast.start(t0);
  blast.stop(t0 + (ok ? 1.4 : 0.5));

  const sub = c.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(ok ? 96 : 70, t0);
  sub.frequency.exponentialRampToValueAtTime(ok ? 40 : 38, t0 + 0.5);
  const sg = c.createGain();
  sg.gain.setValueAtTime((ok ? 0.75 : 0.3) * MASTER, t0);
  sg.gain.exponentialRampToValueAtTime(0.0001, t0 + (ok ? 0.75 : 0.4));
  sub.connect(sg).connect(c.destination);
  sub.start(t0);
  sub.stop(t0 + 0.8);

  if (!ok) return;
  // confirmation: two clean tones a fifth apart, the second landing late
  [
    { f: 880, at: 0.1 },
    { f: 1320, at: 0.22 },
  ].forEach(({ f, at }) => {
    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, t0 + at);
    og.gain.exponentialRampToValueAtTime(0.24 * MASTER, t0 + at + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.55);
    o.connect(og).connect(c.destination);
    o.start(t0 + at);
    o.stop(t0 + at + 0.6);
  });
}
