import json

font_sizes = {
  "label-md": ["12px", {"lineHeight": "16px", "letterSpacing": "0.02em", "fontWeight": "600"}],
  "label-lg": ["14px", {"lineHeight": "20px", "fontWeight": "600"}],
  "label-sm": ["10px", {"lineHeight": "14px", "letterSpacing": "0.04em", "fontWeight": "600"}],
  "headline-lg-mobile": ["26px", {"lineHeight": "34px", "letterSpacing": "-0.01em", "fontWeight": "700"}],
  "headline-md": ["24px", {"lineHeight": "32px", "letterSpacing": "-0.01em", "fontWeight": "600"}],
  "body-sm": ["12px", {"lineHeight": "18px", "fontWeight": "400"}],
  "headline-sm": ["18px", {"lineHeight": "26px", "fontWeight": "600"}],
  "headline-lg": ["32px", {"lineHeight": "42px", "letterSpacing": "-0.015em", "fontWeight": "700"}],
  "body-md": ["14px", {"lineHeight": "22px", "fontWeight": "400"}],
  "body-lg": ["16px", {"lineHeight": "26px", "fontWeight": "400"}],
  "display-hero": ["44px", {"lineHeight": "56px", "letterSpacing": "-0.02em", "fontWeight": "700"}]
}

out = ""
for k, v in font_sizes.items():
    size = v[0]
    opts = v[1]
    out += f"  --text-{k}: {size};\n"
    if "lineHeight" in opts:
        out += f"  --text-{k}--line-height: {opts['lineHeight']};\n"
    if "letterSpacing" in opts:
        out += f"  --text-{k}--letter-spacing: {opts['letterSpacing']};\n"
    if "fontWeight" in opts:
        out += f"  --text-{k}--font-weight: {opts['fontWeight']};\n"

print(out)
