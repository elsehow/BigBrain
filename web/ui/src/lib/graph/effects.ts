export const EFFECT_PRESETS = ['none', 'glow', 'shadows', 'trails', 'breathing', 'all'] as const;
export type EffectPreset = typeof EFFECT_PRESETS[number];
export function effectPreset(value: string | null): EffectPreset {
  return EFFECT_PRESETS.includes(value as EffectPreset) ? value as EffectPreset : 'none';
}
export function graphEffects(preset: EffectPreset) {
  return { breathing: preset === 'breathing' || preset === 'all', glow: preset === 'glow' || preset === 'all', shadows: preset === 'shadows' || preset === 'all', trails: preset === 'trails' || preset === 'all' };
}

// Small analytic footprints: no screen-sized blur, history texture or CPU
// per-node animation. Passes reuse the existing node attributes/state texture.
export const EFFECT_VERTEX = `
 if(u_pass>=5){
  float r=max(a_node.w==2.?6.:1.,a_node.z*u_nodeScale*600./(600.-sa.x));
  if(u_pass==8){
   float wave=u_reduced>0.?.5:.5+.5*sin(u_time*1.5707963+a_other.x*.7);
   float reach=clamp(r*4.,20.,38.)*(.92+.08*wave);p+=q*reach;v_local=q;
   v_alpha=a_node.w==2.&&a_other.y==4.?sa.y*.35*(.55+.45*wave):0.;
  }else if(u_pass==5){
   float lit=max(max(a_uv.z,a_other.x==u_hovered?1.:0.),mix(a_other.x==u_previous?1.:0.,a_other.x==u_selected?1.:0.,u_t));
   float reach=clamp(r*5.,18.,48.);p+=q*reach;v_local=q;
   v_alpha=sa.y*lit*.22;v_kind=a_node.w;
  }else if(u_pass==7){
   float z=max(0.,sa.x),radius=max(2.,a_node.z*u_nodeScale*1.4)+z*.16;
   p=project(position(a_other.x),0.)+vec2(z*.12,z*.05)+q*vec2(radius,radius*.55);
   v_local=q;v_alpha=sa.y*sa.y*.095*(1.-exp(-z/3.))/(1.+z/50.);
   if(a_node.w==1.||a_other.y==8.)v_alpha=0.;
  }else{
   int i=int(a_other.x);vec4 s=record(i),v=record(i+u_recordCount);
   float z=s.y+(s.x-s.y)*u_oldSpring.x+v.x*u_oldSpring.y;
   vec2 old=u_size*.5+(position(a_other.x)-u_oldCamera.xy)*u_oldCamera.z*600./(600.-z)-vec2(0,z*.6);
   vec2 delta=(old-p)*u_motionScale;
   float distance=length(delta);delta*=min(1.,3./max(distance,.001));
   v_status=vec3(delta,r);v_uv=vec2(min(1.,distance/2.),0.);
   v_alpha=sa.y*.6*exp(min(0.,sa.x)/35.)*a_uv.x;
   if(a_other.y==8.)v_alpha=0.;
   p+=q*(r+4.);v_local=q*(r+4.);
  }
  if(v_alpha<=0.||(u_pass==6&&v_uv.x<=0.)){gl_Position=vec4(2.,2.,0.,1.);return;}
 }else`;
export const EFFECT_FRAGMENT = `
 if(u_pass==5||u_pass==7||u_pass==8){
  float d=dot(v_local,v_local);
  float alpha=exp(-4.*d)*(1.-smoothstep(.65,1.,d))*v_alpha;
  vec3 ink=u_pass==7?u_ink:(v_kind==2.?u_accent:u_ink);
  color=vec4(ink*alpha,alpha);return;
 }
 if(u_pass==6){
  vec3 rgb=vec3(0.);float alpha=0.;
  for(int i=0;i<3;i++){
   // Opposing red/blue offsets expose both fringes outside the opaque node.
   float lag=float(i-1);vec2 p=(v_local-v_status.xy*lag)/v_status.z;
   float d=v_kind==1.?abs(p.x)+abs(p.y):v_kind==2.?max(.8660254*abs(p.x)+.5*p.y,-p.y)*2.:length(p);
   float a=(1.-smoothstep(1.-1./v_status.z,1.+1./v_status.z,d))*v_alpha*v_uv.x*.6;
   vec3 tint=i==0?vec3(.95,.12,.08):i==1?vec3(.10,.8,.45):vec3(.10,.4,1.);
   rgb=mix(u_ink,tint,.9)*a+rgb*(1.-a);alpha=a+alpha*(1.-a);
  }
  color=vec4(rgb,alpha);return;
 }
`;
