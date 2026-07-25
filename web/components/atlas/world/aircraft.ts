"use client";

/**
 * The hangar. Every aircraft the atlas can fly is described here — the model,
 * how it handles, where its lights sit, and what its exhaust looks like — so
 * PlaneLayer stays one flight model rather than a pile of special cases.
 *
 * Anchor and exhaust positions are in MODEL units, measured off each baked
 * mesh offline (wingtip and fin-tip vertices; engines located as dips below
 * the wing for the A380, and as the aft-deck body for the Nighthawk). Every
 * airframe is baked to the same 8.6-unit length and nose-+Z orientation, so
 * `scale` alone decides how big it flies.
 *
 * Port/starboard is not arbitrary: with nose +Z and up +Y in a right-handed
 * frame, starboard = forward × up = Z × Y = −X. So the RED port light sits on
 * +X and the GREEN starboard light on −X.
 */

export type AircraftKey = "a380" | "f117";

export interface AircraftSpec {
  key: AircraftKey;
  label: string;
  sub: string;
  url: string;
  /** model units → world units */
  scale: number;
  /** chase-camera offsets, scaled to the airframe */
  chase: { back: number; up: number; ahead: number; aimUp: number };
  flight: {
    speedMin: number;
    speedMax: number;
    speedFloor: number;
    speedCeil: number;
    /** how fast the throttle spools, 0..1 per second */
    throttleRate: number;
    /** how eagerly speed chases the throttle setting */
    speedLerp: number;
    turnRate: number;
    pitchRate: number;
    pitchMax: number;
    bankMax: number;
    /** roll response, and how fast pitch self-centres */
    rollLerp: number;
    pitchDamp: number;
    /** speed gained in a dive / bled in a climb */
    diveGain: number;
    /** display knots per world unit/s */
    ktsPerUnit: number;
    /** spawn state */
    startSpeed: number;
    startThrottle: number;
  };
  anchors: {
    navPort: readonly [number, number, number];
    navStbd: readonly [number, number, number];
    /** one per anti-collision strobe — twin-tailed jets get two */
    strobes: readonly (readonly [number, number, number])[];
    /** round nacelle exhausts (glow aircraft) */
    engines: readonly (readonly [number, number, number])[];
    /**
     * Elongated exhaust troughs (slit aircraft), each with its own pose —
     * measured by PCA over the faces the airframe's emissive map lights, so
     * the glow lies IN the slit and is splayed at the real angle rather than
     * turned to face the camera. Local frame: X = width, Y = aft along the
     * trough, Z = surface normal.
     */
    slits?: readonly {
      pos: readonly [number, number, number];
      rot: readonly [number, number, number];
      len: number;
      wid: number;
    }[];
  };
  exhaust: {
    /**
     * "glow" — round turbofan haze, a soft sprite per nacelle, warm.
     * "slit" — the airframe's OWN emissive map is the exhaust (flattened to a
     *   luminance mask at bake time), tinted here and driven by speed, with a
     *   wide flat halo over each slit. Elongated, never conical.
     */
    kind: "glow" | "slit";
    core: string;
    halo: string;
    /** sprite size — for a slit this is the halo HEIGHT */
    size: number;
    /** halo width (slit only) — the slits are far wider than they are tall */
    width: number;
    /** emissive tint + how hard it burns at full speed (slit only) */
    emissive: string;
    emissiveMax: number;
  };
  /** exhaust brightness follows speed for a fighter, throttle for an airliner */
  exhaustFollows: "speed" | "throttle";
  /** what this aircraft drops or shoots at papers */
  weapon: {
    kind: "package" | "missile";
    /** HUD wording */
    label: string;
    fireLabel: string;
    /** body length in WORLD units (the jet itself is only ~0.2) */
    /**
     * Does the shot leave with the aircraft's velocity? A missile does (it
     * flies on from the rails); a crate does NOT — it drops straight down from
     * the bay, so you line up directly over the target instead of leading it.
     */
    inheritMomentum: boolean;
    /** speed added to the aircraft's own velocity at release, world units/s */
    launchSpeed: number;
    gravity: number;
    /** how close to the paper counts as a hit, in world units */
    hitRadius: number;
    cooldown: number;
    /** seconds before an unresolved shot gives up */
    life: number;
    color: string;
    size: number;
    /** mission wording for the HUD banner */
    hitText: string;
    missText: string;
  };
  /** contrail emitters — offset aft of the wingtips */
  trailAft: number;
  credit: { title: string; author: string; license: string; url: string };
}

