import {goto} from './store.svelte';
import {vaultFetch} from './vaultScope';
export const sharedSettings=$state({connections:[] as {id:string;name:string}[],selected:'',invite:false});
export async function reloadSharedConnections(){const r=await vaultFetch('/api/shared-settings');if(r.ok){sharedSettings.connections=(await r.json()).connections;if(!sharedSettings.selected)sharedSettings.selected=sharedSettings.connections[0]?.id??'';}}
export function selectSharedSettings(id:string){sharedSettings.selected=id;goto('sharedVaultSettings');}
export function openSharedInvite(){sharedSettings.invite=true;goto('sharedVaultSettings');}
/** Redeem an invite link; the credential stays with the local server. */
export async function connectSharedInvite(invite:string):Promise<{id:string;name:string}>{
 const r=await vaultFetch('/api/shared-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({invite:invite.trim()})});
 const result=await r.json();if(!r.ok)throw Error(result.error??'Could not connect.');return result;
}
