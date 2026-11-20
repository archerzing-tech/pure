// 卡内预览的外部资源缓存/降级（2026-11-20）：
// ```html 卡以 asset:// iframe 跑模型直出的页面。页面里的瓦片/模型/纹理大多
// 指向运行时 CDN：CDN 被墙、代理只对某一路由生效、或离线时，整张卡就停在
// 半加载状态。这里只做两件事——识别「像资源」的跨域请求，注入一个把请求转给
// 宿主的加载器；真正的磁盘缓存和代理路由在 Rust/宿主侧（见
// src/ui/previewAssetBridge.ts）。共享层保持纯函数，便于测试注入位置与识别面。

/** 资源扩展名。故意不放 json：普通 JSON 是 API 响应，缓存它会改变页面语义；
 *  tileset.json / .gltf 由单独规则接住。 */
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico',
  'glb', 'gltf', 'bin', 'obj', 'fbx', 'drc', 'ktx', 'ktx2', 'basis',
  'b3dm', 'pnts', 'i3dm', 'cmpt', 'terrain', 'geojson', 'topojson',
  'mvt', 'pbf', 'woff', 'woff2', 'ttf', 'otf',
]);

/** 1x1 透明 PNG：瓦片/图片最终取不到时用它占位，地图留灰块而不是整卡空白。 */
export const PREVIEW_ASSET_IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function pathExtension(pathname: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 是否值得走宿主缓存。只认绝对 http(s) URL：相对路径指向卡自身或本地项目，
 * 宿主缓存帮不上忙；iframe 里能直接加载的 data:/blob:/asset: 也不该绕路。
 *
 * 识别面是「资源形状」而不是全量代理：扩展名、常见 z/x/y 瓦片路径、
 * tileset JSON、以及 x/y/z 查询参数。API 的普通 JSON 不在其中。
 */
export function isPreviewAssetUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (ASSET_EXTENSIONS.has(pathExtension(url.pathname))) return true;
  if (/\/\d+\/\d+\/\d+(?:[/.]|$)/.test(url.pathname)) return true;
  if (/tileset[^/]*\.json$/i.test(url.pathname)) return true;
  if (/[?&](?:x|y|z|tile|level|zoom)=\d/i.test(url.search)) return true;
  return false;
}

/** 把加载器插到页面脚本之前。<head> 不存在时退到 <html> 之后，再退到开头；
 *  加载器只需在页面自己的脚本之前定义，不依赖 DOM 已就绪。 */
export function injectPreviewAssetLoader(source: string, token: string): string {
  const script = `<script>${buildPreviewAssetLoader(token)}</script>`;
  const head = /<head\b[^>]*>/i.exec(source);
  if (head) {
    const at = head.index + head[0].length;
    return source.slice(0, at) + script + source.slice(at);
  }
  const html = /<html\b[^>]*>/i.exec(source);
  if (html) {
    const at = html.index + html[0].length;
    return source.slice(0, at) + script + source.slice(at);
  }
  return script + source;
}

/**
 * 卡内加载器。它不知道代理、磁盘或 Tauri 命令——只把绝对资源 URL 通过
 * postMessage 交给宿主，宿主回一个已落盘的 asset:// URL，再由它替换掉
 * fetch / XHR / img.src 的目标。
 *
 * 为什么不用 Cache Storage：卡跑在 sandbox 的不透明源里，CORS 响应也拿不到
 * 可缓存副本；宿主的 Rust 缓存才是跨会话、跨离线可靠的那一层。
 *
 * 失败阶梯：宿主取不到 → 原 URL 直连一次 → 图片用透明占位，其余让调用方收到
 * 正常的网络错误。这样单个资源不会把整页卡在 pending 请求上。
 */
