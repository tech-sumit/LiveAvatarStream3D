declare module 'gl' {
  interface GLContext {
    RGBA: number;
    UNSIGNED_BYTE: number;
    readPixels(
      x: number,
      y: number,
      w: number,
      h: number,
      format: number,
      type: number,
      pixels: Uint8Array,
    ): void;
    getExtension(name: string): { destroy?: () => void } | null;
  }

  export default function createGL(
    width: number,
    height: number,
    options?: { preserveDrawingBuffer?: boolean; antialias?: boolean },
  ): GLContext;
}

declare module 'three/examples/jsm/libs/meshopt_decoder.module.js' {
  export const MeshoptDecoder: { ready: Promise<void> };
}

declare module 'wavefile' {
  const wavefile: {
    WaveFile: new (buffer?: Buffer | ArrayBuffer) => {
      toBitDepth(bitDepth: string): void;
      getSamples(interleaved: boolean, OutputObject?: Int16ArrayConstructor): Int16Array | Float64Array;
      sampleRate: number;
    };
  };
  export default wavefile;
}

declare module 'pngjs' {
  export class PNG {
    constructor(opts: { width: number; height: number });
    data: Buffer;
    static sync: { write(png: PNG): Buffer };
  }
}
