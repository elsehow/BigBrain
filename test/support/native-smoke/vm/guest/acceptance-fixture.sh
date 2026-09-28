#!/bin/sh
set -eu
case "$(sysctl -n hw.model)" in VirtualMac*) ;; *) exit 90;; esac
A="$HOME/Documents/NativeVaultA"
B="$HOME/Documents/NativeVaultB"
APP="$HOME/Applications/BigBrain Consent Review.app"
ENGINE="$APP/Contents/Resources/resources/engine"
BUN="$APP/Contents/MacOS/bun"
OUT=/Volumes/BB_SMOKE_OUT/evidence
export ENGINE A B OUT
case "$1" in
provider)
 printf '\nBIGBRAIN_ANTHROPIC_CONNECTED=1\n' >> "$A/.env"
 echo 'Synthetic provider status only; no credentials or live model.' > "$OUT/provider-fixture.txt"
 ;;
seed)
 if pgrep -x bigbrain-desktop >/dev/null; then echo 'Quit app before seeding'; exit 91; fi
 test -d "$A/.git"
 test ! -e "$B"
 cp -R "$A" "$B"
 "$BUN" - <<'JS'
const {join}=await import('node:path');
const {writeFileSync,mkdirSync}=await import('node:fs');
const e=process.env.ENGINE;
const {newPilotChatSession}=await import(join(e,'lib/pilotChatTypes.ts'));
const {canonicalAction}=await import(join(e,'lib/applicationActions.ts'));
const {sha256hex}=await import(join(e,'lib/hash.ts'));
const {DEFAULT_PILOT_BACKEND}=await import(join(e,'lib/pilotBackendTypes.ts'));
const id='pilot-'+ 'a'.repeat(32), at=new Date().toISOString();
for(const name of ['A','B']){
 const root=process.env[name], s=newPilotChatSession([],id,at);
 Object.assign(s,{title:'Native '+name+' conversation',backend:DEFAULT_PILOT_BACKEND,phase:'working',draft:'Saved draft from vault '+name,messages:[{id:'same-message',role:'user',text:'Invented content belongs only to vault '+name,at}],turn:{id:'invented-interrupted-turn',status:'running'},revision:10,viewRevision:10});
 const write=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),JSON.stringify(value));};
 write('.spool/pilot-chats/'+id+'.json',s);
 const actor={kind:'pilot',id};
 for(const status of ['completed','executing']){
 const request='native-'+status, rid=sha256hex(canonicalAction([actor,request]));
 write('.spool/application-actions/'+rid+'.json',{version:1,id:rid,actor,request,operation:'source_set_unread',scope:[],fingerprint:sha256hex(canonicalAction(['source_set_unread',[],{}])),status,created:at,updated:at,...(status==='completed'?{result:{ok:true,results:[{path:'log/insertions/invented.json',ok:true,readState:{status:'synced',unread:false}}]}}:{})});
 }
}
console.log('Seeded same IDs with distinct A/B content, interrupted turns and uncertain actions. No effects dispatched.');
JS
 ;;
inspect)
 curl -s http://127.0.0.1:4747/api/vault > "$OUT/vault-$2.json"
 curl -s 'http://127.0.0.1:4747/api/pilot/chat/session?id=pilot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$OUT/session-$2.json"
 curl -s 'http://127.0.0.1:4747/api/pilot/chat/actions?id=pilot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$OUT/actions-$2.json"
 cat "$OUT/vault-$2.json"; cat "$OUT/session-$2.json"; cat "$OUT/actions-$2.json"
 ;;
esac
