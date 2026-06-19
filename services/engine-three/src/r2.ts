import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.js';

export class R2Client {
  private readonly s3: S3Client;

  constructor(private readonly cfg: Config) {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: cfg.r2Endpoint,
      credentials: {
        accessKeyId: cfg.r2AccessKeyId,
        secretAccessKey: cfg.r2SecretAccessKey,
      },
    });
  }

  async download(bucket: string, key: string, destPath: string): Promise<string> {
    await mkdir(dirname(destPath), { recursive: true });
    const res = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) throw new Error(`empty body for s3://${bucket}/${key}`);
    await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(destPath));
    return destPath;
  }

  async uploadFile(srcPath: string, bucket: string, key: string, contentType: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(srcPath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }
}
