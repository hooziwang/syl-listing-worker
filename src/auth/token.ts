import jwt from "jsonwebtoken";

export interface AccessTokenPayload {
  tenant_id: string;
  scope: string;
}

export function signAccessToken(payload: AccessTokenPayload, secret: string, expiresInSeconds: number): string {
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
    issuer: "syl-listing-worker"
  });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  const decoded = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "syl-listing-worker"
  });

  if (typeof decoded !== "object" || decoded === null || typeof decoded.tenant_id !== "string") {
    throw new Error("token payload 非法");
  }

  return {
    tenant_id: decoded.tenant_id,
    scope: typeof decoded.scope === "string" ? decoded.scope : "generate"
  };
}
