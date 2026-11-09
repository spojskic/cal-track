import { z } from 'zod';

/**
 * Zod -> JSON Schema conversion tuned for provider "strict" structured outputs.
 *
 * Providers (OpenAI, Anthropic, Gemini behind OpenRouter) accept different
 * JSON Schema subsets in strict mode. The common safe subset is:
 *   - every object has `additionalProperties: false`
 *   - every property is listed in `required` (optional => nullable)
 *   - no numeric / length constraints, no `default`, no `$schema`
 * Constraints that are dropped are appended to the node `description` so the
 * model still sees them; the reply is always re-validated with the original
 * zod schema anyway.
 */

type JsonSchema = Record<string, unknown>;

const CONSTRAINT_KEYS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
] as const;

const DROPPED_KEYS = ['$schema', 'default', 'examples', 'format', 'title'] as const;

function isRecord(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function constraintHint(node: JsonSchema): string {
  const parts: string[] = [];
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems } = node;
  if (typeof minimum === 'number') parts.push(`min ${minimum}`);
  if (typeof exclusiveMinimum === 'number') parts.push(`> ${exclusiveMinimum}`);
  if (typeof maximum === 'number') parts.push(`max ${maximum}`);
  if (typeof exclusiveMaximum === 'number') parts.push(`< ${exclusiveMaximum}`);
  if (typeof minLength === 'number') parts.push(`min length ${minLength}`);
  if (typeof maxLength === 'number') parts.push(`max length ${maxLength}`);
  if (typeof minItems === 'number') parts.push(`min items ${minItems}`);
  if (typeof maxItems === 'number') parts.push(`max items ${maxItems}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

function makeNullable(node: JsonSchema): JsonSchema {
  const t = node.type;
  const primitive = (x: unknown) => x === 'string' || x === 'number' || x === 'integer' || x === 'boolean';
  if (typeof t === 'string' && primitive(t)) {
    const out: JsonSchema = { ...node, type: [t, 'null'] };
    if (Array.isArray(node.enum)) out.enum = [...(node.enum as unknown[]), null];
    return out;
  }
  if (Array.isArray(t)) {
    return t.includes('null') ? node : { ...node, type: [...t, 'null'] };
  }
  return { anyOf: [node, { type: 'null' }] };
}

function strictify(node: unknown, nullableOptionals: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => strictify(n, nullableOptionals));
  if (!isRecord(node)) return node;

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if ((DROPPED_KEYS as readonly string[]).includes(k)) continue;
    if ((CONSTRAINT_KEYS as readonly string[]).includes(k)) continue;
    if (k === 'properties' && isRecord(v)) {
      const props: JsonSchema = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = strictify(pv, nullableOptionals);
      out.properties = props;
    } else if (k === 'required') {
      continue; // rebuilt below
    } else if (k === 'additionalProperties') {
      continue; // forced below for objects
    } else {
      out[k] = strictify(v, nullableOptionals);
    }
  }

  const hint = constraintHint(node);
  if (hint) {
    const existing = typeof out.description === 'string' ? `${out.description} ` : '';
    out.description = `${existing}${hint}`.trim();
  }

  if (isRecord(out.properties)) {
    const requiredOriginally = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const props = out.properties as JsonSchema;
    if (nullableOptionals) {
      for (const key of Object.keys(props)) {
        if (!requiredOriginally.has(key)) props[key] = makeNullable(props[key] as JsonSchema);
      }
      out.required = Object.keys(props);
    } else {
      out.required = Object.keys(props).filter((key) => requiredOriginally.has(key));
    }
    out.additionalProperties = false;
  } else if (out.type === 'object') {
    // Free-form object: leave as-is (strict providers may reject it; avoid in schemas).
    if (node.additionalProperties !== undefined) out.additionalProperties = strictify(node.additionalProperties, nullableOptionals);
  }
  return out;
}

export interface StrictSchemaOptions {
  /**
   * true (default): every property is `required` and optional ones become nullable. This is what
   * OpenAI-style strict mode demands. false: optional properties stay optional (use if a provider
   * rejects nullable types).
   */
  nullableOptionals?: boolean;
}

export function toStrictJsonSchema(schema: z.ZodType, opts: StrictSchemaOptions = {}): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return strictify(raw, opts.nullableOptionals ?? true) as JsonSchema;
}

/** Removes keys whose value is `null` (recursively). Used when a model returns null for optional fields. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (isRecord(value)) {
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

/** Strips ```json fences and surrounding prose, then JSON.parse. Throws SyntaxError on failure. */
export function parseJsonLoose(text: string): unknown {
  let s = text.trim();
  const fence = /^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence && fence[1] !== undefined) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (firstError) {
    // Fall back to the outermost {...} or [...] substring.
    const startObj = s.indexOf('{');
    const startArr = s.indexOf('[');
    const candidates: Array<[number, string]> = [];
    if (startObj !== -1) candidates.push([startObj, '}']);
    if (startArr !== -1) candidates.push([startArr, ']']);
    candidates.sort((a, b) => a[0] - b[0]);
    for (const [start, closer] of candidates) {
      const end = s.lastIndexOf(closer);
      if (end > start) {
        try {
          return JSON.parse(s.slice(start, end + 1));
        } catch {
          // try next candidate
        }
      }
    }
    throw firstError;
  }
}

/** Compact human-readable summary of zod issues, used in the repair prompt. */
export function summarizeIssues(error: z.ZodError, maxChars = 800): string {
  const lines = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join('.') : '(root)';
    return `- ${path}: ${issue.message}`;
  });
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
