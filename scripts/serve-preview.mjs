import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../preview/index.html',import.meta.url));
const server=createServer((_request,response)=>{response.setHeader('content-type','text/html; charset=utf-8');response.end(html);});
server.listen(4173,'127.0.0.1',()=>console.log('Chat preview: http://127.0.0.1:4173'));
