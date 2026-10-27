"use client";
import type { UserProfile, AccountDataOverview } from "../modules/auth/index.ts";
import { AccountDataControls, AccountEmailChange, type AccountDataControlsApi, type AccountEmailChangeApi } from "../modules/auth/ui.ts";
import { api, ApiError, useApi } from "./client-api.ts";
import { Feedback, Loading } from "./site-shell.tsx";

const reauthenticate = () => window.location.assign("/login?returnTo=%2Fapp%2Faccount");
const emailApi: AccountEmailChangeApi = {
  requestEmailChange: body => api("/me/email-change-challenges", {method:"POST",body}),
  verifyEmailChange: body => api("/me/email-change-challenges/verify", {method:"POST",body}),
};
const dataApi: AccountDataControlsApi = {
  getOverview: () => api("/me/data-controls"),
  requestExport: () => api("/me/data-exports", {method:"POST",body:{}}),
  prepareExport: (id,expectedRevision) => api("/me/data-exports/prepare", {method:"POST",body:{id,expectedRevision}}),
  async downloadExport(id) {
    const response = await fetch(`/api/v1/me/data-exports/download?id=${encodeURIComponent(id)}`, {credentials:"same-origin",cache:"no-store"});
    if(!response.ok) { const result = await response.json(); throw new ApiError(result.error?.message ?? "导出文件暂不可下载，请刷新状态。", response.status, result.error?.code ?? "ACCOUNT_EXPORT_FAILED"); }
    return {filename:`my-hackathon-data-${id}.json`,json:await response.text()};
  },
  requestDeletion: () => api("/me/deletion-requests", {method:"POST",body:{confirmed:true}}),
  refreshDeletion: (id,expectedRevision) => api("/me/deletion-requests/refresh", {method:"POST",body:{id,expectedRevision}}),
  cancelDeletion: (id,expectedRevision) => api("/me/deletion-requests/cancel", {method:"POST",body:{id,expectedRevision}}),
};
export function AccountSelfService({profile}:{profile:UserProfile}) {
  const overview = useApi<AccountDataOverview>("/me/data-controls");
  return <><AccountEmailChange profile={profile} api={emailApi} onReauthenticate={reauthenticate} onChanged={() => { window.dispatchEvent(new Event("hackathon:unauthenticated")); reauthenticate(); }}/>
    <Feedback error={overview.error}/>{overview.loading && <Loading/>}{overview.data && !overview.error && <AccountDataControls initialState={overview.data} api={dataApi} onSessionExpired={reauthenticate} onReauthenticate={reauthenticate}/>}</>;
}
