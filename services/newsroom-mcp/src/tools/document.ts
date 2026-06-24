/**
 * Newsroom MCP — document tools (task NM-4).
 *
 * Tools that import / patch / validate the whole {@link NewsReportDoc} held by
 * the connected studio. The doc is validated locally with the protocol's
 * {@link validateNewsReportDoc} (the single source of truth) before being
 * applied over the bridge, so the studio never sees a malformed doc from us.
 *
 * These plug into the registry via the `documentTools` export, which the
 * orchestrator spreads into `TOOL_MODULES` in `server.ts` (do not edit
 * `server.ts` here — that wiring is intentionally left to the orchestrator to
 * avoid parallel-edit conflicts).
 */

import { z } from 'zod';
import { ZodError } from 'zod';
import { validateNewsReportDoc } from '@las/protocol';

import { defineTool, type ToolDef } from '../server.js';
import { callBridge } from '../transport.js';

/** Format a ZodError into a compact, human-readable message. */
function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}

const setNewscast = defineTool({
  name: 'set_newscast',
  title: 'Set the newscast document',
  description:
    'Validate a full NewsReportDoc and apply it to the connected studio, ' +
    'replacing whatever newscast is currently loaded. The doc is validated ' +
    'locally first; an invalid doc is rejected with the validation errors and ' +
    'never reaches the studio.',
  inputSchema: {
    doc: z
      .record(z.string(), z.unknown())
      .describe('The full NewsReportDoc (version 2): meta, rundown, optional look/defaults.'),
  },
  async handler({ doc }) {
    let validated;
    try {
      validated = validateNewsReportDoc(doc);
    } catch (err) {
      const msg = err instanceof ZodError ? formatZodError(err) : String(err);
      return {
        content: [{ type: 'text', text: `Invalid newscast document: ${msg}` }],
        isError: true,
      };
    }
    try {
      const result = (await callBridge('applyNewscast', { doc })) as { title?: string } | undefined;
      const title = result?.title ?? validated.meta.title;
      const sections = validated.rundown.length;
      return {
        content: [
          {
            type: 'text',
            text:
              `Applied newscast "${title}" ` +
              `(${sections} section${sections === 1 ? '' : 's'}, ` +
              `${validated.meta.anchors.length} anchor${validated.meta.anchors.length === 1 ? '' : 's'}).`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to apply newscast: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

const patchNewscast = defineTool({
  name: 'patch_newscast',
  title: 'Patch the held newscast document',
  description:
    'Merge a partial patch over the newscast currently held by the studio, ' +
    're-validate, and re-apply. Use this to nudge individual fields without ' +
    'resending the whole document.',
  inputSchema: {
    patch: z
      .record(z.string(), z.unknown())
      .describe('A partial NewsReportDoc patch, shallow-merged over the held doc by the studio.'),
  },
  async handler({ patch }) {
    try {
      const result = (await callBridge('patchNewscast', { patch })) as
        | { title?: string }
        | undefined;
      const title = result?.title;
      return {
        content: [
          {
            type: 'text',
            text: title ? `Patched newscast "${title}".` : 'Patched newscast.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to patch newscast: ${String(err)}` }],
        isError: true,
      };
    }
  },
});

const validateNewscast = defineTool({
  name: 'validate_newscast',
  title: 'Validate a newscast document',
  description:
    'Validate a NewsReportDoc locally against the protocol schema without ' +
    'touching the studio. Returns a short summary if it is valid, or the ' +
    'formatted validation errors if not.',
  inputSchema: {
    doc: z
      .record(z.string(), z.unknown())
      .describe('The NewsReportDoc to validate (version 2).'),
  },
  handler({ doc }) {
    try {
      const validated = validateNewsReportDoc(doc);
      const sections = validated.rundown.length;
      return {
        content: [
          {
            type: 'text',
            text:
              `OK: "${validated.meta.title}" is a valid newscast ` +
              `(${sections} section${sections === 1 ? '' : 's'}, ` +
              `${validated.meta.anchors.length} anchor${validated.meta.anchors.length === 1 ? '' : 's'}, ` +
              `${validated.meta.aspect} @ ${validated.meta.fps}fps).`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof ZodError ? formatZodError(err) : String(err);
      return {
        content: [{ type: 'text', text: `Invalid newscast document: ${msg}` }],
        isError: true,
      };
    }
  },
});

/** The document tool module — spread into `TOOL_MODULES` by the orchestrator. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const documentTools: ToolDef<any>[] = [setNewscast, patchNewscast, validateNewscast];
