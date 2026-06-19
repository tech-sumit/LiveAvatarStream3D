/** Stub WebGL2 entry points missing from headless-gl (WebGL1 only). */
export function patchHeadlessGlContext(ctx: object): void {
  const gl = ctx as Record<string, unknown>;
  const noop = () => undefined;
  for (const fn of [
    'texImage3D',
    'texSubImage3D',
    'copyTexSubImage3D',
    'compressedTexImage3D',
    'compressedTexSubImage3D',
    'framebufferTextureLayer',
    'blitFramebuffer',
    'renderbufferStorageMultisample',
    'drawBuffers',
    'clearBufferfv',
    'clearBufferiv',
    'clearBufferuiv',
    'clearBufferfi',
  ]) {
    if (typeof gl[fn] !== 'function') {
      gl[fn] = noop;
    }
  }
}
