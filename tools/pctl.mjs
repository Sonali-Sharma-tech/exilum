#!/usr/bin/env node
// Island / pool-ratio signatures the parent A/Bs use, exposure-INDEPENDENT where it counts:
//   scene-window p10 (dark floor: a FILL raises it, an ISLAND leaves it), p90 (bright mass:
//   island raises), dynRange=p90/p10 (fill compresses, island widens).
//   radial zone ratio ctr/outer over the scene window (parent lever): references 1.84-3.54,
//   ours 0.65-1.65. Prescription = TAKE light from mid/outer, PUT in centre, hold total.
//   ctr r<0.25, mid 0.25-0.55, outer r>0.55 of the scene-window half-diagonal. Report deltas.
// usage: pctl.mjs <frame.png>
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(buf){if(buf.readUInt32BE(0)!==0x89504e47)throw new Error('not a PNG');let pos=8,W=0,H=0,bd=0,ct=0;const idat=[];while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);if(type==='IHDR'){W=data.readUInt32BE(0);H=data.readUInt32BE(4);bd=data[8];ct=data[9];}else if(type==='IDAT')idat.push(Buffer.from(data));else if(type==='IEND')break;pos+=12+len;}if(bd!==8)throw new Error('bd');const ch=ct===6?4:ct===2?3:1;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch;const out=Buffer.alloc(H*stride);let rp=0;for(let y=0;y<H;y++){const f=raw[rp++];const line=raw.subarray(rp,rp+stride);rp+=stride;const cur=out.subarray(y*stride,(y+1)*stride);const prev=y>0?out.subarray((y-1)*stride,y*stride):null;for(let x=0;x<stride;x++){const A=x>=ch?cur[x-ch]:0,B=prev?prev[x]:0,C=prev&&x>=ch?prev[x-ch]:0;let v=line[x];switch(f){case 0:break;case 1:v+=A;break;case 2:v+=B;break;case 3:v+=(A+B)>>1;break;case 4:{const p=A+B-C,pa=Math.abs(p-A),pb=Math.abs(p-B),pc=Math.abs(p-C);v+=(pa<=pb&&pa<=pc)?A:(pb<=pc?B:C);break;}}cur[x]=v&0xff;}}const rgb=new Uint8Array(W*H*3);for(let i=0;i<W*H;i++){if(ct===2||ct===6){rgb[i*3]=out[i*ch];rgb[i*3+1]=out[i*ch+1];rgb[i*3+2]=out[i*ch+2];}else{const g=out[i*ch];rgb[i*3]=g;rgb[i*3+1]=g;rgb[i*3+2]=g;}}return {width:W,height:H,rgb};}
const srgbToLin=(c)=>{const s=c/255;return s<=0.04045?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
const lum=(r,g,b)=>0.2126*srgbToLin(r)+0.7152*srgbToLin(g)+0.0722*srgbToLin(b);
const p=decodePNG(readFileSync(process.argv[2]));
const {width:W,height:H,rgb}=p;
// Scene window (y12-72%, x8-92%, HUD excluded) — the domain modeSep uses and where the cool
// FILL's floor-lift and ambient spill live. Full-frame p10 sits in the black background.
const sy0=Math.floor(H*0.12),sy1=Math.floor(H*0.72),sx0=Math.floor(W*0.08),sx1=Math.floor(W*0.92);
const cxp=(sx0+sx1)/2,cyp=(sy0+sy1)/2,halfd=Math.hypot((sx1-sx0)/2,(sy1-sy0)/2);
const vals=[];let cs=0,cc=0,ms=0,mc=0,os=0,oc=0,tot=0,tc=0;const cvals=[];
for(let y=sy0;y<sy1;y++)for(let x=sx0;x<sx1;x++){const i=(y*W+x)*3;const l=lum(rgb[i],rgb[i+1],rgb[i+2]);vals.push(l);tot+=l;tc++;
  const rr=Math.hypot(x-cxp,y-cyp)/halfd;
  if(rr<0.25){cs+=l;cc++;cvals.push(l);}else if(rr<0.55){ms+=l;mc++;}else{os+=l;oc++;}}
const L=Float64Array.from(vals);const N=L.length;L.sort();
const q=(a,f)=>a[Math.min(a.length-1,Math.max(0,Math.floor(f*(a.length-1))))];
const p10=q(L,0.10),p50=q(L,0.50),p90=q(L,0.90);
const ctr=cs/Math.max(cc,1),mid=ms/Math.max(mc,1),outer=os/Math.max(oc,1);
const cv=Float64Array.from(cvals);cv.sort();
console.log(JSON.stringify({file:process.argv[2].split('/').pop(),win:'scene',
  p10:+p10.toFixed(4),p50:+p50.toFixed(4),p90:+p90.toFixed(4),dynRange:+(p90/Math.max(p10,1e-5)).toFixed(1),
  ctr:+ctr.toFixed(4),mid:+mid.toFixed(4),outer:+outer.toFixed(4),ctrOuter:+(ctr/Math.max(outer,1e-5)).toFixed(2),
  ctrP90:+q(cv,0.90).toFixed(4),total:+(tot/Math.max(tc,1)).toFixed(4)}));
