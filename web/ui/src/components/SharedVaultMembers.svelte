<script lang="ts">
  import {onMount} from 'svelte';
  type Access = 'Can contribute' | 'Read only';
  type Member = {id:string;name:string;access:Access;owner?:boolean};
  type Invite = Member & {link:string;expires:string;pending?:boolean};
  let {vaultName,endpoint,request,filter=''}:{vaultName:string;endpoint:string;request:(action:string,body?:unknown)=>Promise<any>;filter?:string}=$props();
  const matches=(name:string)=>name.toLowerCase().includes(filter.trim().toLowerCase());
  let canManage=$state(false);
  let members=$state<Member[]>([]),invites=$state<Invite[]>([]),busy=$state(false),error=$state(''),loading=$state(true);
  let inviting=$state(false),name=$state(''),access=$state<Access>('Can contribute');
  // With Google sign-in on the server, an invitation is a pending member and the vault's one join link.
  let emailInvites=$state(false),joinUrl=$state('');
  let created=$state<Invite|null>(null),removing=$state<Member|null>(null),copied=$state('');
  function open(dialog:HTMLDialogElement){dialog.showModal();}
  function invitation(i:{id:string;display:string;permission:string;secret:string;expires:string}):Invite{return {id:i.id,name:i.display,access:i.permission==='write'?'Can contribute':'Read only',link:endpoint+'/invite#'+i.secret,expires:i.expires};}
  type Row={id:string;display:string;role:string;permissions:string[];pending?:boolean;email?:string|null};
  const accessOf=(m:Row):Access=>m.permissions.includes('write')?'Can contribute':'Read only';
  async function load(){const data=await request('members');canManage=data.can_manage;emailInvites=!!data.email_invites;joinUrl=data.join_url??'';const rows:Row[]=data.members,pending=emailInvites?rows.filter(m=>m.pending):[];members=rows.filter(m=>!pending.includes(m)).map(m=>({id:m.id,name:m.display,owner:m.role==='owner',access:accessOf(m)})).sort((a,b)=>Number(!!b.owner)-Number(!!a.owner));invites=[...data.invites.map(invitation),...pending.map(m=>({id:m.id,name:m.email??m.display,access:accessOf(m),link:joinUrl,expires:'',pending:true}))];loading=false;}
  async function act(fn:()=>Promise<void>){if(busy)return;busy=true;error='';try{await fn();}catch(e){error=(e as Error).message;}finally{busy=false;loading=false;}}
  async function create(event:SubmitEvent){event.preventDefault();await act(async()=>{const permission=access==='Can contribute'?'write':'read';if(emailInvites){const m=await request('member-add',{email:name.trim(),permission});created={id:m.id,name:m.email,access,link:joinUrl,expires:'',pending:true};}else created=invitation(await request('member-invite',{name:name.trim(),permission}));await load();});}
  async function copy(link:string){try{await navigator.clipboard.writeText(link);copied=link;}catch{error='Could not copy. Select and copy the invite link.';}}
  function start(){name='';access='Can contribute';created=null;copied='';error='';inviting=true;}
  onMount(()=>{void act(load);});
</script>