export const AIRCRAFT: Record<AircraftKey, AircraftSpec> = {
  a380: {
    key: "a380",
    label: "Airbus A380",
    sub: "superjumbo · 560 tonnes",
    url: "/models/airbus-a380.glb",
    scale: 0.03,
    chase: { back: 0.31, up: 0.05, ahead: 0.32, aimUp: 0.038 },
    flight: {
      speedMin: 2.5,
      speedMax: 9,
      speedFloor: 2,
      speedCeil: 12,
      throttleRate: 0.28,
      speedLerp: 0.22,
      turnRate: 0.5,
      pitchRate: 0.5,
      pitchMax: 0.55,
      bankMax: 0.42,
      rollLerp: 2.2,
      pitchDamp: 0.35,
      diveGain: 3,
      ktsPerUnit: 48,
      startSpeed: 5,
      startThrottle: 0.55,
    },
    anchors: {
      navPort: [4.325, -0.4, -1.62],
      navStbd: [-4.325, -0.4, -1.61],
      strobes: [[0, 1.26, -3.98]],
      // inboard pair sits forward of the outboard pair — that is the wing sweep
      engines: [
        [-2.76, -0.95, -0.13],
        [-1.58, -1.04, 0.68],
        [1.61, -1.04, 0.64],
        [2.78, -0.95, -0.15],
      ],
    },
    exhaust: {
      kind: "glow",
      core: "#ffb36b",
      halo: "#ff8a2b",
      size: 0.26,
      width: 0.26,
      emissive: "#000000",
      emissiveMax: 0,
    },
    exhaustFollows: "throttle",
    // a cargo run: the crate falls straight out of the bay, so you line up
    // directly over the paper. Generous radius — you are dropping from altitude.
    weapon: {
      kind: "package",
      label: "cargo",
      fireLabel: "drop",
      inheritMomentum: false,
      launchSpeed: 0,
      gravity: 9.5,
      hitRadius: 3.2,
      cooldown: 1.1,
      life: 14,
      color: "#c8a672",
      size: 0.028,
      hitText: "package delivered",
      missText: "off target",
    },
    trailAft: 0.1,
    credit: {
      title: "A380",
      author: "AntoinePemeja",
      license: "CC BY 4.0",
      url: "https://sketchfab.com/3d-models/8hWQW1izQKZLYOZD4PKXti0xIjn",
    },
  },

  f117: {
    key: "f117",
    label: "F-117 Nighthawk",
    sub: "stealth attack · knife-edged",
    url: "/models/f117-nighthawk.glb",
    // flies smaller than the superjumbo, and the camera tucks in to match
    scale: 0.018,
    chase: { back: 0.21, up: 0.035, ahead: 0.2, aimUp: 0.026 },
    flight: {
      speedMin: 6,
      speedMax: 26,
      speedFloor: 4,
      speedCeil: 34,
      throttleRate: 0.85,
      speedLerp: 1.1,
      turnRate: 1.7,
      pitchRate: 1.6,
      pitchMax: 0.95,
      bankMax: 1.0,
      rollLerp: 7.5,
      pitchDamp: 1.1,
      diveGain: 9,
      ktsPerUnit: 26,
      startSpeed: 12,
      startThrottle: 0.6,
    },
    anchors: {
      navPort: [2.92, -0.22, -3.07],
      navStbd: [-2.92, -0.21, -3.09],
      // one strobe per canted tail tip
      strobes: [
        [-0.69, 0.9, -4.25],
        [0.7, 0.9, -4.24],
      ],
      engines: [],
      // Measured off the emissive-lit faces: 1.96 long x 0.71 wide x 0.11
      // thick, long axis splayed ~35 degrees outboard, normal facing up.
      slits: [
        { pos: [-0.61, -0.24, -1.85], rot: [-1.518, -0.069, -2.531], len: 1.96, wid: 0.71 },
        { pos: [0.6, -0.24, -1.84], rot: [-1.518, 0.072, 2.538], len: 1.96, wid: 0.71 },
      ],
    },
    exhaust: {
      kind: "slit",
      core: "#cfe8ff",
      halo: "#3d8bff",
      size: 0.3,
      width: 1.9,
      emissive: "#4d9dff",
      emissiveMax: 3.4,
    },
    exhaustFollows: "speed",
    // a strike run: flat, fast and unguided — aim with the nose
    weapon: {
      kind: "missile",
      label: "AGM",
      fireLabel: "fire",
      inheritMomentum: true,
      launchSpeed: 38,
      gravity: 1.4,
      hitRadius: 1.7,
      cooldown: 0.55,
      life: 6,
      color: "#b9c4d2",
      size: 0.075,
      hitText: "target neutralised",
      missText: "miss",
    },
    trailAft: 0.06,
    credit: {
      title: "Stealth F-117A",
      author: "Tanvir.Ahmed",
      license: "CC BY 4.0",
      url: "https://sketchfab.com/search?q=stealth+f-117a",
    },
  },
};

export const AIRCRAFT_LIST: AircraftSpec[] = [AIRCRAFT.a380, AIRCRAFT.f117];
