#!/usr/bin/env node
// Warm/cool/neutral % on a sub-window, using analyze.mjs's EXACT classification.
// usage: huewin.mjs <file.png> [x0 y0 x1 y1]
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(buf){if(buf.readUInt32BE(0)!==0x89504e47)throw new Error('not a PNG');let pos=8,W=0,H=0,bd=0,ct=0;const idat=[];while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);if(type==='IHDR'){W=data.readUInt32BE(0);H=data.readUInt32BE(4);bd=data[8];ct=data[9];}else if(type==='IDAT')idat.push(data);else if(type==='IEND')break;pos+=12+len;}const ch=ct===6?4:ct===2?3:1;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch;const rgb=new Uint8Array(W*H*3);const cur=new Uint8Array(stride),prev=new Uint8Array(stride);let rp=0;const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};for(let y=0;y<H;y++){const f=raw[rp++];for(let x=0;x<stride;x++){const rb=raw[rp++];const a=x>=ch?cur[x-ch]:0;const b=prev[x];const c=x>=ch?prev[x-ch]:0;let v;switch(f){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;case 4:v=rb+paeth(a,b,c);break;}cur[x]=v&0xff;}for(let x=0;x<W;x++){const o=(y*W+x)*3,s=x*ch;rgb[o]=cur[s];rgb[o+1]=ch===1?cur[s]:cur[s+1];rgb[o+2]=ch===1?cur[s]:cur[s+2];}prev.set(cur);}return{width:W,height:H,rgb};}
function rgbToHsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return{h,s:mx?d/mx:0,v:mx};}
const file=process.argv[2];
let [x0,y0,x1,y1]=process.argv.slice(3).map(Number);
const png=decodePNG(readFileSync(file));const{width:W,height:H,rgb}=png;
if(![x0,y0,x1,y1].every(Number.isFinite)){x0=0;y0=0;x1=W;y1=H;}
let warm=0,cool=0,neut=0;
for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*W+x)*3;const{h,s,v}=rgbToHsv(rgb[i],rgb[i+1],rgb[i+2]);if(v>0.06){if((h>=340||h<=65)&&s>0.10)warm++;else if(h>=170&&h<=280&&s>0.06)cool++;else neut++;}}
const t=warm+cool+neut||1;
console.log(JSON.stringify({file:file.split('/').pop(),window:[x0,y0,x1,y1],eligible:t,warmPct:+(100*warm/t).toFixed(1),coolPct:+(100*cool/t).toFixed(1),neutralPct:+(100*neut/t).toFixed(1)}));
