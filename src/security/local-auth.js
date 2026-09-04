import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeDigestEqual(left, right) {
  const leftDigest = digest(left);
  const rightDigest = digest(right);
  return timingSafeEqual(leftDigest, rightDigest);
}

export class LocalAuthError extends Error {
  constructor(message, code, statusCode = 401) {
    super(message);
    this.name = "LocalAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

export class LocalSessionAuthenticator {
  #tokenDigest;
  #allowedOrigins;

  constructor({ token, allowedOrigins }) {
    if (typeof token !== "string" || token.length < 32) {
      throw new TypeError("Dashboard token must contain at least 32 characters.");
    }
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
      throw new TypeError("allowedOrigins must be a non-empty array.");
    }
    this.#tokenDigest = digest(token);
    this.#allowedOrigins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  }

  static issue({ allowedOrigins }) {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return Object.freeze({
      token,
      authenticator: new LocalSessionAuthenticator({ token, allowedOrigins }),
    });
  }

  verifyToken(token) {
    if (typeof token !== "string" || token === "") {
      throw new LocalAuthError("Dashboard authentication is required.", "DASHBOARD_AUTH_REQUIRED");
    }
    const candidate = digest(token);
    if (!timingSafeEqual(candidate, this.#tokenDigest)) {
      throw new LocalAuthError("Dashboard authentication failed.", "DASHBOARD_AUTH_INVALID");
    }
    return true;
  }

  verifyAuthorizationHeader(header) {
    if (typeof header !== "string") {
      throw new LocalAuthError("Bearer authentication is required.", "DASHBOARD_AUTH_REQUIRED");
    }
    const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(header.trim());
    if (!match) {
      throw new LocalAuthError("Authorization header is invalid.", "DASHBOARD_AUTH_INVALID");
    }
    return this.verifyToken(match[1]);
  }

  verifyOrigin(origin) {
    if (typeof origin !== "string" || origin.trim() === "") {
      throw new LocalAuthError("An Origin header is required.", "DASHBOARD_ORIGIN_REQUIRED", 403);
    }
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new LocalAuthError("Origin header is invalid.", "DASHBOARD_ORIGIN_INVALID", 403);
    }
    let accepted = false;
    for (const allowed of this.#allowedOrigins) {
      if (constantTimeDigestEqual(normalized, allowed)) {
        accepted = true;
        break;
      }
    }
    if (!accepted) {
      throw new LocalAuthError("Origin is not allowed.", "DASHBOARD_ORIGIN_REJECTED", 403);
    }
    return true;
  }

  verifyMutation({ authorization, origin }) {
    this.verifyOrigin(origin);
    this.verifyAuthorizationHeader(authorization);
    return true;
  }
}
