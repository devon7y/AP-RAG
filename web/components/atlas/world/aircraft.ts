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
    strobe: readonly [number, number, number];
    engines: readonly (readonly [number, number, number])[];
  };
  exhaust: {
    /** "glow" = warm turbofan haze · "burner" = blue afterburner with a plume */
    kind: "glow" | "burner";
    core: string;
    halo: string;
    size: number;
    /** plume length in model units (burner only) */
    plume: number;
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
      strobe: [0, 1.26, -3.98],
      // inboard pair sits forward of the outboard pair — that is the wing sweep
      engines: [
        [-2.76, -0.95, -0.13],
        [-1.58, -1.04, 0.68],
        [1.61, -1.04, 0.64],
        [2.78, -0.95, -0.15],
      ],
    },
    exhaust: { kind: "glow", core: "#ffb36b", halo: "#ff8a2b", size: 0.26, plume: 0 },
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
      // the canted tails trail aft of the exhausts — the strobe rides one tip
      strobe: [-0.69, 0.9, -4.25],
      // the platypus exhausts: a narrow aft deck at |x| < 0.14, ending z = -3.43
      engines: [
        [-0.15, 0.02, -3.5],
        [0.15, 0.02, -3.5],
      ],
    },
    exhaust: {
      kind: "burner",
      core: "#dceeff",
      halo: "#2f7dff",
      size: 0.34,
      plume: 1.5,
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
