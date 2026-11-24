// Shared print stylesheet. Colours come from the organization theme as CSS variables, so branding is changed in one place.
// System font stacks only: no web fonts to download, identical behaviour on any OS or host. (06B decides font embedding
// for the PDF renderer.) Everything wraps (overflow-wrap) and nothing has a fixed height except the certificate frame,
// whose text is size-fitted instead, so long names and titles can never be clipped.
export const themeVars = (c) => `:root{--primary:${c.primary};--accent:${c.accent};--ink:${c.ink};--muted:#475569;--line:#CBD5E1;--soft:#F1F5F9}`;

export const baseCss = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,'Liberation Sans',sans-serif;color:var(--ink);font-size:10.5pt;line-height:1.5;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;background:#E2E8F0}
.serif{font-family:Georgia,'Times New Roman','Liberation Serif',serif}
h1,h2,h3,p,ul,ol,dl,dd{margin:0}
.sheet{position:relative;background:#fff;margin:12px auto;box-shadow:0 2px 14px rgba(15,23,42,.18);overflow-wrap:anywhere;word-break:normal;hyphens:auto}
.brandbar{height:5px;background:linear-gradient(90deg,var(--primary),var(--accent));-webkit-print-color-adjust:exact;print-color-adjust:exact}
.hdr{display:flex;align-items:center;gap:14px}
.hdr img{width:54px;height:54px;object-fit:contain;flex:none}
.hdr .name{font-size:19pt;font-weight:800;letter-spacing:.06em;color:var(--primary);line-height:1.1}
.hdr .meta{margin-left:auto;text-align:right;font-size:8.5pt;color:var(--muted);line-height:1.45;max-width:62mm}
.ph{color:#B45309;background:#FEF3C7;padding:0 3px;border-radius:2px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.rule{height:1px;background:var(--line);margin:14px 0}
.eyebrow{font-size:8.5pt;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
.docno{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:9pt;color:var(--muted)}
.docno b{color:var(--ink);font-weight:700}
.grid{display:grid;grid-template-columns:42mm 1fr;border:1px solid var(--line);border-radius:4px;overflow:hidden;break-inside:avoid}
.grid dt,.grid dd{padding:6px 10px;border-bottom:1px solid var(--line)}
.grid dt{background:var(--soft);font-weight:700;font-size:9pt;color:var(--muted)}
.grid dt:nth-last-child(2),.grid dd:last-child{border-bottom:0}
.sec{margin-top:16px}
.sec h2{break-after:avoid;font-size:11pt;color:var(--primary);margin-bottom:5px;letter-spacing:.02em}
.sec ul,.sec ol{padding-left:18px}.sec li{margin:0 0 4px;break-inside:avoid}
.terms li{font-size:9.5pt}
.sign{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-top:22px;break-inside:avoid}
.sign .sigbox{min-width:62mm;max-width:80mm}
.sign .line{height:16mm;border-bottom:1px solid var(--ink);margin-bottom:4px}
.sign .line,.cfoot .line{position:relative}
.sigart{position:absolute;left:0;bottom:-2px;width:100%;max-width:62mm;height:17mm;overflow:visible}
.sign .who{font-weight:700}.sign .role{font-size:9pt;color:var(--muted)}
.verify{display:flex;align-items:center;gap:10px;font-size:8pt;color:var(--muted);text-align:left;max-width:100mm}
.verify .qr{width:24mm;height:24mm;flex:none;display:flex;align-items:center;justify-content:center}
.verify .qr svg{width:100%;height:100%}
.verify b{display:block;color:var(--ink);font-size:9pt}
.verify code{font-family:'Courier New',monospace;font-size:8pt;color:var(--ink);white-space:nowrap}
.verify .vhint{display:block;font-size:7.5pt;margin:2px 0}.verify .vurl{display:block;font-size:7.5pt;font-weight:700;color:var(--ink);overflow-wrap:anywhere;margin-bottom:2px}
.foot{margin-top:18px;padding-top:8px;border-top:1px solid var(--line);font-size:8pt;color:var(--muted);text-align:center;break-inside:avoid}
.wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}
.wm span{transform:rotate(-30deg);font-size:46pt;font-weight:800;letter-spacing:.08em;color:rgba(185,28,28,.14);border:6px solid rgba(185,28,28,.14);padding:4px 24px;white-space:nowrap}
`;

export const offerCss = `
@page{size:A4 portrait;margin:14mm 16mm 16mm}
.sheet{width:210mm;min-height:297mm;padding:14mm 16mm 16mm}
.title{font-size:20pt;font-weight:800;line-height:1.2;margin:4px 0 8px}
.salute{margin:16px 0 8px}
.lead p{margin-bottom:8px}
@media print{body{background:#fff}.sheet{margin:0;box-shadow:none;width:auto;min-height:0;padding:0}.wm{position:fixed}}
`;

export const certificateCss = `
@page{size:A4 landscape;margin:0}
.sheet{width:297mm;height:209mm;padding:9mm;overflow:hidden}
.frame{height:100%;border:1.6mm solid var(--primary);outline:.4mm solid var(--accent);outline-offset:-3.4mm;padding:8mm 14mm 7mm;display:flex;flex-direction:column;text-align:center;overflow-wrap:anywhere}
.frame .hdr{justify-content:center}
.frame .hdr img{width:46px;height:46px}
.ctitle{font-size:30pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--primary);margin-top:8px;line-height:1.1}
.csub{font-size:10.5pt;color:var(--muted);margin-top:8px}
.cname{font-weight:700;color:var(--ink);line-height:1.15;margin:6px auto 4px;max-width:230mm;border-bottom:1px solid var(--accent);padding:0 10mm 4px}
.cbody{max-width:225mm;margin:8px auto 0;font-size:11pt;line-height:1.6}
.cbody strong{color:var(--primary)}
.facts{display:flex;justify-content:center;flex-wrap:wrap;gap:6px 26px;margin:12px 0 0;font-size:9.5pt;color:var(--muted)}
.facts b{display:block;color:var(--ink);font-size:10.5pt}
.cfoot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:14px;text-align:left}
.cfoot .sigbox{min-width:62mm;max-width:80mm}
.cfoot .line{height:14mm;border-bottom:1px solid var(--ink);margin-bottom:3px}
.cfoot .who{font-weight:700}.cfoot .role{font-size:9pt;color:var(--muted)}
.cfoot .verify{max-width:92mm}
.cfoot .verify .qr{width:22mm;height:22mm}
.frame .foot{margin-top:8px;padding-top:5px}
@media print{body{background:#fff}.sheet{margin:0;box-shadow:none}}
`;
