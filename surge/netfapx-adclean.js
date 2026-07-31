/*
 * netfapx-adclean.js — Surge http-response 脚本,给 netfapx.com 的网页去广告。
 *
 * 为什么是脚本而不是 [Body Rewrite] / [Header Rewrite](2026-08-01 查 Surge 手册确认):
 *   这两个段的参数**空格分隔且不支持引号**,于是
 *     · CSP 头的值 "script-src 'self' ..." 带空格 → 写不进 header-add
 *     · 「把广告脚本替换成空」也写不出来(空参数会被空格切没)
 *   脚本没有这个限制,而且白名单逻辑写成代码比堆正则可读得多。
 *
 * 做四件事:
 *   ① 删掉所有**不在白名单**的外链 <script>。这是主力 —— netfapx 的广告域名是
 *      dm.encratykenelm.com / mx.deforcesapful.com 这种随机词拼的轮换域名,
 *      按黑名单拉必然腐烂;反过来做白名单,它换多少个域名都没用。
 *   ② 删掉带广告特征的内联 <script>(popunder 加载器、混淆加载器、GA)。
 *   ③ 注入 CSP 响应头 + 一段 window.open 拦截,治「点哪都跳走」。
 *   ④ 注入 CSS 收掉广告位留下的空白。
 *
 * 失败处理(重要):脚本一旦抛错,Surge 会返回空响应 → 页面白屏(B站模块踩过这个坑)。
 * 所以整段包 try/catch,出错时**原样返回原始 body**,并在页面里留一条 HTML 注释
 * <!-- netfapx-adclean ERROR: ... -->。不静默:查看网页源代码搜 netfapx-adclean 就知道坏没坏。
 */

// 允许执行脚本的来源。删任何一条会坏什么:
//   netfapx.com        站内脚本,含取视频直链的 themes/pinthis/js/ajax.js —— 删了视频不播
//   cdn.fluidplayer.com 播放器本体 —— 删了视频框是空的
//   code.jquery.com    站方从这引 jQuery,ajax.js 依赖它 —— 删了视频不播
// 想让评论区的 recaptcha 能用,把 www.google.com / www.gstatic.com 加进来。
const ALLOW_SCRIPT_HOSTS = ['netfapx.com', 'cdn.fluidplayer.com', 'code.jquery.com'];

// 内联脚本的广告特征。站方自己的内联脚本(fluidPlayer 初始化、ajax_object)不含这些。
const AD_INLINE_MARKERS = [
  'popundersPerIP',   // PopAds popunder 配置项
  'atob(',            // 把广告域名 base64 编码后拼出来的加载器
  'decodeURI("',      // 另一段混淆加载器
  'gtag(',            // Google Analytics
];

const CSP = "script-src 'self' 'unsafe-inline' " +
  ALLOW_SCRIPT_HOSTS.filter(function (h) { return h !== 'netfapx.com'; })
    .map(function (h) { return 'https://' + h; }).join(' ') +
  "; object-src 'none'";

// 广告位容器被清空后会留白,收掉。顺手把 window.open 掐了 —— 「点哪都跳走」就是它干的。
const INJECT =
  '<style>#ads-position-header-desktop,#side-ads,#side-ads-loader,' +
  '.ads-header-desktop,.ads-header-desktop2{display:none!important}</style>' +
  '<script>(function(){try{window.open=function(){return null};}catch(e){}})();</script>';

function hostOf(u) {
  const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(u);
  if (!m) return 'netfapx.com';        // 相对路径 = 本站
  return m[1].toLowerCase().replace(/:\d+$/, '');
}

function allowedHost(host) {
  return ALLOW_SCRIPT_HOSTS.some(function (h) {
    return host === h || host.endsWith('.' + h);
  });
}

function clean(html) {
  let dropped = 0;
  const out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, function (tag) {
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (src) {
      if (allowedHost(hostOf(src[1]))) return tag;
      dropped++;
      return '';
    }
    const isAd = AD_INLINE_MARKERS.some(function (mk) { return tag.indexOf(mk) >= 0; });
    if (isAd) { dropped++; return ''; }
    return tag;
  });
  return { html: out, dropped: dropped };
}

function withCsp(headers) {
  const h = Object.assign({}, headers);
  // 站方已有一条 CSP(upgrade-insecure-requests)。同一个头里用分号接指令是合法的,
  // 直接追加,不顶掉人家那条。
  const key = Object.keys(h).find(function (k) {
    return k.toLowerCase() === 'content-security-policy';
  });
  if (key) h[key] = String(h[key]).replace(/;?\s*$/, '; ') + CSP;
  else h['Content-Security-Policy'] = CSP;
  return h;
}

try {
  const ct = String(
    ($response.headers['Content-Type'] || $response.headers['content-type'] || ''));
  const body = $response.body;
  // 只处理 HTML。图片/视频/JSON 原样放行(pattern 已经筛过一道,这里是第二道保险)
  if (ct.indexOf('text/html') < 0 || typeof body !== 'string') {
    $done({});
  } else {
    const r = clean(body);
    let out = r.html;
    // 注入点优先 </head>;没有就退回 <body 开头,再没有就拼在最前面
    if (out.indexOf('</head>') >= 0) out = out.replace('</head>', INJECT + '</head>');
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, '$&' + INJECT);
    else out = INJECT + out;
    console.log('netfapx-adclean: 删掉 ' + r.dropped + ' 个广告脚本');
    $done({ body: out, headers: withCsp($response.headers) });
  }
} catch (e) {
  // 绝不让脚本故障变成白屏:原样放行,但在页面里留痕,坏了看得见
  console.log('netfapx-adclean ERROR: ' + e);
  $done({
    body: (typeof $response.body === 'string')
      ? '<!-- netfapx-adclean ERROR: ' + String(e).replace(/-->/g, '--') + ' -->' + $response.body
      : $response.body,
  });
}
