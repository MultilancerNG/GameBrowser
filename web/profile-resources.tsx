import { useEffect, useRef, useState } from "react";
import { fetchProfileResources, saveProfileResources, type ProfileResourcePolicy, type ProfileResourcesState } from "./api.ts";
import { useTranslation } from "./i18n.tsx";

interface ResourceDraft {
  automatic: boolean;
  budget: string;
  optimize: boolean;
  bookmarks: "preserve" | "always" | "default";
}

function draftFor(policy: ProfileResourcePolicy, recommendedMb: number): ResourceDraft {
  return { automatic: policy.ramBudgetMb === null, budget: String(policy.ramBudgetMb ?? recommendedMb), optimize: policy.autoOptimize,
    bookmarks: policy.alwaysShowBookmarks === undefined ? "preserve" : policy.alwaysShowBookmarks ? "always" : "default" };
}

/** The parent keys this panel by account/mode as well as profile ID. */
export function ProfileResourceSettings({ profileId, disabled = false }: { profileId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ id: string; data: ProfileResourcesState; draft: ResourceDraft } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoaded(null); setLoading(true); setSaving(false); setError(null); setSaved(false);
    void fetchProfileResources(profileId, controller.signal).then((data) => {
      if (!controller.signal.aborted) setLoaded({ id: profileId, data, draft: draftFor(data.policy, data.allocation.budgetMb) });
    }).catch((failure) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load browser settings");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [profileId, retry]);
  const current = loaded?.id === profileId ? loaded : null;
  const busy = disabled || loading || saving || !current;
  const update = (change: Partial<ResourceDraft>) => {
    setLoaded((previous) => previous?.id === profileId ? { ...previous, draft: { ...previous.draft, ...change } } : previous);
    setError(null); setSaved(false);
  };
  const save = async () => {
    const controller = request.current;
    if (busy || !current || !controller || controller.signal.aborted) return;
    const { draft } = current;
    const manual = Number(draft.budget);
    if (!draft.automatic && (!/^\d+$/.test(draft.budget) || !Number.isSafeInteger(manual) || manual < 128 || manual > 32768)) {
      setError(t("Enter a whole number from 128 to 32768 MB, or choose Auto.")); return;
    }
    const policy: ProfileResourcePolicy = {
      ramBudgetMb: draft.automatic ? null : manual, autoOptimize: draft.optimize,
      ...(draft.bookmarks === "preserve" ? {} : { alwaysShowBookmarks: draft.bookmarks === "always" }),
    };
    setSaving(true); setError(null); setSaved(false);
    try {
      const data = await saveProfileResources(profileId, policy, controller.signal);
      if (!controller.signal.aborted) { setLoaded({ id: profileId, data, draft: draftFor(data.policy, data.allocation.budgetMb) }); setSaved(true); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("Could not save browser settings"));
    } finally { if (!controller.signal.aborted) setSaving(false); }
  };
  return <details className="fingerprint-settings" open>
    <summary><span>{t("Browser settings")}</span><span className="automatic-badge">{t("This device")}</span></summary>
    <div className="proxy-settings">
      {loading || !current && !error ? <p className="formnote" role="status">{t("Loading browser settings…")}</p> : null}
      {current ? <>
        <div className="fld-row">
          <label className="fld grow"><span>{t("RAM budget, MB")}</span>
            <select aria-label={t("RAM budget, MB")} value={current.draft.automatic ? "auto" : "manual"} disabled={busy} onChange={(event) => update({ automatic: event.target.value === "auto" })}>
              <option value="auto">{t("Auto")}</option><option value="manual">{t("Manual")}</option>
            </select>
          </label>
          {!current.draft.automatic ? <label className="fld grow"><span>{t("Manual target, MB")}</span>
            <input type="number" min="128" max="32768" step="1" inputMode="numeric" value={current.draft.budget} disabled={busy} onChange={(event) => update({ budget: event.target.value })} />
          </label> : null}
        </div>
        <label className="extchk"><input type="checkbox" checked={current.draft.optimize} disabled={busy} onChange={(event) => update({ optimize: event.target.checked })} /><span>{t("Auto optimize this profile")}</span></label>
        <div className="hint">
          {t("Saved target estimate: {mb} MB.", { mb: current.data.allocation.budgetMb })} {t("Auto recalculates from available RAM and open profiles at each launch.")}
          <br />{t("This is a soft target for renderer heap and cache settings, not a cap on total browser RAM. Enable Auto optimize to apply it.")}
          <br />{t("Chromium adjusts the JavaScript heap; Firefox adjusts its memory cache. Optimization can change the heap limit visible to websites.")}
          {current.data.allocation.lowMemory ? <><br />{t("Available RAM is low. The target may exceed current free headroom.")}</> : null}
        </div>
        <label className="fld"><span>{t("Bookmarks bar")}</span>
          <select aria-label={t("Bookmarks bar")} value={current.draft.bookmarks} disabled={busy} onChange={(event) => update({ bookmarks: event.target.value as ResourceDraft["bookmarks"] })}>
            <option value="preserve">{t("Preserve current")}</option><option value="always">{t("Always show")}</option><option value="default">{t("Default browser behavior")}</option>
          </select>
          <small>{t("Preserve current keeps the saved choice, or existing browser behavior when no choice is saved.")}</small>
        </label>
        <p className="formnote">{t("Saved on this device. Applies on the next launch; running browsers stay unchanged. Cookies, logins, and saved fingerprint fields are preserved.")}</p>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => { void save(); }}>{saving ? t("Saving…") : t("Save browser settings")}</button>
      </> : null}
      {error ? <div className="modal-err" role="alert">{error}{!current ? <button type="button" className="btn ghost" disabled={disabled || loading} onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button> : null}</div> : null}
      {saved ? <div className="modal-ok" role="status">{t("Browser settings saved for the next launch.")}</div> : null}
    </div>
  </details>;
}
