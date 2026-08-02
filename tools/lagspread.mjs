#!/usr/bin/env node
// Scale-uniformity probe (lagSpread) — reproduces the parent-agent instrument EXACTLY, so
// CoolIsland can report crypt lagSpread before/after on the SAME method the round uses.
//
// TWO-SIDED metric (corrected + evidenced): references sit 0.167-0.170; our naves 0.004-0.014
// (too uniform), our crypt 0.91-1.34 (too incoherent). correlation(lagSpread, spatialVariation)
// = -0.709 over our 5 stations — scale variety and pool structure trade off. So a crypt RISE
// is NOT a win; a fall TOWARD 0.167 alongside a spVar rise is the double win. Target 0.15-0.20.
//
// Method (verbatim): per scanline every 7 rows, mean-subtract, autocorrelate over lags 6-90,
// take the lag of the peak; lagSpread = mean-absolute-deviation of that peak-lag across
// scanlines, divided by the median lag.
//
// Windows (fractions of W,H):
//   nave-lit / poe2-07  y0.30-0.60 x0.55-0.85
//   arena    / poe2-09  y0.25-0.55 x0.12-0.42
//   crypt               y0.35-0.62 x0.35-0.65
//
// usage: lagspread.mjs <frame.png> <nave|arena|crypt>
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf){if(buf.readUInt32BE(0)!==0x89504e47)throw new Error('not a PNG');let pos=8,W=0,H=0,bd=0,ct=0;const idat=[];while(pos<buf.length){const len=buf.readUInt32BE(pos);const type=buf.toString('ascii',pos+4,pos+8);const data=buf.subarray(pos+8,pos+8+len);if(type==='IHDR'){W=data.readUInt32BE(0);H=data.readUInt32BE(4);bd=data[8];ct=data[9];}else if(type==='IDAT')idat.push(Buffer.from(data));else if(type==='IEND')break;pos+=12+len;}if(bd!==8)throw new Error('bd');const ch=ct===6?4:ct===2?3:1;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch;const out=Buffer.alloc(H*stride);let rp=0;for(let y=0;y<H;y++){const f=raw[rp++];const line=raw.subarray(rp,rp+stride);rp+=stride;const cur=out.subarray(y*stride,(y+1)*stride);const prev=y>0?out.subarray((y-1)*stride,y*stride):null;for(let x=0;x<stride;x++){const A=x>=ch?cur[x-ch]:0,B=prev?prev[x]:0,C=prev&&x>=ch?prev[x-ch]:0;let v=line[x];switch(f){case 0:break;case 1:v+=A;break;case 2:v+=B;break;case 3:v+=(A+B)>>1;break;case 4:{const p=A+B-C,pa=Math.abs(p-A),pb=Math.abs(p-B),pc=Math.abs(p-C);v+=(pa<=pb&&pa<=pc)?A:(pb<=pc?B:C);break;}}cur[x]=v&0xff;}}const rgb=new Uint8Array(W*H*3);for(let i=0;i<W*H;i++){if(ct===2){rgb[i*3]=out[i*ch];rgb[i*3+1]=out[i*ch+1];rgb[i*3+2]=out[i*ch+2];}else if(ct===6){rgb[i*3]=out[i*ch];rgb[i*3+1]=out[i*ch+1];rgb[i*3+2]=out[i*ch+2];}else{const g=out[i*ch];rgb[i*3]=g;rgb[i*3+1]=g;rgb[i*3+2]=g;}}return {width:W,height:H,rgb};}

const srgbToLin=(c)=>{const s=c/255;return s<=0.04045?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
const lum=(r,g,b)=>0.2126*srgbToLin(r)+0.7152*srgbToLin(g)+0.0722*srgbToLin(b);

const WIN = {
  nave:  { y0:0.30, y1:0.60, x0:0.55, x1:0.85 },
  arena: { y0:0.25, y1:0.55, x0:0.12, x1:0.42 },
  crypt: { y0:0.35, y1:0.62, x0:0.35, x1:0.65 },
};

const file = process.argv[2], win = process.argv[3] || 'crypt';
const w = WIN[win]; if (!w) { console.error('window?', Object.keys(WIN)); process.exit(2); }
const p = decodePNG(readFileSync(file));
const { width:W, height:H, rgb } = p;
const x0=Math.floor(W*w.x0), x1=Math.floor(W*w.x1), y0=Math.floor(H*w.y0), y1=Math.floor(H*w.y1);

const LAG_MIN=6, LAG_MAX=90;
const peakLags=[];
for (let y=y0; y<y1; y+=7) {
  const row=[]; for (let x=x0;x<x1;x++){const i=(y*W+x)*3;row.push(lum(rgb[i],rgb[i+1],rgb[i+2]));}
  const n=row.length; if (n<=LAG_MAX+2) continue;
  const mean=row.reduce((a,b)=>a+b,0)/n; for(let i=0;i<n;i++)row[i]-=mean;
  let bestLag=LAG_MIN, best=-Infinity;
  for (let lag=LAG_MIN; lag<=LAG_MAX; lag++){
    let s=0; for(let i=0;i+lag<n;i++)s+=row[i]*row[i+lag];
    if (s>best){best=s;bestLag=lag;}
  }
  peakLags.push(bestLag);
}
peakLags.sort((a,b)=>a-b);
const med = peakLags.length%2 ? peakLags[(peakLags.length-1)/2] : (peakLags[peakLags.length/2-1]+peakLags[peakLags.length/2])/2;
const mad = peakLags.reduce((a,l)=>a+Math.abs(l-med),0)/peakLags.length;
const lagSpread = mad/Math.max(med,1e-9);
console.log(JSON.stringify({file:file.split('/').pop(), win, scanlines:peakLags.length, medianLag:+med.toFixed(2), lagSpread:+lagSpread.toFixed(4)}));
