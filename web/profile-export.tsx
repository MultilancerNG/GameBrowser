import { useState } from "react";
import type { ExportFormat, ExportProgress, UiProfile } from "./api.ts";

export interface ProfileExportRequest {
  selectedIds: string[];
  viewIds: string[];
  singleId?: string;
}

export function ProfileExportDialog({ request, profiles, cloud, progress, onExport, onClose }: {
  request: ProfileExportRequest;
  profiles: UiProfile[];
  cloud: boolean;
  progress: ExportProgress | null;
  onExport: (ids: string[], format: ExportFormat) => Promise<void>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(request.singleId ? "profile" : request.selectedIds.length ? "selected" : "view");
  const [format, setFormat] = useState<ExportFormat>("txt");
  const [error, setError] = useState<string | null>(null);
  const ids = scope === "profile" ? [request.singleId!] : scope === "selected" ? request.selectedIds : request.viewIds;
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const denied = cloud && ids.some((id) => byId.get(id)?.permission !== "edit");
  const exportFile = async () => {
    setError(null);
    try { await onExport(ids, format); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <div className="modal-backdrop">
    <section className="modal mode-confirm" role="dialog" aria-modal="true" aria-labelledby="profile-export-title">
      <div className="modal-head" id="profile-export-title">Export profiles</div>
      <div className="modal-body">
        <label className="fld"><span>Profiles to export</span>
          <select value={scope} disabled={!!progress} onChange={(event) => { setError(null); setScope(event.target.value); }}>
            {request.singleId && <option value="profile">This profile · {byId.get(request.singleId)?.name ?? request.singleId}</option>}
            <option value="selected" disabled={!request.selectedIds.length}>Selected profiles ({request.selectedIds.length})</option>
            <option value="view">Profiles in the current view ({request.viewIds.length})</option>
          </select>
        </label>
        <label className="fld"><span>Export format</span>
          <select value={format} disabled={!!progress} onChange={(event) => { setError(null); setFormat(event.target.value as ExportFormat); }}>
            <option value="txt">TXT · readable profile with cookies and identity settings</option>
            <option value="xlsx">Excel · supported profile fields and cookies</option>
            <option value="csv">CSV · account credentials</option>
          </select>
        </label>
        <p>{ids.length} profile(s): {ids.slice(0, 5).map((id) => byId.get(id)?.name ?? id).join(", ")}{ids.length > 5 ? `, and ${ids.length - 5} more` : ""}.</p>
        <p className="hint">Exports contain saved data, including any credentials and cookies present. They are readable files, not full browser-folder backups.</p>
        {denied && <p className="modal-err" role="alert">Edit access is required for every exported Cloud profile. Select profiles you can edit.</p>}
        {error && <p className="modal-err" role="alert">{error}</p>}
        {progress && <p role="status">Exporting {progress.completed} of {progress.total} profiles…</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn ghost" disabled={!!progress} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!!progress || !ids.length || denied} onClick={() => void exportFile()}>{progress ? "Exporting…" : `Export ${ids.length} profile${ids.length === 1 ? "" : "s"}`}</button>
      </div>
    </section>
  </div>;
}
