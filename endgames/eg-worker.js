/* Builds the small endgame tables (K+Q, K+R, K+P vs K) in the background. */
importScripts('egcore.js');
var C = EGCore();
var Q = C.solveMate(['Q']);
var R = C.solveMate(['R']);
var P = C.solveKPK(Q.btm, R.btm);
postMessage({ Q: Q.btm, R: R.btm, P: P.btm }, [Q.btm.buffer, R.btm.buffer, P.btm.buffer]);
