#!/usr/bin/env bun
import { flagValue } from '../lib/cliflags';
import { issueSharedInvite, sharedVaultIdentity } from '../lib/sharedInvites';
import { writeAtomic } from '../lib/fsx';
const args=process.argv.slice(2),store=flagValue(args,'members'),handle=flagValue(args,'member'),endpoint=flagValue(args,'endpoint'),root=flagValue(args,'vault'),out=flagValue(args,'out');
if(!store||!handle||!endpoint||!root||!out)throw Error('Use --members --member --endpoint --vault --out (private invite file)');
sharedVaultIdentity(root);
writeAtomic(out,issueSharedInvite(store,handle,endpoint)+'\n',0o600);
console.log('Invitation saved to private file (expires in 24 hours).');
