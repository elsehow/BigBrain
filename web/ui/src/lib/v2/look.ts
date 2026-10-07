// How the Field draws sources against entities. The defaults are the shipped
// look; the scene reads this every frame, so the dev tuning panel
// (src/dev/fieldTune.ts) can move them live. Nothing else writes it.

export interface FieldLook {
  /** A resting source's dot, times its shipped size. */
  srcSize: number;
  /** 0: every source the same size; 1: sized by how many entities it mentions. */
  srcByTies: number;
  /** A resting source's opacity. */
  srcAlpha: number;
  /** Its colour: 0 the field's dust (an unnamed entity's), 1 full ink. */
  srcTone: number;
  /** Toward the theme's activity colour. */
  srcAccent: number;
  /** 0 a filled dot, 1 a thin ring. */
  srcHole: number;
  /** 0 round, 1 square. */
  srcSquare: number;
  /** Turned 45° (a square becomes a diamond). */
  srcTurn: number;
  /** World units up (+) or down (−) from the entities' band. */
  srcLift: number;
  /** 0 each at its own height, 1 all on one plane. */
  srcFlat: number;
  /** Every source's lines to what it mentions, drawn at rest (opacity). */
  srcTies: number;
  /** An entity's dot, times its shipped size. */
  entSize: number;
  /** An entity's opacity, times its shipped opacity. */
  entAlpha: number;
}

export const LOOK_DEFAULTS: Readonly<FieldLook> = Object.freeze({
  srcSize: 1, srcByTies: 0, srcAlpha: 0.75, srcTone: 0, srcAccent: 0, srcHole: 0, srcSquare: 0, srcTurn: 0,
  srcLift: 0, srcFlat: 0, srcTies: 0, entSize: 1, entAlpha: 1,
});

export const look: FieldLook = { ...LOOK_DEFAULTS };
