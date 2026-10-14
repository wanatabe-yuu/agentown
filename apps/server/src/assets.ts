/**
 * What an uploaded art asset really is, decided from its bytes (never from the
 * client's name or content type). Models are binary glTF (.glb) that must be
 * self-contained: a viewer's browser loads them, so any external URI would make
 * it fetch whatever the uploader chose. Textures are PNG, JPEG or WebP; SVG is
 * refused (it is a document, not an image).
 */

export const MODEL_MAX = 20 * 1024 * 1024;
export const TEXTURE_MAX = 4 * 1024 * 1024;
export const ORG_QUOTA = 200 * 1024 * 1024;

/** glTF extensions three.js handles without extra decoders. */
const ALLOWED_EXTENSIONS = /^(KHR_materials_[a-z_]+|KHR_texture_transform|KHR_mesh_quantization|KHR_lights_punctual)$/;

export type AssetKind = "model" | "texture";
export interface Sniffed {
  kind: AssetKind;
  contentType: string;
}

export class AssetRejected extends Error {}

function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function checkGlb(b: Buffer): void {
  if (b.length < 20 || b.toString("ascii", 0, 4) !== "glTF") throw new AssetRejected("not a binary glTF (.glb) file");
  if (b.readUInt32LE(4) !== 2) throw new AssetRejected("only glTF 2.0 is supported");
  if (b.readUInt32LE(8) !== b.length) throw new AssetRejected("glTF header length does not match the file");
  const jsonLength = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > b.length) throw new AssetRejected("glTF has no JSON chunk");
  let gltf: { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }>; extensionsRequired?: string[] };
  try {
    gltf = JSON.parse(b.toString("utf8", 20, 20 + jsonLength));
  } catch {
    throw new AssetRejected("glTF JSON chunk is not valid JSON");
  }
  for (const x of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    if (x.uri !== undefined) throw new AssetRejected("the model refers to an external file or URL; export it as a self-contained .glb");
  }
  for (const ext of gltf.extensionsRequired ?? []) {
    if (!ALLOWED_EXTENSIONS.test(ext)) throw new AssetRejected(`the model requires glTF extension ${ext}, which is not supported (no Draco/meshopt; export without compression)`);
  }
}

export function sniffAsset(b: Buffer, declared: AssetKind): Sniffed {
  if (declared === "model") {
    if (b.length > MODEL_MAX) throw new AssetRejected("model too large (20 MiB max)");
    checkGlb(b);
    return { kind: "model", contentType: "model/gltf-binary" };
  }
  if (b.length > TEXTURE_MAX) throw new AssetRejected("texture too large (4 MiB max)");
  const type = sniffImage(b);
  if (!type) throw new AssetRejected("textures must be PNG, JPEG or WebP");
  return { kind: "texture", contentType: type };
}

/** A minimal valid .glb (one triangle), for tests and as a reference of the format. */
export function tinyGlb(extra: Record<string, unknown> = {}): Buffer {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
    ...extra,
  };
  let j = Buffer.from(JSON.stringify(json));
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, j, bh, bin]);
}
