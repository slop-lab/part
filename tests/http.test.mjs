import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgent } from '../dist/agent.js';
import { fakeModel } from '../dist/testing.js';
import { createFetchTransport, noAuth } from '../dist/model.js';
import { createOllamaAdapter } from '../dist/provider-ollama.js';
import { createEmbeddedEndpoint } from '../dist/host-embedded.js';
import { startHttpHost } from '../dist/host-http.js';
import { createHttpPort } from '../dist/transport-http.js';
import { localContext, ok, fail } from '../dist/contracts.js';
const context=localContext();
test('G03: provider adapter uses a real HTTP custom endpoint with a local fake response',async()=>{
  let body;
  const server=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString());response.setHeader('content-type','application/x-ndjson');response.write('{"message":{"content":"local "},"done":false}\n');response.end('{"message":{"content":"endpoint"},"done":true,"done_reason":"stop"}\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const endpoint=`http://127.0.0.1:${server.address().port}/api/chat`;
  const model={profile:{id:'local',revision:'1',adapterId:'part/ollama',transportId:'part/fetch',authStrategyId:'none',model:'fake-model',endpoint,defaults:{},capabilities:{revision:'1',entries:[]}},adapter:createOllamaAdapter(),transport:createFetchTransport({allowedOrigins:[new URL(endpoint).origin]}),auth:noAuth};
  const agent=createAgent({model}).value;
  try{const outcome=await agent.generate('local test');assert.equal(outcome.value.phase,'completed');assert.equal(outcome.value.result.content[0].text,'local endpoint');assert.equal(body.messages[0].content,'local test');assert.equal(body.model,'fake-model');}
  finally{await agent.dispose();await new Promise(resolve=>server.close(resolve));}
});
test('HTTP/SSE commands, queries, snapshots and owner authentication',async()=>{
  const model=fakeModel([{text:'over http'}]),agent=createAgent({model}).value,endpoint=createEmbeddedEndpoint(agent,{context}).value;
  const host=await startHttpHost(endpoint,{context:request=>request.headers.authorization==='Bearer fixture'?ok(context):fail('auth','Unauthorized','permission')});assert.equal(host.ok,true);
  const port=createHttpPort(host.value.url,{headers:()=>({authorization:'Bearer fixture'})});
  let watch;
  try{
    const unauthorized=createHttpPort(host.value.url);assert.equal((await unauthorized.query({queryId:'part/capabilities',version:1,input:null})).ok,false);
    assert.equal((await port.discover()).ok,true);watch=(await port.watch({surface:'chat'})).value;assert.equal(watch.bootstrap.items.length,0);
    const iterator=watch.frames[Symbol.asyncIterator]();const pending=iterator.next();
    const delivered=await port.command({protocolVersion:1,commandId:'http-start',actionId:'part.run/start',actionVersion:1,input:'hello'});assert.equal(delivered.receipt.kind,'accepted');
    const first=await pending;assert.equal(first.value.kind,'event');assert.equal(first.value.event.type,'part.item/upsert');
    await new Promise(resolve=>setTimeout(resolve,10));const run=await port.query({queryId:'part.run/get',version:1,input:delivered.receipt.operation.id});assert.equal(run.value.phase,'completed');
    await watch.close();await iterator.return();
  }finally{await watch?.close();await host.value.close();await endpoint.close();}
});
