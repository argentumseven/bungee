import {chromium} from 'playwright-core';
import {readFile,writeFile} from 'node:fs/promises';

// The Markdown is canonical; exports and syntax validation use the same source.
const markdown=await readFile('docs/SECURITY.md','utf8');
const diagrams=[...markdown.matchAll(/^```mermaid\n([\s\S]*?)^```/gm)].map(m=>m[1]);
const names=['security-architecture','storage-lifecycle'];
if(diagrams.length!==names.length)throw Error('Update the export names when changing the number of Security diagrams');
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const context=await browser.newContext({viewport:{width:1800,height:1000},deviceScaleFactor:2});
  const page=await context.newPage();
  const failures=[];
  page.on('pageerror',e=>failures.push(e.message));
  await page.setContent('<!doctype html><html><body style="margin:0;background:white"><main id="diagram" style="display:inline-block;padding:20px"></main></body></html>');
  await page.addScriptTag({content:await readFile(process.env.MERMAID_BUNDLE || 'work/diagram-tools/node_modules/mermaid/dist/mermaid.min.js','utf8')});
  await page.evaluate(()=>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral',fontFamily:'Arial, sans-serif',flowchart:{htmlLabels:false,curve:'linear',useMaxWidth:false}}));
  for(const [index,name] of names.entries()) {
    const source=diagrams[index];
    const result=await page.evaluate(async({source,index})=>{
      const {svg}=await mermaid.render(`security-diagram-${index}`,source);
      document.querySelector('#diagram').innerHTML=svg;
      const graphic=document.querySelector('#diagram svg');
      return {svg,text:graphic.textContent,rect:{width:graphic.getBoundingClientRect().width,height:graphic.getBoundingClientRect().height}};
    },{source,index});
    if(/caddy|reverse.?proxy/i.test(result.text))throw Error(`Stale proxy in ${name}`);
    await writeFile(`docs/images/${name}.svg`,result.svg+'\n');
    await page.setViewportSize({width:Math.ceil(result.rect.width)+40,height:Math.ceil(result.rect.height)+40});
    await page.locator('#diagram').screenshot({path:`docs/images/${name}.png`});
    console.log(`PASS: ${name} rendered at ${Math.ceil(result.rect.width)} × ${Math.ceil(result.rect.height)}; no proxy nodes`);
  }
  if(failures.length)throw Error(failures.join('\n'));
} finally {await browser.close();}