export function buildPreviewAssetLoader(token: string): string {
  const js = String.raw`
(function () {
  var TOKEN = "__PURE_ASSET_TOKEN__";
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;

  var MAX_ACTIVE = 8;
  var BRIDGE_TIMEOUT_MS = 45000;
  var PLACEHOLDER = "__PURE_ASSET_PLACEHOLDER__";
  var ASSET_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|glb|gltf|bin|obj|fbx|drc|ktx2?|basis|b3dm|pnts|i3dm|cmpt|terrain|geojson|topojson|mvt|pbf|woff2?|ttf|otf)$/i;

  function isPrivateHost(host) {
    host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || /\.localhost$/.test(host) || /\.local$/.test(host)) return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
    var m = /^172\.(\d+)\./.exec(host);
    if (m && +m[1] >= 16 && +m[1] <= 31) return true;
    return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }

  function absoluteAssetUrl(raw) {
    try {
      var url = new URL(raw, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (url.origin === location.origin) return "";
      if (isPrivateHost(url.hostname)) return "";
      if (ASSET_EXT.test(url.pathname)) return url.href;
      if (/\/\d+\/\d+\/\d+([/.]|$)/.test(url.pathname)) return url.href;
      if (/tileset[^/]*\.json$/i.test(url.pathname)) return url.href;
      if (/[?&](x|y|z|tile|level|zoom)=\d/i.test(url.search)) return url.href;
      return "";
    } catch (e) {
      return "";
    }
  }

  var pending = Object.create(null);
  var seq = 0;
  function requestHost(url) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        parentWin.postMessage({ channel: "pure-preview-asset", token: TOKEN, id: id, url: url }, "*");
      } catch (e) {
        delete pending[id];
        reject(e);
        return;
      }
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error("preview asset bridge timeout"));
        }
      }, BRIDGE_TIMEOUT_MS);
    });
  }

  var queue = [];
  var active = 0;
  function hostAsset(url) {
    return new Promise(function (resolve, reject) {
      queue.push({ url: url, resolve: resolve, reject: reject });
      pump();
    });
  }
  function pump() {
    while (active < MAX_ACTIVE && queue.length > 0) {
      (function (job) {
        active++;
        requestHost(job.url).then(job.resolve, job.reject).then(next, next);
        function next() {
          active--;
          pump();
        }
      })(queue.shift());
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parentWin) return;
    var data = event.data;
    if (!data || data.channel !== "pure-preview-asset-reply" || data.token !== TOKEN) return;
    var job = pending[data.id];
    if (!job) return;
    delete pending[data.id];
    if (data.ok && data.assetUrl) job.resolve(data.assetUrl);
    else job.reject(new Error(data.error || "preview asset unavailable"));
  });

  // img.src：Leaflet/纹理加载器都直接写 src。失败先直连，再退透明占位。
  var imageProto = window.HTMLImageElement && window.HTMLImageElement.prototype;
  var srcDesc = imageProto && Object.getOwnPropertyDescriptor(imageProto, "src");
  if (srcDesc && srcDesc.set && srcDesc.get) {
    Object.defineProperty(imageProto, "src", {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get: function () {
        return srcDesc.get.call(this);
      },
      set: function (value) {
        var img = this;
        var raw = String(value == null ? "" : value);
        var absolute = absoluteAssetUrl(raw);
        if (!absolute) {
          srcDesc.set.call(img, value);
          return;
        }
        var mine = (img.__pureAssetSeq || 0) + 1;
        img.__pureAssetSeq = mine;
        hostAsset(absolute).then(function (assetUrl) {
          if (img.__pureAssetSeq !== mine) return;
          srcDesc.set.call(img, assetUrl);
        }, function () {
          if (img.__pureAssetSeq !== mine) return;
          srcDesc.set.call(img, raw);
          img.addEventListener("error", function onError() {
            img.removeEventListener("error", onError);
            if (img.__pureAssetSeq !== mine) return;
            if (img.getAttribute("data-pure-asset-fallback")) return;
            img.setAttribute("data-pure-asset-fallback", absolute);
            srcDesc.set.call(img, PLACEHOLDER);
          });
        });
      }
    });
  }

  // fetch：three.js 的 GLTFLoader/纹理加载器走这条。
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var raw = "";
      try {
        raw = typeof input === "string" ? input : (input && input.url) || "";
      } catch (e) {}
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var absolute = method === "GET" && raw ? absoluteAssetUrl(raw) : "";
      if (!absolute) return nativeFetch.apply(this, arguments);
      var self = this;
      return hostAsset(absolute).then(function (assetUrl) {
        return nativeFetch.call(self, assetUrl, init);
      }).catch(function () {
        return nativeFetch.call(self, input, init);
      });
    };
  }

  // XHR：Cesium 一类库直接开 XHR。异步请求才走宿主；同步请求没有等待桥的余地。
  var NativeXHR = window.XMLHttpRequest;
  if (NativeXHR && NativeXHR.prototype) {
    var nativeOpen = NativeXHR.prototype.open;
    var nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function (method, url) {
      this.__pureOpen = {
        args: Array.prototype.slice.call(arguments),
        method: String(method || "GET").toUpperCase(),
        url: String(url || "")
      };
      return nativeOpen.apply(this, arguments);
    };
    NativeXHR.prototype.send = function (body) {
      var xhr = this;
      var info = xhr.__pureOpen;
      if (!info || info.method !== "GET" || info.args[2] === false) {
        return nativeSend.apply(this, arguments);
      }
      var absolute = absoluteAssetUrl(info.url);
      if (!absolute) return nativeSend.apply(this, arguments);
      hostAsset(absolute).then(function (assetUrl) {
        var args = info.args.slice();
        args[1] = assetUrl;
        nativeOpen.apply(xhr, args);
        nativeSend.call(xhr, body);
      }, function () {
        nativeSend.call(xhr, body);
      });
    };
  }
})();
`;
  return js
    .replace('__PURE_ASSET_TOKEN__', token)
    .replace('__PURE_ASSET_PLACEHOLDER__', PREVIEW_ASSET_IMAGE_PLACEHOLDER);
}

/** 测试与诊断用的稳定标记：确认一张卡是否已经注入过加载器。 */
export const PREVIEW_ASSET_LOADER_MARKER = 'pure-preview-asset';
