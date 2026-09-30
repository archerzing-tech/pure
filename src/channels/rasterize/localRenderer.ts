// src/channels/rasterize/localRenderer.ts
// gateway 进程里的本地光栅化：SVG → PNG 用 @resvg/resvg-js；```chart 走
// echarts 的无 DOM SSR（`init(null, null, { ssr: true, renderer: 'svg' })`），
// 复用 GUI 同一份 `parseChartSource` + `buildChartOption`，两表面同一张图。
//
// 全部 **动态 import**：没有富输出块时一行都不加载。这一层只处理「已经拿到 SVG
// 之后」的事（含 echarts 的 SSR，它不需要 DOM）；```mermaid / ```puml 要真浏览器，
// 走 headlessRenderer.ts 的 headless Chrome —— 那部分是可选的，没装 Chrome 时
// 由降级矩阵转成说明文本，而不是假装成功。
import type { RichRenderers } from '../richOutput';

/** SVG → PNG（resvg）。chart / svg / mermaid / puml 四条路最终都汇到这里。 */
export async function rasterizeSvg(svg: string, width = 900): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  return resvg.render().asPng();
}

export function createLocalRichRenderers(): RichRenderers {
  return {
    svgToPng: rasterizeSvg,

    async chartToPng(source: string): Promise<Uint8Array | null> {
      const [{ parseChartSource }, { buildChartOption }, echarts] = await Promise.all([
        import('../../ui/markdown'),
        import('../../ui/echartsChart'),
        import('echarts'),
      ]);
      const spec = parseChartSource(source);
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 420 });
      chart.setOption(buildChartOption(spec, false));
      const svg = chart.renderToSVGString();
      chart.dispose();
      return rasterizeSvg(svg);
    },
  };
}
