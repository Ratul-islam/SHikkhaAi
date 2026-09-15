import { describe, expect, it } from "vitest";
import { buildSandboxBody, hoistScripts } from "./sandboxHtml";

describe("hoistScripts", () => {
  // The exact shape every sampled model scene came back in.
  it("lifts a script out of the svg the model nested it in", () => {
    const html = '<svg viewBox="0 0 10 10"><circle id="c"/><script>window.shikkhaRender=function(t){}</script></svg>';
    const { markup, scripts } = hoistScripts(html);

    expect(markup).not.toContain("<script");
    expect(markup).toContain("<circle");
    expect(scripts).toContain("shikkhaRender");
  });

  it("emits the script after the markup so getElementById still resolves", () => {
    const body = buildSandboxBody('<svg><circle id="c"/><script>document.getElementById("c")</script></svg>');
    expect(body.indexOf("<circle")).toBeLessThan(body.indexOf("<script"));
  });

  it("handles several scripts and keeps their source order", () => {
    const body = buildSandboxBody("<svg><script>first()</script><script>second()</script></svg>");
    expect(body.indexOf("first()")).toBeLessThan(body.indexOf("second()"));
  });

  it("preserves attributes on the script tag", () => {
    const { scripts } = hoistScripts('<svg><script type="text/javascript">go()</script></svg>');
    expect(scripts).toContain('type="text/javascript"');
  });

  it("leaves script-free markup untouched", () => {
    const html = "<svg><rect/></svg>";
    expect(buildSandboxBody(html).trim()).toBe(html);
  });
});