<section aria-label="Members">
  {#if error&&!inviting&&!removing}<p role="alert">{error} <button onclick={()=>act(load)}>Retry</button></p>{/if}
  <div class="heading"><h3>Members</h3>{#if canManage}<button class="primary" disabled={busy||loading} onclick={start}>Invite someone</button>{/if}</div>
  {#if loading}<p class="muted">Loading members…</p>{/if}
  {#each members.filter(m=>matches(m.name)) as member (member.id)}
    <div class="row"><div>{member.name}{#if member.owner}<small>Admin</small>{/if}</div>{#if member.owner}<span class="muted">Full access</span>{:else if !canManage}<span class="muted">{member.access}</span>{:else}<div class="actions">
      <select aria-label={`Access for ${member.name}`} value={member.access} disabled={busy} onchange={e=>{const permission=e.currentTarget.value==='Can contribute'?'write':'read';e.currentTarget.value=member.access;void act(async()=>{await request('member-access',{id:member.id,permission});await load();});}}><option>Can contribute</option><option>Read only</option></select>
      <button disabled={busy} onclick={()=>{error="";removing=member;}}>Remove</button>
    </div>{/if}</div>
  {/each}
  {#if canManage&&invites.length}
    <h3 class="pending-heading">Pending invitations</h3>
    {#each invites.filter(i=>matches(i.name)) as invite (invite.id)}
      <div class="row"><div>{invite.name}<small>{invite.access} · {invite.pending?'Not signed in yet':`Expires ${new Date(invite.expires).toLocaleString()}`}</small></div><div class="actions">
        <button onclick={()=>{created=invite;inviting=true;error="";void copy(invite.link);}}>{copied===invite.link?'Copied':'Copy link'}</button>
        <button disabled={busy} onclick={()=>act(async()=>{await request(invite.pending?'member-remove':'invite-cancel',{id:invite.id});await load();})}>Cancel invite</button>
      </div></div>
    {/each}
  {/if}
</section>

{#if canManage&&inviting}
  <dialog use:open onclose={()=>inviting=false} aria-labelledby="invite-title">
    {#if created}
      <h2 id="invite-title">Invite {created.name}</h2>
      {#if created.pending}
        <p class="muted">{created.access} · Pending until they sign in</p>
        <label>Join link<input readonly value={created.link} onclick={e=>e.currentTarget.select()}/></label>
        <p>Send them this link. They’ll sign in with Google as {created.name}.</p>
      {:else}
      <p class="muted">{created.access} · One use · Expires {new Date(created.expires).toLocaleString()}</p>
      <label>Invite link<input readonly value={created.link} onclick={e=>e.currentTarget.select()}/></label>
      <p>Send this link to {created.name}. They can paste it into “Connect a server” in BigBrain.</p>
      {/if}
      <div class="footer"><button onclick={()=>inviting=false}>Done</button><button class="primary" onclick={()=>copy(created!.link)}>{copied===created.link?'Copied':'Copy link'}</button></div>
    {:else}
      <form onsubmit={create}>
        <h2 id="invite-title">Invite someone to {vaultName}</h2>
        {#if emailInvites}<label>Email<input required type="email" bind:value={name} placeholder="Their email address" autocomplete="off"/></label>
        {:else}<label>Name<input required bind:value={name} placeholder="Their name" autocomplete="off"/></label>{/if}
        <label>Access<select bind:value={access}><option>Can contribute</option><option>Read only</option></select></label>
        <p class="muted">{access==='Can contribute'?'Can read and contribute sources and assertions.':'Can read everything on this server.'}</p>
        <div class="footer"><button type="button" onclick={()=>inviting=false}>Cancel</button><button class="primary" disabled={busy||!name.trim()}>{busy?'Creating…':'Create invite link'}</button></div>
      </form>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </dialog>
{/if}
{#if canManage&&removing}
  <dialog use:open onclose={()=>removing=null} aria-labelledby="remove-title">
    <h2 id="remove-title">Remove {removing.name}?</h2>
    <p>They’ll lose access to this server on all their devices. Their past contributions and attribution will stay.</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="footer"><button disabled={busy} onclick={()=>removing=null}>Cancel</button><button disabled={busy} class="primary" onclick={()=>act(async()=>{await request('member-remove',{id:removing!.id});removing=null;await load();})}>Remove member</button></div>
  </dialog>
{/if}

<style>
  section{font:var(--type-body);color:var(--text);}h3{font:var(--type-body);color:var(--text-strong);margin:0;}h2{font:var(--type-heading);color:var(--text-strong);margin:0;} .heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:4px 0 12px;}.row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px 0;border-bottom:1px solid var(--rule);}.actions{display:flex;align-items:center;gap:16px;}small{display:block;margin-top:6px;font:var(--type-meta);color:var(--text-muted);}.muted{color:var(--text-muted);font:var(--type-meta);}.pending-heading{margin:40px 0 0;}
  button,select,input{font:var(--type-meta);color:var(--text);background:var(--bg);border:1px solid var(--rule);border-radius:0;padding:10px 14px;box-sizing:border-box;}button,select{cursor:pointer;}button.primary{background:var(--text-strong);border-color:var(--text-strong);color:var(--bg);}button:disabled{opacity:.4;cursor:default;}button:hover:not(:disabled){border-color:var(--text);}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--text-muted);outline-offset:3px;}
  dialog{width:min(540px,calc(100vw - 40px));box-sizing:border-box;padding:32px;border:1px solid var(--rule);background:var(--bg);color:var(--text);font:var(--type-body);}dialog::backdrop{background:#0006;}form{display:grid;gap:24px;}label{display:grid;gap:10px;font:var(--type-meta);color:var(--text-muted);}label input,label select{width:100%;font:var(--type-body);padding:12px;}p{line-height:1.6;margin:20px 0;}form p{margin:0;}.footer{display:flex;justify-content:flex-end;gap:12px;margin-top:28px;}form .footer{margin-top:4px;}
  @media(max-width:700px){.row{align-items:flex-start;flex-direction:column;gap:14px;}.actions{flex-wrap:wrap;}.heading{align-items:flex-start;}.heading button{white-space:nowrap;}}
</style>
