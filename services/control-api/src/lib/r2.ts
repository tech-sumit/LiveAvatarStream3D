import type { Env } from '../env.js';

export type BucketName = 'assets' | 'avatars' | 'voices' | 'outputs';

export function bucket(env: Env, name: BucketName): R2Bucket {
  switch (name) {
    case 'assets':
      return env.ASSETS;
    case 'avatars':
      return env.AVATARS;
    case 'voices':
      return env.VOICES;
    case 'outputs':
      return env.OUTPUTS;
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown bucket ${_exhaustive as string}`);
    }
  }
}

/**
 * An upload "URL" the browser PUTs to. Rather than minting S3 presigned URLs,
 * we proxy uploads through the Worker (simple + fine for an internal tool):
 * the returned URL is a Worker route that streams the body into R2.
 */
export function uploadKeyForBucket(name: BucketName, key: string): string {
  return `/api/uploads/${name}/${key}`;
}
