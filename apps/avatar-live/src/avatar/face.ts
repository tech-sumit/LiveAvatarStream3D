// Abstract face channels. The lipsync engine and emotion layer write these
// 0..1 values; a FaceRig maps them onto whatever an avatar actually exposes
// (glTF ARKit/Oculus morph targets, or the procedural fallback head). Keeping
// the channels avatar-agnostic is what lets one lipsync pipeline drive any asset.
export interface FaceChannels {
  jawOpen: number; // mouth open amount (vowels, overall loudness)
  mouthWide: number; // spread / "ee"-"ih" shapes
  mouthRound: number; // pucker / "oo"-"oh" shapes
  mouthClose: number; // bilabial closure ("p","b","m")
  smile: number; // emotion: positive
  frown: number; // emotion: negative
  browRaise: number; // emotion / emphasis
  blink: number; // 1 = eyes fully closed
}

export function zeroChannels(): FaceChannels {
  return {
    jawOpen: 0,
    mouthWide: 0,
    mouthRound: 0,
    mouthClose: 0,
    smile: 0,
    frown: 0,
    browRaise: 0,
    blink: 0,
  };
}

/** Anything that can render abstract face channels onto a concrete avatar. */
export interface FaceRig {
  apply(c: FaceChannels): void;
}
