/**
 * Validate a value against the subset of JSON Schema that this codebase's
 * tools actually declare. Covers what's needed today and what MCP-supplied
 * tools are likely to bring:
 *
 *   - `type: object` with `required: string[]` + `properties: {…}`
 *   - leaf types: `string`, `number`, `integer`, `boolean`, `array`
 *   - `enum: unknown[]` for closed-set value constraints
 *   - `items: schema` for array element types
 *
 * Returns `null` on success or a short, human-readable error string on
 * failure. The string is shaped to feed back to the model as a
 * `tool-call-result` body — i.e. it names the field, says what was
 * expected, and shows what was received. Bug report, not stack trace.
 *
 * Forgiving by design: a malformed or unsupported schema short-circuits
 * to `null` (no protection, no false positive). MCP-supplied tools may
 * declare schema shapes we don't recognise; we'd rather skip validation
 * than break their registration.
 */

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  enum?: readonly unknown[];
  items?: JsonSchema;
};

export function validateAgainstSchema(schema: unknown, value: unknown): string | null {
  if (!isPlainObject(schema)) return null;
  return walk('', schema as JsonSchema, value);
}

function walk(path: string, schema: JsonSchema, value: unknown): string | null {
  if (typeof schema.type === 'string') {
    const err = checkType(path, schema.type, value);
    if (err) return err;
  }

  const enumErr = checkEnum(path, schema, value);
  if (enumErr) return enumErr;

  if (schema.type === 'object' && isPlainObject(value)) {
    return walkObject(path, schema, value);
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    return walkArray(path, schema.items, value);
  }

  return null;
}

function checkEnum(path: string, schema: JsonSchema, value: unknown): string | null {
  if (!Array.isArray(schema.enum) || schema.enum.includes(value)) return null;
  const choices = schema.enum.map(e => JSON.stringify(e)).join(', ');
  return `${labelFor(path)} must be one of: ${choices} (got ${JSON.stringify(value)})`;
}

function walkObject(
  path: string,
  schema: JsonSchema,
  value: Record<string, unknown>,
): string | null {
  if (Array.isArray(schema.required)) {
    for (const r of schema.required) {
      if (!(r in value)) {
        return `missing required field "${r}"${path ? ` at ${path}` : ''}`;
      }
    }
  }
  if (schema.properties) {
    for (const [k, propSchema] of Object.entries(schema.properties)) {
      if (!(k in value)) continue;
      const childPath = path ? `${path}.${k}` : k;
      const err = walk(childPath, propSchema, value[k]);
      if (err) return err;
    }
  }
  return null;
}

function walkArray(path: string, items: JsonSchema, value: unknown[]): string | null {
  for (let i = 0; i < value.length; i++) {
    const err = walk(`${path}[${i}]`, items, value[i]);
    if (err) return err;
  }
  return null;
}

function checkType(path: string, type: string, value: unknown): string | null {
  const label = labelFor(path);
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return `${label} must be a string (got ${describe(value)})`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${label} must be a number (got ${describe(value)})`;
      }
      return null;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${label} must be an integer (got ${describe(value)})`;
      }
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return `${label} must be a boolean (got ${describe(value)})`;
      return null;
    case 'object':
      if (!isPlainObject(value)) return `${label} must be an object (got ${describe(value)})`;
      return null;
    case 'array':
      if (!Array.isArray(value)) return `${label} must be an array (got ${describe(value)})`;
      return null;
    default:
      // Unrecognised type keyword (e.g. "null", "any", a typo) — skip
      // rather than fail. Same forgiving stance as a malformed schema.
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelFor(path: string): string {
  return path || 'value';
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
