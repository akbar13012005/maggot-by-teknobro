import { defineConfig } from 'vite';
// Keep the deployed shell self-contained: no separate CSS/JS requests or
// stale hashed asset references when GitHub Pages updates its edge cache.
export default defineConfig({
 base: './',
 build:{outDir:'docs',emptyOutDir:true},
 plugins:[{
  name:'self-contained-pages', enforce:'post',
  generateBundle(_options,bundle){
   const html=bundle['index.html'];
   if(!html)return;
   let source=String(html.source);
   source=source.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="\.\/([^\"]+)"[^>]*>/g,(tag,path)=>{
    const asset=bundle[path];
    if(!asset)throw new Error(`Missing stylesheet: ${path}`);
    return `<style>${String(asset.source).replace(/<\/style/gi,'<\\/style')}</style>`;
   });
   source=source.replace(/<script\b[^>]*src="\.\/([^\"]+)"[^>]*><\/script>/g,(tag,path)=>{
    const chunk=bundle[path];
    if(!chunk || chunk.type!=='chunk')throw new Error(`Missing script: ${path}`);
    return `<script type="module">${chunk.code.replace(/<\/script/gi,'<\\/script')}</script>`;
   });
   html.source=source;
  }
 }]
});
