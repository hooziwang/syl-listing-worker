import type { AccessTokenPayload } from "./token.js";
import { signAccessToken, verifyAccessToken } from "./token.js";

export class AuthService {
  constructor(
    private readonly keyTenantMap: Map<string, string>,
    private readonly jwtSecret: string,
    private readonly jwtExpiresSeconds: number
  ) {}

  exchangeBySylKey(sylKey: string): { access_token: string; expires_in: number; tenant_id: string } {
    const tenantId = this.keyTenantMap.get(sylKey);
    if (!tenantId) {
      throw new Error("invalid_syl_key");
    }

    const payload: AccessTokenPayload = {
      tenant_id: tenantId,
      scope: "generate"
    };

    return {
      access_token: signAccessToken(payload, this.jwtSecret, this.jwtExpiresSeconds),
      expires_in: this.jwtExpiresSeconds,
      tenant_id: tenantId
    };
  }

  verifyBearerToken(token: string): AccessTokenPayload {
    return verifyAccessToken(token, this.jwtSecret);
  }
}
