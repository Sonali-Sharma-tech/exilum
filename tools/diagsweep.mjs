#!/usr/bin/env node
// Multi-scale diagonal/anti-diagonal gradient ratio sweep on a fixed window.
// A periodic stripe is directional at the scale of its PERIOD, not at 1px where
// isotropic intra-slab texture dominates. Sweep step sizes to find where the
// anisotropy lives. ratio<1 => anti-diagonal biased (our reported defect).
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(buf){if(buf.readUInt32BE(0)!==0x89504e47)throw new Error('not a PNG');let pos=8,W=0,H=0,bd=0,ct=0;const idat=[];while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);if(type==='IHDR'){W=data.readUInt32BE(0);H=data.readUInt32BE(4);bd=data[8];ct=data[9];}else if(type==='IDAT')idat.push(data);else if(type==='IEND')break;pos+=12+len;}if(bd!==8)throw new Error('8-bit only');const ch=ct===6?4:ct===2?3:ct===0?1:0;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch;const rgb=new Uint8Array(W*H*3);const cur=new Uint8Array(stride),prev=new Uint8Array(stride);let rp=0;const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};for(let y=0;y<H;y++){const f=raw[rp++];for(let x=0;x<stride;x++){const rb=raw[rp++];const a=x>=ch?cur[x-ch]:0;const b=prev[x];const c=x>=ch?prev[x-ch]:0;let v;switch(f){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;case 4:v=rb+paeth(a,b,c);break;default:throw new Error('bad filter');}cur[x]=v&0xff;}for(let x=0;x<W;x++){const o=(y*W+x)*3,s=x*ch;if(ch===1){rgb[o]=rgb[o+1]=rgb[o+2]=cur[s];}else{rgb[o]=cur[s];rgb[o+1]=cur[s+1];rgb[o+2]=cur[s+2];}}prev.set(cur);}return{width:W,height:H,rgb};}
const srgbToLin=(c)=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
const lum=(r,g,b)=>0.2126*srgbToLin(r)+0.7152*srgbToLin(g)+0.0722*srgbToLin(b);
const file=process.argv[2];
let [x0,y0,x1,y1]=process.argv.slice(3).map(Number);
if(![x0,y0,x1,y1].every(Number.isFinite)){x0=900;y0=330;x1=1240;y1=500;}
const png=decodePNG(readFileSync(file));const{width:W,height:H,rgb}=png;
const L=new Float64Array(W*H);for(let i=0;i<W*H;i++)L[i]=lum(rgb[i*3],rgb[i*3+1],rgb[i*3+2]);
const out={file,window:[x0,y0,x1,y1]};
for(const s of [1,2,3,4,6,8,12,16]){
  let diag=0,anti=0,n=0;
  const yy0=Math.max(s,y0),yy1=Math.min(H-1-s,y1),xx0=Math.max(s,x0),xx1=Math.min(W-1-s,x1);
  for(let y=yy0;y<yy1;y++)for(let x=xx0;x<xx1;x++){
    diag+=Math.abs(L[y*W+x]-L[(y+s)*W+(x+s)]);
    anti+=Math.abs(L[y*W+x]-L[(y-s)*W+(x+s)]);
    n++;
  }
  out['step'+s]={ratio:+(diag/Math.max(anti,1e-12)).toFixed(4),diagAbs:+(diag/n).toFixed(6),antiAbs:+(anti/n).toFixed(6)};
}
console.log(JSON.stringify(out,null,2));
