/*
 * porntrex-adclean.js — Surge http-response 脚本,给 www.porntrex.com 的网页去广告。
 *
 * 2026-08-03 实抓 PT 视频页(iPhone UA)得出的事实,决定了做法:
 *
 *   ① 站方**自己已经把外链广告脚本注释掉了**(js.onclckmn.com / adsmediabox.com
 *      都躺在 <!-- --> 里)。现在真正在跑的广告全挂在**一个固定域名** gsrv.dev 上:
 *        · popunder      go.gsrv.dev/pop.go   (SNSPAdManager,绑在 selector:'a' 上,
 *                                              点任何链接都可能弹)
 *        · 前/后贴片      go.gsrv.dev/vast.go  (kt_player 的 adv_pre_vast/adv_post_vast)
 *        · banner iframe  g2.gsrv.dev/banner.go
 *      → 域名固定不轮换,所以主力是 sgmodule 里网络层 REJECT gsrv.dev 一刀端掉,
 *        **不注入 CSP**(播放器 kt_player 可能用 blob: worker,Safari 下 worker 会
 *        回落到 script-src,限死了有视频不播的风险 —— 收益低风险高)。
 *
 *   ② popunder 那块(SNSPAdManager,约 14KB)是**独立的纯广告 <script>**,
 *      实测同块内没有 video_url / kt_player / license_code —— 可以整块删。
 *
 *   ③ 但 adv_pre_vast / adv_post_vast 跟 video_url、license_code **同在
 *      kt_player 初始化那个块里** —— 那块绝对不能删,只能就地把 vast 地址置空。
 *
 *   ④ 页面上那些 id 是纯数字(1395076 / 2620528 ...)的 div 是**视频缩略图**,
 *      不是广告位。按数字 id 隐藏会把整页视频列表干掉 —— 别碰。
 *      真正的广告位锚点是 iframe[src*="gsrv.dev"]。
 *
 * 做四件事:
 *   1. 删掉不在白名单的外链 <script>(白名单 = porntrex.com + cdntrex.com 自家 CDN
 *      + ajax.googleapis.com 的 jQuery)
 *   2. 删掉纯广告的内联 <script>(SNSPAdManager popunder)
 *   3. 就地把所有 gsrv.dev 的 URL 值置空(前/后贴片的第二道保险),并删 banner iframe
 *   4. 注入 CSS 收广告位 + window.open 拦截(只放行本站 URL,站内「新标签打开」不受影响)
 *
 * 失败处理:整段包 try/catch,出错时**原样返回原始 body**,页面里留
 * <!-- porntrex-adclean ERROR: ... --> 注释。绝不静默,也绝不白屏。
 */

// 允许执行脚本的来源。删任何一条会坏什么:
//   porntrex.com        站内脚本
//   cdntrex.com         自家 CDN(ptx.cdntrex.com),播放器 kt_player.js 从这来 —— 删了视频不播
//   ajax.googleapis.com 站方从这引 jQuery,站内脚本依赖它 —— 删了页面交互全废
// 没放行 googletagmanager(GA),会被删,无副作用。
const ALLOW_SCRIPT_HOSTS = ['porntrex.com', 'cdntrex.com', 'ajax.googleapis.com'];

// 纯广告内联脚本的特征。SNSPAdManager 是 popunder 管理器,实测独立成块。
const AD_INLINE_MARKERS = [
  'SNSPAdManager',
];

const INJECT =
  '<style>iframe[src*="gsrv.dev"]{display:none!important}' +
  'div:has(> iframe[src*="gsrv.dev"]){display:none!important}</style>' +
  '<script>(function(){try{var o=window.open;window.open=function(u){' +
  'try{if(u&&/^(?:https?:)?\\/\\/(?:[a-z0-9-]+\\.)*porntrex\\.com\\//i.test(String(u)))' +
  'return o.apply(window,arguments);}catch(e){}return null;};}catch(e){}})();</script>';

function hostOf(u) {
  const m = /^(?:https?:)?\/\/([^/?#]+)/i.exec(u);
  if (!m) return 'porntrex.com';       // 相对路径 = 本站
  return m[1].toLowerCase().replace(/:\d+$/, '');
}

function allowedHost(host) {
  return ALLOW_SCRIPT_HOSTS.some(function (h) {
    return host === h || host.endsWith('.' + h);
  });
}

function clean(html) {
  let dropped = 0;
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, function (tag) {
    // src 只在**开标签**里找。别在整个 tag(含脚本正文)上找 —— 正文里出现的
    // src="..." 会把内联块误判成外链脚本:PT 的 kt_player 初始化块(装 video_url /
    // license_code)正文里就有 src=,一旦它指向白名单外的域名,整块会被当广告删掉 → 视频不播。
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

  // banner iframe 整个删掉(网络层已经 REJECT 了,这里是去掉占位)
  let iframes = 0;
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>|<iframe\b[^>]*\/?>/gi, function (tag) {
    if (tag.indexOf('gsrv.dev') >= 0) { iframes++; return ''; }
    return tag;
  });

  // 剩下的 gsrv.dev 地址(adv_pre_vast / adv_post_vast 等)就地置空。
  // 只动引号包起来的**整个值**,不改结构 —— kt_player 配置块里还有视频直链,不能碰坏。
  let urls = 0;
  out = out.replace(/(['"])(?:https?:)?\/\/[^'"]*gsrv\.dev[^'"]*\1/gi, function (m, q) {
    urls++;
    return q + q;
  });

  return { html: out, dropped: dropped, iframes: iframes, urls: urls };
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
    if (out.indexOf('</head>') >= 0) out = out.replace('</head>', INJECT + '</head>');
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, '$&' + INJECT);
    else out = INJECT + out;
    console.log('porntrex-adclean: 删掉 ' + r.dropped + ' 个广告脚本 / ' +
                r.iframes + ' 个广告 iframe,置空 ' + r.urls + ' 个广告地址');
    $done({ body: out });
  }
} catch (e) {
  console.log('porntrex-adclean ERROR: ' + e);
  $done({
    body: (typeof $response.body === 'string')
      ? '<!-- porntrex-adclean ERROR: ' + String(e).replace(/-->/g, '--') + ' -->' + $response.body
      : $response.body,
  });
}
