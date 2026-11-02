function EGCore(){
"use strict";
var FILES='abcdefgh';
function sqName(s){return FILES[s&7]+((s>>3)+1);}
var DIRS=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
var NDIRS=[[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
var KN=[],NN=[],RAYS=[];
var ADJ=new Uint8Array(4096),NADJ=new Uint8Array(4096);
var LINE=new Int8Array(4096).fill(-1);
var BTW=new Array(4096);
for(var s=0;s<64;s++){
  var f=s&7,r=s>>3;KN[s]=[];NN[s]=[];RAYS[s]=[];
  for(var d=0;d<8;d++){
    var df=DIRS[d][0],dr=DIRS[d][1];
    if(f+df>=0&&f+df<8&&r+dr>=0&&r+dr<8){var t=(r+dr)*8+f+df;KN[s].push(t);ADJ[s*64+t]=1;}
    var nf=f+df,nr=r+dr,path=[],ray=[];
    while(nf>=0&&nf<8&&nr>=0&&nr<8){var t2=nr*8+nf;LINE[s*64+t2]=d;BTW[s*64+t2]=path.slice();path.push(t2);ray.push(t2);nf+=df;nr+=dr;}
    RAYS[s][d]=ray;
  }
  for(var k=0;k<8;k++){var a=f+NDIRS[k][0],b=r+NDIRS[k][1];if(a>=0&&a<8&&b>=0&&b<8){var t3=b*8+a;NN[s].push(t3);NADJ[s*64+t3]=1;}}
}
var SLIDE={Q:[0,1,2,3,4,5,6,7],R:[0,1,2,3],B:[4,5,6,7]};

function attacks(type,from,to,occ){
  if(type==='K')return ADJ[from*64+to]===1;
  if(type==='N')return NADJ[from*64+to]===1;
  if(type==='P'){var dd=to-from;return (dd===7&&(from&7)>0)||(dd===9&&(from&7)<7);}
  var dir=LINE[from*64+to];if(dir<0)return false;
  if(type==='R'&&dir>3)return false;if(type==='B'&&dir<4)return false;
  var bt=BTW[from*64+to];for(var i=0;i<bt.length;i++)if(occ[bt[i]])return false;
  return true;
}

/* ---------- Retrograde solver for K + pieces vs K ----------
   Index: wk, bk, p1[, p2] (6 bits each, wk most significant).
   btm[i]: 255 = draw/illegal, v>=1 = black is mated in v-1 plies.
   wtm[i]: 0 = not winning/illegal, v>=2 = white mates in v-1 plies.
   A position where black can capture a white piece counts as a draw:
   the trainer wants mates that never give material away. */
function solveMate(types,prog){
  var k=types.length,NP=k+2,size=1<<(6*NP);
  var btm=new Uint8Array(size).fill(255),wtm=new Uint8Array(size),cnt=new Uint8Array(size);
  var sh=[];for(var u=0;u<NP;u++)sh[u]=6*(NP-1-u);
  var ut=['K',null].concat(types);
  var wslots=[0];for(u=2;u<NP;u++)wslots.push(u);
  var occ=new Uint8Array(64),A=new Uint8Array(64),sq=new Int32Array(NP);
  function idx(){var i=0;for(var u=0;u<NP;u++)i|=sq[u]<<sh[u];return i;}
  function wAtt(t){for(var n=0;n<wslots.length;n++){var u=wslots[n];if(attacks(ut[u],sq[u],t,occ))return true;}return false;}
  function initCombo(){
    for(var t=0;t<64;t++)A[t]=wAtt(t)?1:0;
    var wk=sq[0];
    for(var bk=0;bk<64;bk++){
      if(occ[bk]||ADJ[wk*64+bk])continue;
      sq[1]=bk;var i=idx(),c=0,draw=false,nb=KN[bk];
      for(var n=0;n<nb.length;n++){var t2=nb[n];if(A[t2]||t2===wk)continue;if(occ[t2]){draw=true;break;}c++;}
      if(draw)continue;
      if(c===0){btm[i]=A[bk]?1:255;}else{btm[i]=0;cnt[i]=c;}
    }
  }
  for(var wk=0;wk<64;wk++){
    if(prog)prog(0.15*wk/64);
    for(var a=0;a<64;a++){if(a===wk)continue;
      if(k===1){occ.fill(0);occ[wk]=occ[a]=1;sq[0]=wk;sq[2]=a;initCombo();}
      else for(var b=0;b<64;b++){if(b===wk||b===a)continue;occ.fill(0);occ[wk]=occ[a]=occ[b]=1;sq[0]=wk;sq[2]=a;sq[3]=b;initCombo();}
    }
  }
  var orig=new Int32Array(32);
  function origins(type,from){
    var n=0,i,L;
    if(type==='K'){L=KN[from];for(i=0;i<L.length;i++)if(!occ[L[i]])orig[n++]=L[i];return n;}
    if(type==='N'){L=NN[from];for(i=0;i<L.length;i++)if(!occ[L[i]])orig[n++]=L[i];return n;}
    var ds=SLIDE[type];
    for(var x=0;x<ds.length;x++){var ray=RAYS[from][ds[x]];for(i=0;i<ray.length;i++){if(occ[ray[i]])break;orig[n++]=ray[i];}}
    return n;
  }
  var expected={Q:20,R:32,RR:16,BB:38,BN:66}[types.join('')]||60;
  var front=[];for(var i0=0;i0<size;i0++)if(btm[i0]===1)front.push(i0);
  for(var dd=0;;dd+=2){
    var found=front.length,next=[];
    for(var fi=0;fi<front.length;fi++){
      var i=front[fi];
      for(u=0;u<NP;u++)sq[u]=(i>>>sh[u])&63;
      occ.fill(0);for(u=0;u<NP;u++)occ[sq[u]]=1;
      var bk=sq[1];
      for(var w=0;w<wslots.length;w++){
        u=wslots[w];var from=sq[u],ty=ut[u];
        var no=origins(ty,from),os=orig.slice(0,no);
        for(var o=0;o<no;o++){
          var s2=os[o];
          if(ty==='K'&&ADJ[s2*64+bk])continue;
          occ[from]=0;occ[s2]=1;sq[u]=s2;
          if(!wAtt(bk)){
            var j=idx();
            if(wtm[j]===0){
              wtm[j]=dd+2;
              var wk2=sq[0],nb=KN[bk];
              for(var m=0;m<nb.length;m++){
                var b2=nb[m];if(occ[b2]||ADJ[wk2*64+b2])continue;
                sq[1]=b2;var k2=idx();sq[1]=bk;
                if(btm[k2]===0&&--cnt[k2]===0){btm[k2]=dd+3;next.push(k2);}
              }
            }
          }
          occ[s2]=0;occ[from]=1;sq[u]=from;
        }
      }
    }
    front=next;
    if(prog)prog(Math.min(0.99,0.15+0.85*(dd/2+1)/expected));
    if(!found)break;
  }
  for(var i1=0;i1<size;i1++)if(btm[i1]===0)btm[i1]=255;
  return {wtm:wtm,btm:btm};
}

/* ---------- K + P vs K, forward layered solver ----------
   Index wk<<12|bk<<6|p. Same value conventions as above.
   Promotion to queen or rook is looked up in the KQK / KRK tables. */
function solveKPK(kqk,krk,prog){
  var size=1<<18,W=new Uint8Array(size).fill(255),B=new Uint8Array(size).fill(255);
  var wl=[],bl=[];
  for(var wk=0;wk<64;wk++)for(var bk=0;bk<64;bk++){
    if(wk===bk||ADJ[wk*64+bk])continue;
    for(var p=8;p<56;p++){
      if(p===wk||p===bk)continue;
      var i=wk<<12|bk<<6|p,chk=attacks('P',p,bk,null);
      if(!chk){W[i]=0;wl.push(i);}
      var c=0,draw=false,nb=KN[bk];
      for(var n=0;n<nb.length;n++){var t=nb[n];
        if(t===wk||ADJ[wk*64+t])continue;
        if(t===p){if(!ADJ[wk*64+p]){draw=true;break;}continue;}
        if(attacks('P',p,t,null))continue;c++;}
      if(draw)continue;
      if(c===0)B[i]=chk?1:255;else{B[i]=0;bl.push(i);}
    }
  }
  var last=0;
  for(var ply=1;ply<250;ply++){
    var changed=0;
    if(ply&1){
      var nw=[];
      for(var x=0;x<wl.length;x++){
        i=wl[x];if(W[i]!==0)continue;
        wk=i>>>12;bk=(i>>>6)&63;p=i&63;var won=false,L=KN[wk];
        for(n=0;n<L.length&&!won;n++){var t2=L[n];if(t2===p||t2===bk||ADJ[t2*64+bk])continue;if(B[t2<<12|bk<<6|p]===ply)won=true;}
        var q=p+8;
        if(!won&&q!==wk&&q!==bk){
          if(q>=56){var qi=wk<<12|bk<<6|q;if(kqk[qi]===ply||krk[qi]===ply)won=true;}
          else{if(B[wk<<12|bk<<6|q]===ply)won=true;
            var q2=p+16;if(!won&&p<16&&q2!==wk&&q2!==bk&&B[wk<<12|bk<<6|q2]===ply)won=true;}
        }
        if(won){W[i]=ply+1;changed++;}else nw.push(i);
      }
      wl=nw;
    }else{
      var nbl=[];
      for(x=0;x<bl.length;x++){
        i=bl[x];if(B[i]!==0)continue;
        wk=i>>>12;bk=(i>>>6)&63;p=i&63;var all=true,L2=KN[bk];
        for(n=0;n<L2.length;n++){var t3=L2[n];
          if(t3===wk||t3===p||ADJ[wk*64+t3]||attacks('P',p,t3,null))continue;
          var v=W[wk<<12|t3<<6|p];if(v===0||v===255){all=false;break;}}
        if(all){B[i]=ply+1;changed++;}else nbl.push(i);
      }
      bl=nbl;
    }
    if(changed)last=ply;
    if(prog)prog(Math.min(0.99,ply/90));
    if(ply>60&&ply-last>40)break;
  }
  for(i=0;i<size;i++){if(W[i]===255)W[i]=0;if(B[i]===0)B[i]=255;}
  return {wtm:W,btm:B};
}


/* ---------- Symmetry-reduced tables (pawnless endings) ----------
   The white king is mapped into the a1-d1-d4 triangle (10 squares). */
var XF=[];  // XF[t][sq] -> transformed square, 8 board symmetries
for(var t=0;t<8;t++){XF[t]=new Int8Array(64);for(var q=0;q<64;q++){var f=q&7,r=q>>3;
  if(t&1)f=7-f;if(t&2)r=7-r;if(t&4){var tmp=f;f=r;r=tmp;}XF[t][q]=r*8+f;}}
var TRI=new Int8Array(64).fill(-1),TRIX=new Int8Array(64);
(function(){var n=0;for(var q=0;q<64;q++){var f=q&7,r=q>>3;if(f<=3&&r<=f)TRI[q]=n++;}
  for(var q2=0;q2<64;q2++)for(var t=0;t<8;t++)if(TRI[XF[t][q2]]>=0){TRIX[q2]=t;break;}})();
/* squares: [wk, bk, p1, p2...] -> reduced index */
function redIndex(sqs){var t=TRIX[sqs[0]],X=XF[t],i=TRI[X[sqs[0]]];for(var n=1;n<sqs.length;n++)i=i*64+X[sqs[n]];return i;}
function reduceTable(btm,NP){
  var out=new Uint8Array(10*Math.pow(64,NP-1)),shift=6*(NP-1);
  for(var wk=0;wk<64;wk++){if(TRI[wk]<0)continue;var base=TRI[wk]*Math.pow(64,NP-1),src=wk<<shift,len=1<<shift;
    out.set(btm.subarray(src,src+len),base);}
  return out;
}

/* ---------- Game logic for the trainer (white pieces + lone black king) ---------- */
function occOf(pos){var o=new Uint8Array(64);for(var i=0;i<pos.w.length;i++)o[pos.w[i].s]=1;o[pos.bk]=2;return o;}
function unitAt(pos,s){for(var i=0;i<pos.w.length;i++)if(pos.w[i].s===s)return pos.w[i];return null;}
function wk(pos){return unitAt(pos,-1)||pos.w.filter(function(u){return u.t==='K';})[0];}
function whiteAttacks(pos,target,occ,skip){
  for(var i=0;i<pos.w.length;i++){var u=pos.w[i];if(u===skip)continue;if(attacks(u.t,u.s,target,occ))return true;}return false;}
function inCheck(pos){if(pos.stm!=='b')return false;var o=occOf(pos);return whiteAttacks(pos,pos.bk,o);}
function legalMoves(pos){
  var out=[],o=occOf(pos),K=wk(pos);
  if(pos.stm==='w'){
    for(var i=0;i<pos.w.length;i++){var u=pos.w[i],t,L,n;
      if(u.t==='K'){L=KN[u.s];for(n=0;n<L.length;n++){t=L[n];if(!o[t]&&!ADJ[t*64+pos.bk])out.push({from:u.s,to:t});}}
      else if(u.t==='N'){L=NN[u.s];for(n=0;n<L.length;n++){t=L[n];if(!o[t])out.push({from:u.s,to:t});}}
      else if(u.t==='P'){t=u.s+8;if(!o[t]){
          if(t>=56)['Q','R','B','N'].forEach(function(pr){out.push({from:u.s,to:t,promo:pr});});
          else{out.push({from:u.s,to:t});if(u.s<16&&!o[u.s+16])out.push({from:u.s,to:u.s+16});}}}
      else{var ds=SLIDE[u.t];for(var x=0;x<ds.length;x++){var ray=RAYS[u.s][ds[x]];for(n=0;n<ray.length;n++){if(o[ray[n]])break;out.push({from:u.s,to:ray[n]});}}}
    }
  }else{
    o[pos.bk]=0;var L3=KN[pos.bk];
    for(var m=0;m<L3.length;m++){var tt=L3[m];if(tt===K.s)continue;
      var cap=unitAt(pos,tt);
      if(!whiteAttacks(pos,tt,o,cap))out.push({from:pos.bk,to:tt,capture:!!cap});}
  }
  return out;
}
function makeMove(pos,m){
  var np={w:pos.w.map(function(u){return {t:u.t,s:u.s};}),bk:pos.bk,stm:pos.stm==='w'?'b':'w'};
  if(pos.stm==='w'){var u=unitAt(np,m.from);u.s=m.to;if(m.promo)u.t=m.promo;}
  else{np.bk=m.to;np.w=np.w.filter(function(u){return u.s!==m.to;});}
  return np;
}
var ORDER={K:0,Q:1,R:2,B:3,N:4,P:5};
function matKey(pos){return pos.w.filter(function(u){return u.t!=='K';}).map(function(u){return u.t;}).sort(function(a,b){return ORDER[a]-ORDER[b];}).join('');}
var TABLE_TYPES={Q:['Q'],R:['R'],RR:['R','R'],BB:['B','B'],BN:['B','N'],P:['P']};
function indexOf(pos,key){
  var types=TABLE_TYPES[key],used=[],i=(wk(pos).s<<6|pos.bk);
  for(var n=0;n<types.length;n++){
    for(var x=0;x<pos.w.length;x++){var u=pos.w[x];if(u.t===types[n]&&used.indexOf(x)<0){used.push(x);i=i<<6|u.s;break;}}
  }
  return i;
}
function decode(key,i,stm){
  var types=TABLE_TYPES[key],n=types.length,w=[];
  for(var x=n-1;x>=0;x--){w.unshift({t:types[x],s:i&63});i>>>=6;}
  var bk=i&63;i>>>=6;w.unshift({t:'K',s:i&63});
  return {w:w,bk:bk,stm:stm};
}
function isLegal(pos){
  var seen={};var all=pos.w.map(function(u){return u.s;}).concat([pos.bk]);
  for(var i=0;i<all.length;i++){if(seen[all[i]])return false;seen[all[i]]=1;}
  var K=wk(pos);if(ADJ[K.s*64+pos.bk])return false;
  for(i=0;i<pos.w.length;i++){var u=pos.w[i];if(u.t==='P'&&(u.s<8||u.s>55))return false;}
  if(pos.stm==='w'){var o=occOf(pos);if(whiteAttacks(pos,pos.bk,o))return false;}
  return true;
}
/* Evaluation from white's point of view: {win:true,plies} or {win:false}. */
function evaluate(pos,TB){
  var key=matKey(pos),T=TB[key];
  if(!T)return {win:false,known:key===''||key==='B'||key==='N'};
  var i=indexOf(pos,key);
  if(pos.stm==='w'){var v=T.wtm[i];return v>=2?{win:true,plies:v-1,known:true}:{win:false,known:true};}
  var b=T.btm[i];return (b>=1&&b<255)?{win:true,plies:b-1,known:true}:{win:false,known:true};
}
return {redIndex:redIndex,reduceTable:reduceTable,TRI:TRI,XF:XF,TRIX:TRIX,sqName:sqName,KN:KN,ADJ:ADJ,attacks:attacks,solveMate:solveMate,solveKPK:solveKPK,legalMoves:legalMoves,makeMove:makeMove,inCheck:inCheck,
  occOf:occOf,unitAt:unitAt,wk:wk,whiteAttacks:whiteAttacks,matKey:matKey,indexOf:indexOf,decode:decode,isLegal:isLegal,evaluate:evaluate,TABLE_TYPES:TABLE_TYPES};
}
if(typeof module!=='undefined')module.exports=EGCore;
