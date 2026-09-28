import { SELECTOR_RATIO } from '../../../../../lib/pilotChatTypes';
import { EFFECT_VERTEX, EFFECT_FRAGMENT } from './effects';

export const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 a_node;
layout(location=1) in vec4 a_other;
layout(location=2) in vec4 a_uv;
uniform sampler2D u_state;
uniform int u_stateWidth;
uniform int u_recordCount;
uniform vec2 u_spring;
uniform vec2 u_depthSpring;
uniform int u_nodeCount;
uniform float u_time;
uniform float u_reduced;
uniform vec2 u_size;
uniform vec3 u_camera;
uniform vec3 u_oldCamera;
uniform vec2 u_oldSpring;
uniform float u_motionScale;
uniform float u_t;
uniform float u_selected;
uniform float u_previous;
uniform float u_hovered;
uniform int u_pass;
uniform float u_nodeScale;
out vec2 v_local;
out vec2 v_uv;
out float v_alpha;
out float v_kind;
out float v_ring;
out float v_hollow;
out vec3 v_status;
vec2 corner(){return vec2(gl_VertexID==1||gl_VertexID==3?1.:-1.,gl_VertexID>=2?1.:-1.);}
vec4 record(int i){return texelFetch(u_state,ivec2(i%u_stateWidth,i/u_stateWidth),0);}
vec2 state(float id){int i=int(id);vec4 s=record(i),v=record(i+u_recordCount);vec2 p=s.yw+(s.xz-s.yw)*u_spring.x+v.xy*u_spring.y;if(i<u_nodeCount)p.x=s.y+(s.x-s.y)*u_depthSpring.x+v.x*u_depthSpring.y;return vec2(p.x,clamp(p.y,0.,1.));}
vec2 position(float id){return record(int(id)+u_recordCount).zw;}
vec2 project(vec2 p,float z){float m=600./(600.-z);return u_size*.5+(p-u_camera.xy)*u_camera.z*m-vec2(0,z*.6);}
// Signed radius: negative is an agent; 100+radius is a memory diamond;
// -200-radius is a square agent; -300-radius its working spinner.
// -100-radius reserves the working agent's spinner ring.
float boundary(float code,vec2 dir,float depth,float id){
 float r=max(code<0.?6.:3.,mod(abs(code),100.)*u_nodeScale*600./(600.-depth));
 bool selected=id==u_selected||id==u_hovered||(code< -100.&&code> -200.)||code< -300.;
 if(code< -200.)return r*(selected?${SELECTOR_RATIO}:.65)/max(max(abs(dir.x),abs(dir.y)),.001);
 if(code<0.&&!selected)return r*.5/max(max(.8660254*abs(dir.x)+.5*dir.y,-dir.y),.001);
 return r*(selected?${SELECTOR_RATIO}:1.)/(code>100.?max(abs(dir.x)+abs(dir.y),.001):1.);
}
void main(){
 vec2 q=corner();
 if(u_pass==3){v_alpha=clamp(state(float(u_recordCount-1)).x,0.,1.);v_uv=(q+1.)*.5;gl_Position=vec4(q,0,1);return;}
 vec2 sa=state(a_other.x);vec2 p=project(position(a_other.x),sa.x);
 v_status=vec3(0);v_hollow=1.;v_kind=a_node.w;v_ring=a_other.x==u_selected?1.:0.;v_alpha=sa.y;v_uv=vec2(0);v_local=q;
 ${EFFECT_VERTEX} if(u_pass==0){
  vec2 sb=state(a_other.w),end=project(position(a_other.w),sb.x);
  vec2 delta=end-p,normal=vec2(-delta.y,delta.x)/max(length(delta),.001);
  p=mix(p,end,(q.x+1.)*.5)+normal*q.y*(a_node.z*.5+1.);
  vec2 edge=state(a_uv.z);
  v_alpha=pow(min(sa.y,sb.y),1.25)*clamp(edge.x,0.,1.)*(1.-edge.y)*a_uv.y;
  v_kind=a_node.z;v_local.y=q.y*(a_node.z*.5+1.);
 }else if(u_pass==4){
  vec2 sb=state(a_other.w),end=project(position(a_other.w),sb.x),delta=end-p;
  float len=max(length(delta),.001);vec2 dir=delta/len;
  bool engaged=a_node.w==u_selected||a_node.w==u_hovered;
  v_kind=a_node.z;v_status=vec3(a_uv.w,0,0);
  v_alpha=state(a_uv.z).y*step(.001,min(sa.y,sb.y));
  float ar=boundary(a_uv.x,dir,sa.x,a_other.x),br=boundary(a_uv.y,-dir,sb.x,a_other.w);
  float span=max(0.,len-ar-br);p+=dir*(ar+(q.x+1.)*.5*span)+vec2(-dir.y,dir.x)*q.y*1.6;
  v_local=vec2((q.x+1.)*.5*span,q.y*1.6);v_alpha*=engaged?.85:.18;
  if(span<=0.)v_alpha=0.;
 }else if(u_pass==1){
  v_ring=max(v_ring,a_uv.z);v_hollow=1.-v_ring;
  float r=max(a_node.w>=2.?6.:a_other.y==8.?3.:a_other.y>8.?4.:1.,a_node.z*u_nodeScale*600./(600.-sa.x));
  float attention=a_other.z>0.?(a_node.w>=2.?r*2.1:max(7.,r+5.)):0.;
  float extent=max(r+(a_other.y>8.?12.:8.),attention+2.);p+=q*extent;v_local=q*extent/r;
  v_status=vec3(a_other.y,attention/r,r);
  float emphasis=mix(a_node.x,a_other.w,u_t);
  float ink=mix(a_uv.y,a_uv.w,u_t)*a_uv.x*exp(min(0.,sa.x-a_node.y)/95.);
  v_alpha*=mix(ink,1.,emphasis);
  if(a_other.x==u_hovered){v_alpha=1.;v_ring=1.;}v_hollow=1.-v_ring;
 }else{
  p+=vec2(a_other.y,a_other.z)+q*vec2(a_node.z*.5,10.);
  v_local=q*vec2(a_node.z*.5,10.);v_status=vec3(a_node.z*.5,10.,a_node.y);
  v_uv=mix(a_uv.xy,a_uv.zw,(q+1.)*.5);v_alpha=a_other.w;
 }
 if(v_alpha<=0.){gl_Position=vec4(2,2,0,1);return;}
 gl_Position=vec4(p/u_size*vec2(2,-2)+vec2(-1,1),0,1);
}`;
export const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform int u_pass;
uniform vec3 u_ink;
uniform vec3 u_accent;
uniform vec3 u_bg;
uniform float u_time;
uniform float u_reduced;
uniform sampler2D u_labels;
uniform sampler2D u_edges;
uniform float u_edgeOpacity;
uniform vec3 u_edgeInk;
in vec2 v_local;in vec2 v_uv;in float v_alpha;in float v_kind;in float v_ring;in float v_hollow;
in vec3 v_status;
out vec4 color;
float line(vec2 p,vec2 a,vec2 b){vec2 d=b-a;return length(p-a-d*clamp(dot(p-a,d)/dot(d,d),0.,1.));}
float stroke(float d,float halfWidth){return 1.-smoothstep(halfWidth-.5,halfWidth+.5,d);}
void main(){
 if(u_pass==3){color=texture(u_edges,v_uv)*u_edgeOpacity*v_alpha;return;}
 if(u_pass==4){
  float offset=u_reduced>0.?0.:mod(u_time,.85)/.85*28.*v_status.x;
  float dash=mod(v_local.x-offset,14.);
  float aa=max(fwidth(v_local.x),.25);
  float mask=smoothstep(0.,aa,dash)*(1.-smoothstep(7.-aa,7.,dash));
  float alpha=stroke(abs(v_local.y),.6)*mask;
  alpha*=v_alpha;color=vec4(u_accent*alpha,alpha);return;
 }
 ${EFFECT_FRAGMENT}
 float alpha=0.;vec3 ink=u_ink;
 if(u_pass==0){float aa=max(fwidth(v_local.y),.25);alpha=(1.-smoothstep(v_kind*.5-aa*.5,v_kind*.5+aa*.5,abs(v_local.y)))*v_alpha;ink=u_edgeInk;}
 else if(u_pass==2){
  float text=texture(u_labels,v_uv).a;
  vec2 box=abs(v_local)-v_status.xy+vec2(4.);
  float distance=length(max(box,0.))+min(max(box.x,box.y),0.)-4.;
  float plate=(1.-smoothstep(-.5,.5,distance))*v_status.z*(1.-text);
  alpha=(text+plate)*v_alpha;
  color=vec4(((v_kind==2.?u_accent:u_ink)*text+u_bg*plate)*v_alpha,alpha);return;
 }
 else{
  float d=v_kind==1.?abs(v_local.x)+abs(v_local.y):v_kind==3.?max(abs(v_local.x),abs(v_local.y)):v_kind==2.?max(abs(v_local.x)*.866+v_local.y*.5,-v_local.y):length(v_local);
  float aa=max(fwidth(d),.03);alpha=(1.-smoothstep(1.-aa,1.+aa,d))*v_alpha;
  if(v_kind==1.)alpha*=mix(1.,smoothstep(.6-aa,.6+aa,d),v_hollow);
  if(v_kind>=2.)ink=u_accent;
  float ring=(1.-smoothstep(1.55-aa,1.55+aa,d))*smoothstep(1.35-aa,1.35+aa,d);
  alpha=max(alpha,ring*v_ring);
 }
 color=vec4(ink*alpha,alpha);
 if(u_pass!=1)return;
 float r=v_status.z;
 vec2 p=v_local*r;
 if(v_kind>=2.){
  // Same downward triangle, hollow phases and marks as drawPilotIndicator.
  float phase=v_status.x;
  ink=phase==1.?u_ink:u_accent;
  float d=(v_kind==3.?max(abs(v_local.x),abs(v_local.y))-.65:max(abs(v_local.x)*.8660254+v_local.y*.5,-v_local.y)-.5)*r;
  float fill=1.-smoothstep(-.5,.5,d),outline=stroke(abs(d),.625);
  bool hollow=(phase>=3.&&phase<=6.)||phase==11.;
  vec3 face=hollow?u_bg:ink;
  color=vec4(mix(face,ink,outline),1.)*max(fill,outline)*v_alpha;
  float ring=stroke(abs(length(p)-r*${SELECTOR_RATIO}),.625);
  float mark=ring*v_ring*.6;
  if(phase==4.){
   float angle=mod(atan(p.y,p.x)-(u_reduced>0.?0.:u_time*6.2831853)+6.2831853,6.2831853);
   mark=max(mark,ring*(1.-step(1.6336282,angle)));
  }
  vec2 m=p*9./r;
  // PILOT_MARK_SEGMENTS in pilotAppearance.ts; GLSL cannot import them.
  if(phase==3.&&(u_reduced>0.||mod(u_time,1.)<.5))mark=max(mark,stroke(line(m,vec2(0,-3),vec2(0,4.5))*r/9.,.625));
  if(phase==5.)mark=max(mark,stroke(line(m,vec2(-3.6,-1),vec2(3.6,-1))*r/9.,.625));
  if(phase==6.)mark=max(mark,stroke(min(line(m,vec2(-2.6,-3.5),vec2(2.6,1.6)),line(m,vec2(2.6,-3.5),vec2(-2.6,1.6)))*r/9.,.625));
  mark*=v_alpha;color=vec4(ink*mark,mark)+color*(1.-mark);
 }
 if(v_status.x>=8.&&v_status.x<=10.){
  float phase=v_status.x;
  float angle=mod(atan(p.y,p.x)-(u_reduced>0.?0.:u_time*6.2831853/(phase==10.?2.42:1.1))+6.2831853,6.2831853);
  float mark;
  if(phase==8.){
   color*=.35;
   mark=stroke(abs(length(p)-r-4.),.75)*(1.-step(4.712389,angle));
  }else{
   mark=stroke(abs(length(p)-r-7.),.875)*(1.-step(5.340708,angle))*(phase==10.?.55:.9);
   mark=max(mark,stroke(abs(length(p)-r-10.),.875)*(1.-step(4.869469,mod(angle+3.141593,6.2831853)))*(phase==10.?.25:.45));
  }
  mark*=v_alpha;color=vec4(u_ink*mark,mark)+color*(1.-mark);
 }
 if(v_status.y>0.){
  float a=v_status.y*r;vec2 q=abs(p);
  float brackets=stroke(min(line(q,vec2(a*.5,a),vec2(a,a)),line(q,vec2(a,a),vec2(a,a*.5))),.6);
  float breath=u_reduced>0.?.8:.6-.3*cos(u_time*6.2831853/3.6);
  float opacity=brackets*breath;
  color=vec4(u_accent*opacity,opacity)+color*(1.-opacity);
 }
}`;

