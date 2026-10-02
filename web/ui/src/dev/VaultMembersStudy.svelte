<script lang="ts">
  type Access = 'Can contribute' | 'Read only';
  type Member = { id: number; name: string; access: Access };
  type Invite = Member & { link: string };
  let members = $state<Member[]>([{id:1,name:'Mara Chen',access:'Can contribute'},{id:2,name:'Jules Rivera',access:'Read only'}]);
  let invites = $state<Invite[]>([]);
  let inviting = $state(false), name = $state(''), access = $state<Access>('Can contribute');
  let created = $state<Invite|null>(null), removing = $state<Member|null>(null), copied = $state(false);
  let nextId = 3;
  function open(dialog: HTMLDialogElement) { dialog.showModal(); }
  function create(event: SubmitEvent) {
    event.preventDefault();
    const id = nextId++;
    created = {id,name:name.trim(),access,link:`https://vault.bigbrain.example/invite#sample-${id}`};
    invites = [...invites,created];
  }
  async function copy(link: string) { try { await navigator.clipboard.writeText(link); copied=true; } catch { copied=false; } }
  function start() { name='';access='Can contribute';created=null;copied=false;inviting=true; }
</script>

<section aria-label="Members">
  <div class="heading"><h3>Members</h3><button class="primary" onclick={start}>Invite someone</button></div>
  <div class="row"><div>You <small>Owner</small></div><span class="muted">Full access</span></div>
  {#each members as member (member.id)}
    <div class="row"><div>{member.name}</div><div class="actions">
      <select aria-label={`Access for ${member.name}`} bind:value={member.access}><option>Can contribute</option><option>Read only</option></select>
      <button onclick={()=>removing=member}>Remove</button>
    </div></div>
  {/each}
  {#if invites.length}
    <h3 class="pending-heading">Pending invitations</h3>
    {#each invites as invite (invite.id)}
      <div class="row"><div>{invite.name}<small>{invite.access} · Expires in 24 hours</small></div><div class="actions">
        <button onclick={()=>copy(invite.link)}>Copy link</button>
        <button onclick={()=>invites=invites.filter(i=>i.id!==invite.id)}>Cancel invite</button>
      </div></div>
    {/each}
  {/if}
</section>

{#if inviting}
  <dialog use:open onclose={()=>inviting=false} aria-labelledby="invite-title">
    {#if created}
      <h2 id="invite-title">Invite {created.name}</h2>
      <p class="muted">{created.access} · One use · Expires in 24 hours</p>
      <label>Invite link<input readonly value={created.link} onclick={e=>e.currentTarget.select()}/></label>
      <p>Send this link to {created.name}. They can paste it into “Connect a shared vault” in BigBrain.</p>
      <div class="footer"><button onclick={()=>inviting=false}>Done</button><button class="primary" onclick={()=>copy(created!.link)}>{copied?'Copied':'Copy link'}</button></div>
    {:else}
      <form onsubmit={create}>
        <h2 id="invite-title">Invite someone to BigBrain</h2>
        <label>Name<input required bind:value={name} placeholder="Their name" autocomplete="off"/></label>
        <label>Access<select bind:value={access}><option>Can contribute</option><option>Read only</option></select></label>
        <p class="muted">{access==='Can contribute'?'Can read and contribute sources and assertions.':'Can read everything in this vault.'}</p>
        <div class="footer"><button type="button" onclick={()=>inviting=false}>Cancel</button><button class="primary" disabled={!name.trim()}>Create invite link</button></div>
      </form>
    {/if}
  </dialog>
{/if}
{#if removing}
  <dialog use:open onclose={()=>removing=null} aria-labelledby="remove-title">
    <h2 id="remove-title">Remove {removing.name}?</h2>
    <p>They’ll lose access to this vault on all their devices. Their past contributions and attribution will stay.</p>
    <div class="footer"><button onclick={()=>removing=null}>Cancel</button><button class="primary" onclick={()=>{members=members.filter(m=>m.id!==removing?.id);removing=null;}}>Remove member</button></div>
  </dialog>
{/if}

<style>
  section{font:var(--type-body);color:var(--text);}h3{font:var(--type-body);color:var(--text-strong);margin:0;}h2{font:var(--type-heading);color:var(--text-strong);margin:0;} .heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:4px 0 12px;}.row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px 0;border-bottom:1px solid var(--rule);}.actions{display:flex;align-items:center;gap:16px;}small{display:block;margin-top:6px;font:var(--type-meta);color:var(--text-muted);}.muted{color:var(--text-muted);font:var(--type-meta);}.pending-heading{margin:40px 0 0;}
  button,select,input{font:var(--type-meta);color:var(--text);background:var(--bg);border:1px solid var(--rule);border-radius:0;padding:10px 14px;box-sizing:border-box;}button,select{cursor:pointer;}button.primary{background:var(--text-strong);border-color:var(--text-strong);color:var(--bg);}button:disabled{opacity:.4;cursor:default;}button:hover:not(:disabled){border-color:var(--text);}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--text-muted);outline-offset:3px;}
  dialog{width:min(540px,calc(100vw - 40px));box-sizing:border-box;padding:32px;border:1px solid var(--rule);background:var(--bg);color:var(--text);font:var(--type-body);}dialog::backdrop{background:#0006;}form{display:grid;gap:24px;}label{display:grid;gap:10px;font:var(--type-meta);color:var(--text-muted);}label input,label select{width:100%;font:var(--type-body);padding:12px;}p{line-height:1.6;margin:20px 0;}form p{margin:0;}.footer{display:flex;justify-content:flex-end;gap:12px;margin-top:28px;}form .footer{margin-top:4px;}
  @media(max-width:700px){.row{align-items:flex-start;flex-direction:column;gap:14px;}.actions{flex-wrap:wrap;}.heading{align-items:flex-start;}.heading button{white-space:nowrap;}}
</style>
