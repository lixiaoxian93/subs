/*
 * pornhub-adclean.js — Surge http-response 脚本,给 www.pornhub.com 的网页去广告。
 *
 * 2026-08-03 实抓 PH 移动版视频页(iPhone UA)得出的事实,决定了做法:
 *
 *   ① 广告域名是**固定的自家广告网** TrafficJunky(media.trafficjunky.net /
 *      trafficjunky.com/invocation/popunder/),不是 netfapx 那种随机词拼的轮换域名。
 *      → 所以**不注入 CSP 白名单**。netfapx 那份主力是 CSP,是因为它域名天天换、
 *        黑名单必烂;PH 域名固定,网络层 REJECT 就够,而注 CSP 反倒有风险:
 *        HLS 播放器常用 blob: worker,Safari 下 worker 会回落到 script-src,
 *        限死了可能视频直接不播。收益低风险高,不做。
 *
 *   ② 前贴片(preroll)配置端点做在**自己域名**下:
 *        https://www.pornhub.com/_xa/ads?zone_id=...&preroll_type=json
 *      (实测 200 / application/json / 13KB)。这是典型的反广告拦截设计 ——
 *      按域名拉黑名单碰不到它。治法在 sgmodule 的 [URL Rewrite] 里把它 reject-dict
 *      (返回空 {}),站方代码 `if (!prerollObj.json) return` 自己就不播了。
 *
 *   ③ 驱动前贴片的 `"adRollGlobalConfig":[...]` 内联 JSON,跟 `flashvars_<id>`
 *      **在同一个 <script> 块里**,而 flashvars 里装着 mediaDefinitions / videoUrl
 *      —— 视频直链。所以这块**绝对不能整删**,只能就地把那个数组置空。
 *      置空必须括号配平扫描(见 matchBracket):贪婪正则会把 JSON 改坏,
 *      整块语法错误 = 视频直接不播,比不装还糟。
 *
 *   ④ 广告位外层容器 class 是随机混淆串(抓到时叫 xbmbv9bdblkgmmuwcaa,会变),
 *      稳定锚点是 <ins class='adsbytrafficjunky'> 和 .watchpageAd /
 *      .middleVideoAdContainer 这些语义 class。CSS 只认后者。
 *
 * 做四件事:
 *   1. 删掉不在白名单的外链 <script>(白名单 = pornhub.com + phncdn.com 自家 CDN)
 *   2. 删掉纯广告的内联 <script>(TJ_ADS_TAKEOVER 预加载器、TrafficJunky popunder invocation)
 *   3. 就地把 "adRollGlobalConfig" 数组置空(前贴片的第二道保险)
 *   4. 注入 CSS 收广告位 + window.open 拦截(只放行本站 URL,不误伤站内新开标签)
 *
 * 失败处理:整段包 try/catch,出错时**原样返回原始 body**,页面里留
 * <!-- pornhub-adclean ERROR: ... --> 注释。绝不静默,也绝不白屏。
 */

// 允许执行脚本的来源。删任何一条会坏什么:
//   pornhub.com   站内内联/同源脚本
//   phncdn.com    PH 自家 CDN(ei. / ss. / cdn1d-static-shared. 全在这个后缀下),
//                 播放器本体和页面逻辑都从这来 —— 删了页面直接废
const ALLOW_SCRIPT_HOSTS = ['pornhub.com', 'phncdn.com'];

// 纯广告内联脚本的特征。这两个标记经实测**不出现**在含 flashvars 的那个块里,
// 所以按它们删是安全的。不要放宽成 'trafficjunky' —— 那个词也出现在 flashvars
// 同块的 preroll json URL 里,泛匹配会把视频直链一起删掉。
const AD_INLINE_MARKERS = [
  'TJ_ADS_TAKEOVER',                // 广告预加载器
  'trafficjunky.com/invocation',    // popunder / embeddedads invocation
];

// 广告位。用语义 class,不用那串随机混淆 class。
const INJECT =
  '<style>ins.adsbytrafficjunky,.watchpageAd,.middleVideoAdContainer,' +
  'div:has(> ins.adsbytrafficjunky){display:none!important}</style>' +
  '<script>(function(){try{var o=window.open;window.open=function(u){' +
  'try{if(u&&/^(?:https?:)?\\/\\/(?:[a-z0-9-]+\\.)*pornhub\\.com\\//i.test(String(u)))' +
  'return o.apply(window,arguments);}catch(e){}return null;};}catch(e){}})();</script>';

