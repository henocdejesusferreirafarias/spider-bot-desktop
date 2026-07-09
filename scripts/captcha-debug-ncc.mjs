// Debug: imprime scores NCC por célula para fixture 0.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeRGBA } from './captcha-perceptual-match.mjs';

const T = 64;
function rb(src, sw, sh, dw, dh) {
  const dst = new Float32Array(dw * dh);
  const xr = dw === 1 ? 0 : (sw - 1) / (dw - 1);
  const yr = dh === 1 ? 0 : (sh - 1) / (dh - 1);
  for (let y = 0; y < dh; y++) {
    const sy = y * yr; const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xr; const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
      dst[y * dw + x] = (1-fx)*(1-fy)*src[y0*sw+x0]+fx*(1-fy)*src[y0*sw+x1]+(1-fx)*fy*src[y1*sw+x0]+fx*fy*src[y1*sw+x1];
    }
  }
  return dst;
}
function rn(src, sw, sh, dw, dh) {
  const dst = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) { const sy = Math.min(sh-1, Math.floor(y*sh/dh)); for (let x = 0; x < dw; x++) { const sx = Math.min(sw-1, Math.floor(x*sw/dw)); dst[y*dw+x] = src[sy*sw+sx]; } }
  return dst;
}

const dir = resolve('test/fixtures/captcha/dataset/nine/0');
const grid = decodeRGBA(readFileSync(resolve(dir, 'grid.jpg')));
const ques = decodeRGBA(readFileSync(resolve(dir, 'ques.png')));
const gw = grid.width, gh = grid.height, cw = Math.floor(gw/3), ch = Math.floor(gh/3);
const qw = ques.width, qh = ques.height;

const qg = new Float32Array(qw*qh), qa = new Uint8Array(qw*qh);
for (let i = 0, p = 0; i < qw*qh; i++, p += 4) { qg[i] = 0.299*ques.data[p]+0.587*ques.data[p+1]+0.114*ques.data[p+2]; qa[i] = ques.data[p+3]; }
let minx=qw,miny=qh,maxx=-1,maxy=-1;
for (let y=0;y<qh;y++) for (let x=0;x<qw;x++) if (qa[y*qw+x]>=128) { if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y; }
const qcW=maxx-minx+1, qcH=maxy-miny+1;
const qcg=new Float32Array(qcW*qcH), qca=new Uint8Array(qcW*qcH);
for (let y=0;y<qcH;y++) for (let x=0;x<qcW;x++) { const si=(miny+y)*qw+(minx+x); qcg[y*qcW+x]=qg[si]; qca[y*qcW+x]=qa[si]; }
const qGrayT=rb(qcg,qcW,qcH,T,T);
const qMaskF=rn(Float32Array.from(qca),qcW,qcH,T,T);
const mask=new Float32Array(T*T); let nmask=0;
for (let i=0;i<T*T;i++){mask[i]=qMaskF[i]>=128?1:0;if(mask[i])nmask++;}
let sq=0; for(let i=0;i<T*T;i++) sq+=qGrayT[i]*mask[i];
const mq=sq/nmask;
const qc=new Float32Array(T*T); let varq=0;
for(let i=0;i<T*T;i++){const d=(qGrayT[i]-mq)*mask[i]; qc[i]=d; varq+=d*d;}
console.log('crop', {qcW,qcH}, 'nmask', nmask, 'of', T*T, 'varq', varq.toFixed(1));

const scores=[];
for(let r=0;r<3;r++) for(let c=0;c<3;c++){
  const cell=new Float32Array(cw*ch);
  for(let y=0;y<ch;y++) for(let x=0;x<cw;x++){const si=((r*ch+y)*gw+(c*cw+x))*4; cell[y*cw+x]=0.299*grid.data[si]+0.587*grid.data[si+1]+0.114*grid.data[si+2];}
  const cgT=rb(cell,cw,ch,T,T);
  let sc=0; for(let i=0;i<T*T;i++) sc+=cgT[i]*mask[i];
  const mc=sc/nmask;
  let num=0,varc=0; for(let i=0;i<T*T;i++){const dc=(cgT[i]-mc)*mask[i]; num+=dc*qc[i]; varc+=dc*dc;}
  const den=Math.sqrt(varq*varc);
  scores.push({r:r+1,c:c+1,ncc:den>0?num/den:-1,mc:Number(mc.toFixed(1)),varc:Number(varc.toFixed(1))});
}
scores.sort((a,b)=>b.ncc-a.ncc);
console.log('per-cell NCC (sorted desc):');
for(const s of scores) console.log(`  [${s.r},${s.c}] ncc=${s.ncc.toFixed(4)} mc=${s.mc} varc=${s.varc}`);
