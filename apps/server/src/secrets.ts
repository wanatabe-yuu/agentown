import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Envelope for provider API keys at rest (AES-256-GCM). The master key comes
 * from AGENTOWN_SECRET_KEY (base64, 32 bytes) or, in development, a generated
 * 0600 file. Plaintext keys only leave the server towards the runtime of the
 * agent that uses them (Kubernetes Secret / container env), never via the API.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("secret key must be 32 bytes");
  }

  static fromEnvOrFile(envValue: string | undefined, devFile: string): SecretBox {
    if (envValue) return new SecretBox(Buffer.from(envValue, "base64"));
    if (!existsSync(devFile)) {
      mkdirSync(dirname(devFile), { recursive: true });
      writeFileSync(devFile, randomBytes(32).toString("base64"), { mode: 0o600 });
    }
    return new SecretBox(Buffer.from(readFileSync(devFile, "utf8").trim(), "base64"));
  }

  static forTests(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  seal(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
  }

  open(sealed: Buffer): string {
    if (sealed[0] !== 1) throw new Error("unknown secret envelope version");
    const iv = sealed.subarray(1, 13);
    const tag = sealed.subarray(13, 29);
    const d = createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(sealed.subarray(29)), d.final()]).toString("utf8");
  }
}
