import { createHash } from "node:crypto";

export class CanonicalJsonError extends TypeError {
  constructor(message, path = "$") {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
    this.code = "INVALID_CANONICAL_JSON_VALUE";
    this.path = path;
  }
}

function serialize(value, path, ancestors) {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("numbers must be finite", path);
      }
      return JSON.stringify(value);
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new CanonicalJsonError(`${typeof value} is not a JSON value`, path);
    default:
      break;
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError("cyclic values are not supported", path);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError("sparse arrays are not supported", `${path}[${index}]`);
        }
        values.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }
      const unexpectedKey = Object.keys(value).find((key) => {
        const index = Number(key);
        return !Number.isSafeInteger(index)
          || index < 0
          || index >= value.length
          || String(index) !== key;
      });
      if (unexpectedKey !== undefined) {
        throw new CanonicalJsonError(
          `arrays must not contain named property ${JSON.stringify(unexpectedKey)}`,
          path,
        );
      }
      return `[${values.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError("only plain objects are supported", path);
    }

    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) {
      throw new CanonicalJsonError("symbol keys are not supported", path);
    }

    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.get || descriptor?.set) {
          throw new CanonicalJsonError("accessor properties are not supported", `${path}.${key}`);
        }
        return `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`, ancestors)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return serialize(value, "$", new Set());
}

export function sha256Text(value) {
  if (typeof value !== "string") {
    throw new TypeError("sha256Text value must be a string");
  }
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:${hex}`;
}

export function sha256CanonicalJson(value) {
  return sha256Text(canonicalJson(value));
}
