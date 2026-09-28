// Dev-only positioning/controller study over the existing App DOM.
import './leftSidebar.css';
import { searchOverlay } from '../lib/omnibox.svelte';

export function installLeftSidebar() {
  const root = document.documentElement;
  root.dataset.leftSidebar = 'closed';
  const shell = document.createElement('aside');
  shell.className = 'study-sidebar-shell';
  shell.innerHTML = '<div class="study-sidebar-heading"><strong>BigBrain</strong><span>Left sidebar study · sample data</span><button aria-label="Collapse sidebar">←</button></div><p class="study-sidebar-empty">Search your vault.<br><span>Notes and Pilot open here.</span></p>';
  const rail = document.createElement('button');
  rail.className = 'study-sidebar-rail'; rail.setAttribute('aria-label', 'Open sidebar');
  rail.innerHTML = '→<span>/</span>';
  document.body.append(shell,rail);
  function setOpen(open:boolean, focus=false) {
    root.dataset.leftSidebar = open ? 'open' : 'closed';
    rail.setAttribute('aria-expanded',String(open));
    for (const el of document.querySelectorAll<HTMLElement>('#topbar,.drawer')) el.inert = !open;
    if (focus) requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('#topbar input')?.focus());
    if (!open && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  rail.onclick=()=>setOpen(true,true);
  shell.querySelector('button')!.onclick=()=>setOpen(false);
  window.addEventListener('keydown', e=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k') setOpen(true);
    if(e.key==='Escape' && root.dataset.leftSidebar==='open' && !searchOverlay.open){
      setOpen(false); e.preventDefault();e.stopImmediatePropagation();
    }
  },true);
  window.addEventListener('hashchange',()=>{if(location.hash !== '#/' && location.hash !== '') setOpen(true);});
  const observer=new MutationObserver(()=>{
    const closed=root.dataset.leftSidebar==='closed';
    for(const el of document.querySelectorAll<HTMLElement>('#topbar,.drawer')) if(el.inert!==closed)el.inert=closed;
  });
  observer.observe(document.body,{childList:true,subtree:true});
  // Start collapsed, without taking away the session or its draft.
  setOpen(false);
}
