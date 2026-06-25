/**
 * Exports the shared schemas to JSON Schema so the Python GPU services can
 * validate the same DSL / job / director contracts. Output: dist/schema/*.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  Script,
  ScriptSegment,
  StreamedSegment,
  AvatarProfile,
  BuildAvatarRequest,
  VoiceProfile,
  CloneVoiceRequest,
  Job,
  OfflineRenderSpec,
  PostProcessingSpec,
  CameraCue,
  QueueMessage,
  JobEvent,
  JobProgressWebhook,
  DirectorRequest,
  DirectorStreamChunk,
  RealtimeSession,
  SessionMedia,
  NewsReportDoc,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'dist', 'schema');
mkdirSync(outDir, { recursive: true });

const schemas = {
  Script,
  ScriptSegment,
  StreamedSegment,
  AvatarProfile,
  BuildAvatarRequest,
  VoiceProfile,
  CloneVoiceRequest,
  Job,
  OfflineRenderSpec,
  PostProcessingSpec,
  CameraCue,
  QueueMessage,
  JobEvent,
  JobProgressWebhook,
  DirectorRequest,
  DirectorStreamChunk,
  RealtimeSession,
  SessionMedia,
  NewsReportDoc,
} as const;

for (const [name, schema] of Object.entries(schemas)) {
  const json = zodToJsonSchema(schema, name);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(json, null, 2));
}

writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify({ schemas: Object.keys(schemas) }, null, 2),
);

console.log(`Wrote ${Object.keys(schemas).length} JSON schemas to ${outDir}`);
