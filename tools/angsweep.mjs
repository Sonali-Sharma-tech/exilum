#!/usr/bin/env node
// Angular gradient-energy sweep on a window: find the dominant stripe axis.
// For each angle theta and step d, mean |L(p) - L(p + d*(cos,sin))|.
// MIN energy angle = along the joint (stripe runs this way); MAX = across it.
// anisotropy = max/min. A strong dominant axis => anisotropy >> 1.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(buf){if(buf.readUInt32BE(0)!==0x89504e47)throw new Error('not a PNG');let pos=8,W=0,H=0,bd=0,ct=0;const idat=[];while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);if(type==='IHDR'){W=data.readUInt32BE(0);H=data.readUInt32BE(4);bd=data[8];ct=data[9];}else if(type==='IDAT')idat.push(data);else if(type==='IEND')break;pos+=12+len;}const ch=ct===6?4:ct===2?3:1;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch;const rgb=new Uint8Array(W*H*3);const cur=new Uint8Array(stride),prev=new Uint8Array(stride);let rp=0;const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};for(let y=0;y<H;y++){const f=raw[rp++];for(let x=0;x<stride;x++){const rb=raw[rp++];const a=x>=ch?cur[x-ch]:0;const b=prev[x];const c=x>=ch?prev[x-ch]:0;let v;switch(f){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;case 4:v=rb+paeth(a,b,c);break;}cur[x]=v&0xff;}for(let x=0;x<W;x++){const o=(y*W+x)*3,s=x*ch;rgb[o]=cur[s];rgb[o+1]=ch===1?cur[s]:cur[s+1];rgb[o+2]=ch===1?cur[s]:cur[s+2];}prev.set(cur);}return{width:W,height:H,rgb};}
const srgbToLin=(c)=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
const lum=(r,g,b)=>0.2126*srgbToLin(r)+0.7152*srgbToLin(g)+0.0722*srgbToLin(b);
const file=process.argv[2];
let [x0,y0,x1,y1]=process.argv.slice(3).map(Number);
if(![x0,y0,x1,y1].every(Number.isFinite)){x0=900;y0=330;x1=1240;y1=500;}
const png=decodePNG(readFileSync(file));const{W,H}={W:png.width,H:png.height};const rgb=png.rgb;
const L=new Float64Array(W*H);for(let i=0;i<W*H;i++)L[i]=lum(rgb[i*3],rgb[i*3+1],rgb[i*3+2]);
function energyAt(deg,d){const t=deg*Math.PI/180;const dx=Math.round(Math.cos(t)*d),dy=Math.round(Math.sin(t)*d);if(dx===0&&dy===0)return null;let s=0,n=0;const xa=Math.max(0,-dx),xb=Math.min(W,W-dx),ya=Math.max(0,-dy),yb=Math.min(H,H-dy);const px0=Math.max(x0,xa),px1=Math.min(x1,xb),py0=Math.max(y0,ya),py1=Math.min(y1,yb);for(let y=py0;y<py1;y++)for(let x=px0;x<px1;x++){s+=Math.abs(L[y*W+x]-L[(y+dy)*W+(x+dx)]);n++;}return s/Math.max(n,1);}
const out={file,window:[x0,y0,x1,y1]};
for(const d of [4,8,12]){
  const rows=[];let min=1e9,max=-1,minA=0,maxA=0;
  for(let a=0;a<180;a+=15){const e=energyAt(a,d);rows.push([a,+e.toFixed(6)]);if(e<min){min=e;minA=a;}if(e>max){max=e;maxA=a;}}
  out['step'+d]={anisotropy:+(max/Math.max(min,1e-12)).toFixed(3),minEnergyAngle:minA,maxEnergyAngle:maxA,byAngle:rows};
}
console.log(JSON.stringify(out,null,2));
