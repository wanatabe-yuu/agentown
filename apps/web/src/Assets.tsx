import { useCallback, useEffect, useState } from "react";
import { t as tr } from "./i18n.ts";
import { api, orgPath } from "./api.ts";
import { Modal } from "./ui.tsx";

type Notify = (msg: string, kind?: "error" | "info") => void;
export interface AssetRow {
  id: string;
  kind: "model" | "texture";
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

export function useAssets() {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [usage, setUsage] = useState({ used: 0, quota: 1 });
  const reload = useCallback(
    () =>
      api<{ assets: AssetRow[]; used: number; quota: number }>("GET", "/api/assets").then((r) => {
        setAssets(r.assets);
        setUsage({ used: r.used, quota: r.quota });
      }),
    [],
  );
  useEffect(() => void reload().catch(() => {}), [reload]);
  return { assets, usage, reload };
}

/** Upload one file: .glb becomes a model, an image a texture (the server checks the bytes). */
export async function uploadAsset(file: File): Promise<AssetRow> {
  const kind = /\.glb$/i.test(file.name) ? "model" : "texture";
  const res = await fetch(orgPath(`/api/assets?kind=${kind}&name=${encodeURIComponent(file.name)}`), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `upload failed (${res.status})`);
  return body as AssetRow;
}

/** The organization's art: binary glTF models (.glb) and PNG/JPEG/WebP textures. */
export function AssetsDialog({ onClose, notify }: { onClose: () => void; notify: Notify }) {
  const { assets, usage, reload } = useAssets();
  const [busy, setBusy] = useState(false);
  const upload = async (files: FileList | null) => {
    setBusy(true);
    for (const f of Array.from(files ?? [])) {
      try {
        const a = await uploadAsset(f);
        notify(`${a.name} added`, "info");
      } catch (e) {
        notify(`${f.name}: ${(e as Error).message}`, "error");
      }
    }
    setBusy(false);
    await reload();
  };
  return (
    <Modal title={tr("Art assets")} onClose={onClose} wide>
      <p className="muted small">
        Models must be self-contained binary glTF (<code>.glb</code>, up to 20 MB, no Draco compression); textures PNG, JPEG or WebP (up to 4 MB). Use them in the world editor: a
        kind's look, or a room's floor and walls. {mb(usage.used)} of {mb(usage.quota)} used.
      </p>
      <label className="upload">
        <input type="file" multiple accept=".glb,image/png,image/jpeg,image/webp" disabled={busy} onChange={(e) => void upload(e.target.files).then(() => (e.target.value = ""))} />
        {busy ? "Uploading…" : "Upload models or textures"}
      </label>
      <table className="grid mobile-cards" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th />
            <th>Name</th>
            <th>Kind</th>
            <th>Size</th>
            <th>Id</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id}>
              <td>{a.kind === "texture" ? <img src={orgPath(`/api/assets/${a.id}`)} alt="" width={40} height={40} style={{ objectFit: "cover", borderRadius: 4 }} /> : "◆"}</td>
              <td data-label="Name">{a.name}</td>
              <td data-label="Kind" className="small">{a.kind}</td>
              <td data-label="Size" className="small">{mb(a.size)}</td>
              <td data-label="Id" className="mobile-wide">
                <code className="small">{a.id}</code>
              </td>
              <td>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    confirm(`Delete ${a.name}? Anything using it falls back to a plain shape.`) &&
                    void api("DELETE", `/api/assets/${a.id}`)
                      .then(reload)
                      .catch((e) => notify(e.message, "error"))
                  }
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {assets.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No art yet: everything is drawn from built-in shapes.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}
