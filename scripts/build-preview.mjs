import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const bundle = await build({
  entryPoints: ['examples/chat/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  write: false,
});
const css = readFileSync('src/ui/styles.css', 'utf8');
mkdirSync('preview', { recursive: true });
writeFileSync(
  'preview/index.html',
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>part · Chat preview</title><style>${css}
body{margin:0;background:#09111c;color:#e7edf6;font-family:system-ui,sans-serif;padding:clamp(1rem,4vw,3rem)}header{max-width:52rem;margin:0 auto 1.5rem}h1{font-size:2rem;margin:0}header p{color:#adc0d7;line-height:1.6}.controls{display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:1rem}.alternate-theme{--part-background:#f4f7fb;--part-foreground:#122137;--part-border:#b6c9de;--part-radius:1.25rem}.alternate-theme button{background:#d5e5f7}.report-card{border-inline-start:3px solid #65cda6;padding-inline-start:1rem}.report-card small{letter-spacing:.15em;color:#65cda6}.report-card h3{margin:.5rem 0}.report-card p{margin:0;color:#adc0d7}</style><body><header><h1>part</h1><p>Progressive agent runtime · local Chat preview with simulated responses</p><div class="controls"><label><input type="checkbox" id="cards" checked> Custom report cards</label><label><input type="checkbox" id="theme"> Alternate CSS theme</label></div></header><main id="chat"></main><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`,
);
console.log('Preview built: preview/index.html');