function hostOf(u) {
  const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(u);
  if (!m) return 'pornhub.com';        // 相对路径 = 本站
  return m[1].toLowerCase().replace(/:\d+$/, '');
}

function allowedHost(host) {
  return ALLOW_SCRIPT_HOSTS.some(function (h) {
    return host === h || host.endsWith('.' + h);
  });
}

/*
 * s[i] 必须是 '[' 或 '{';返回与之配对的闭括号下标,配不平返回 -1。
 * 字符串字面量内的括号不计数(处理 \" 转义),否则 JSON 里的 "a]b" 会把深度算歪。
 */
function matchBracket(s, i) {
  let depth = 0, inStr = false, esc = false;
  for (let k = i; k < s.length; k++) {
    const c = s.charAt(k);
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/*
 * 把 "<key>":[ ... ] 就地换成 "<key>":[],其余字节一个不动。
 * 任何一步不确定(后面不是数组、括号配不平)就**跳过不改** —— 宁可广告漏一个,
 * 也不能把 flashvars 那段 JSON 改坏。
 */
function blankJsonArray(s, key) {
  const needle = '"' + key + '":';
  let out = '', pos = 0, n = 0;
  for (;;) {
    const at = s.indexOf(needle, pos);
    if (at < 0) break;
    let i = at + needle.length;
    while (i < s.length && /\s/.test(s.charAt(i))) i++;
    if (s.charAt(i) !== '[') { out += s.slice(pos, at + needle.length); pos = at + needle.length; continue; }
    const end = matchBracket(s, i);
    if (end < 0) { out += s.slice(pos, at + needle.length); pos = at + needle.length; continue; }
    out += s.slice(pos, at) + needle + '[]';
    pos = end + 1;
    n++;
  }
  return { html: out + s.slice(pos), n: n };
}

function clean(html) {
  let dropped = 0;
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, function (tag) {
    // src 只在**开标签**里找。别在整个 tag(含脚本正文)上找 —— 正文里出现的
    // src="..." 会把内联块误判成外链脚本:PH 装视频直链的那个 flashvars 块正文里
    // 就有 src=,一旦它指向白名单外的域名,整块会被当广告删掉 → 视频不播。
    const openTag = /^<script\b[^>]*>/i.exec(tag);
    const src = openTag && /\ssrc\s*=\s*["']([^"']+)["']/i.exec(openTag[0]);
    if (src) {
      if (allowedHost(hostOf(src[1]))) return tag;
      dropped++;
      return '';
    }
    const isAd = AD_INLINE_MARKERS.some(function (mk) { return tag.indexOf(mk) >= 0; });
    if (isAd) { dropped++; return ''; }
    return tag;
  });
  const r = blankJsonArray(out, 'adRollGlobalConfig');
  return { html: r.html, dropped: dropped, preroll: r.n };
}

try {
  const ct = String(
    ($response.headers['Content-Type'] || $response.headers['content-type'] || ''));
  const body = $response.body;
  // 只处理 HTML。json/图片/视频原样放行(pattern 已经筛过一道,这里是第二道保险)
  if (ct.indexOf('text/html') < 0 || typeof body !== 'string') {
    $done({});
  } else {
    const r = clean(body);
    let out = r.html;
    // 注入点优先 </head>;没有就退回 <body 开头,再没有就拼在最前面
    if (out.indexOf('</head>') >= 0) out = out.replace('</head>', INJECT + '</head>');
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, '$&' + INJECT);
    else out = INJECT + out;
    console.log('pornhub-adclean: 删掉 ' + r.dropped + ' 个广告脚本,置空 ' + r.preroll + ' 处前贴片配置');
    $done({ body: out });
  }
} catch (e) {
  // 绝不让脚本故障变成白屏:原样放行,但在页面里留痕,坏了看得见
  console.log('pornhub-adclean ERROR: ' + e);
  $done({
    body: (typeof $response.body === 'string')
      ? '<!-- pornhub-adclean ERROR: ' + String(e).replace(/-->/g, '--') + ' -->' + $response.body
      : $response.body,
  });
}
