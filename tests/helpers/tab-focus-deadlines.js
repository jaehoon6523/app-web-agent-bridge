import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from '../../src/orchestration/selector-diagnostics.js';

export function registerTabFocusDeadlineTests({dashboard,state,view,refresh,reason,observed,timeout}) {
  test('real inspection deadline releases recovery, removes listener, ignores late reply and permits next focus', {timeout:20000}, async t => {
    const transport = new EventEmitter();
    transport.authenticated = true;
    const requests = [];
    transport.send = message => requests.push(message);
    t.after(() => cancelSelectorDiagnostics(transport));
    let focusCalls = 0;
    const ui = await dashboard(state(), async url => {
      if (url === '/api/preparations/tab-focus') {
        if (++focusCalls === 1) return timeout();
        return {opened:true,tabId:7};
      }
      return collectSelectorDiagnostics(transport);
    });
    await view(ui).listeners.click();
    const started = performance.now();
    const recovery = refresh(ui).listeners.click();
    await new Promise(setImmediate);
    assert.equal(refresh(ui).disabled,true);
    assert.equal(view(ui,1).disabled,false);
    assert.equal(transport.listenerCount('message'),1);
    await recovery;
    assert.ok(performance.now()-started >= 9900,'production 10-second deadline must actually elapse');
    assert.equal(transport.listenerCount('message'),0);
    assert.equal(refresh(ui).disabled,false);
    assert.equal(view(ui).disabled,true);
    assert.match(reason(ui),/対象|대상 탭은 확인하지 못/);
    const reply = request => transport.emit('message',{type:'extension.diagnostics.inspected',requestId:request.requestId,payload:observed});
    reply(requests[0]);
    assert.equal(view(ui).disabled,true);
    const next = refresh(ui).listeners.click();
    await new Promise(setImmediate);
    assert.equal(requests.length,2,'expired shared pending read must be removed');
    assert.notEqual(requests[0].requestId,requests[1].requestId);
    reply(requests[0]);
    assert.equal(transport.listenerCount('message'),1,'late reply cannot settle the new read');
    reply(requests[1]);
    await next;
    assert.equal(transport.listenerCount('message'),0);
    assert.equal(refresh(ui).disabled,false);
    assert.equal(view(ui).disabled,false);
    await view(ui).listeners.click();
    assert.equal(focusCalls,2);
    assert.equal(view(ui).disabled,false);
    assert.match(reason(ui),/탭 화면만 열었습니다/);
  });

  for (const phase of ['headers','body']) {
    test(`real HTTP ${phase} stall reaches browser deadline and releases recovery`, {timeout:40000}, async t => {
      let response, closed = false;
      const server = createServer((_req,res) => {
        response = res;
        res.on('close',() => {closed=true;});
        if (phase === 'body') {res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
      });
      t.after(async () => {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const entered = once(server,'request');
      let focusCalls=0;
      const ui=await dashboard(state(),async url=> {
        if(url==='/api/preparations/tab-focus') {
          if(++focusCalls===1)return timeout();
          return {opened:true,tabId:7};
        }
        return observed;
      });
      await view(ui).listeners.click();
      const original=ui.context.fetch;
      ui.context.AbortSignal=AbortSignal;
      let inspectionSignal;
      ui.context.fetch=(url,options)=> {
        if(url!=='/api/selector-diagnostics')return original(url,options);
        inspectionSignal=options.signal;
        return fetch(`http://127.0.0.1:${server.address().port}/`,options);
      };
      const started=performance.now();
      const recovery=refresh(ui).listeners.click();
      await entered;await new Promise(setImmediate);
      assert.equal(refresh(ui).disabled,true);
      assert.equal(view(ui,1).disabled,false);
      await recovery;
      assert.ok(performance.now()-started>=29900,'production HTTP deadline must actually elapse');
      assert.equal(inspectionSignal.aborted,true);
      assert.equal(refresh(ui).disabled,false);
      assert.equal(view(ui).disabled,true);
      if (!closed) await once(response,'close');
      assert.equal(closed,true,'aborted read closes the stalled response');
      ui.context.fetch=original;
      await refresh(ui).listeners.click();
      assert.equal(view(ui).disabled,false);
      await view(ui).listeners.click();
      assert.equal(focusCalls,2);
      assert.match(reason(ui),/탭 화면만 열었습니다/);
    });
  }
}
